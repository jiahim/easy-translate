import {
  OfficeTranslationError,
  ProviderTimeoutError,
  translationSystemPrompt,
  type TranslationBatchRequest,
  type TranslationActivity,
  type TranslationOutputItem,
  type TranslationProvider,
} from "./office.js";

export interface ChatProviderSettings {
  baseUrl: string;
  path?: string;
  model: string;
  apiKey?: string;
  extraHeaders?: Record<string, string>;
  fastMode?: boolean;
  requestTimeoutMs?: number;
}

export interface GenericProviderSettings {
  url: string;
  apiKey?: string;
  headers?: Record<string, string>;
  responsePath?: string;
  requestTimeoutMs?: number;
}

const MAX_TRANSIENT_RETRIES = 3;

function retryAfterMilliseconds(response: Response): number {
  const value = response.headers.get("retry-after")?.trim();
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(60_000, Math.round(seconds * 1_000));
    }
    const date = Date.parse(value);
    if (Number.isFinite(date)) {
      return Math.min(60_000, Math.max(0, date - Date.now()));
    }
  }
  return response.status === 429 ? 10_000 : 5_000;
}

async function responseErrorCode(response: Response): Promise<string> {
  try {
    const payload = (await response.clone().json()) as Record<string, unknown>;
    return typeof payload.code === "string" ? payload.code : "";
  } catch {
    return "";
  }
}

function waitForRetry(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("翻译已取消", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(finish, milliseconds);
    function finish() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      globalThis.clearTimeout(timer);
      reject(new DOMException("翻译已取消", "AbortError"));
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function fetchWithFirstByteTimeout(
  input: string,
  init: RequestInit,
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) {
    forwardAbort();
  } else {
    externalSignal?.addEventListener("abort", forwardAbort, { once: true });
  }
  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) {
      throw new ProviderTimeoutError(
        `大模型服务在 ${Math.max(1, Math.round(timeoutMs / 1_000))} 秒内没有开始响应。请换用更快的模型或稍后重试。`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timer);
    externalSignal?.removeEventListener("abort", forwardAbort);
  }
}

async function fetchWithTransientRetry(
  input: string,
  init: RequestInit,
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
  onActivity?: (activity: TranslationActivity) => void,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetchWithFirstByteTimeout(
      input,
      init,
      externalSignal,
      timeoutMs,
    );
    const retryableStatus = response.status === 429 || response.status === 503;
    const errorCode = retryableStatus
      ? await responseErrorCode(response)
      : "";
    const quotaIsExhausted = errorCode === "daily_quota_exceeded";
    if (
      !retryableStatus ||
      quotaIsExhausted ||
      attempt >= MAX_TRANSIENT_RETRIES
    ) {
      return response;
    }

    const retryAfterMs = retryAfterMilliseconds(response);
    await response.body?.cancel().catch(() => undefined);
    onActivity?.({
      phase: "retry",
      receivedCharacters: 0,
      retryAfterMs,
      attempt: attempt + 1,
      retryReason: "busy",
    });
    await waitForRetry(retryAfterMs, externalSignal);
  }
}

function parseJson(content: string, message: string): unknown {
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new OfficeTranslationError(message, { cause: error });
  }
}

function readPath(value: unknown, path: string): unknown {
  return path
    .split(".")
    .filter(Boolean)
    .reduce<unknown>((current, key) => {
      if (
        typeof current !== "object" ||
        current === null ||
        !(key in current)
      ) {
        return undefined;
      }
      return (current as Record<string, unknown>)[key];
    }, value);
}

function normalize(
  value: unknown,
  request: TranslationBatchRequest,
): TranslationOutputItem[] {
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string")) {
      if (value.length !== request.items.length) {
        throw new OfficeTranslationError("大模型服务返回的文本数量不正确。");
      }
      return value.map((text, index) => ({
        id: request.items[index]!.id,
        text,
      }));
    }
    if (
      value.every(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as Record<string, unknown>).id === "string" &&
          typeof (item as Record<string, unknown>).text === "string",
      )
    ) {
      return value as TranslationOutputItem[];
    }
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (request.items.every((item) => typeof record[item.id] === "string")) {
      return request.items.map((item) => ({
        id: item.id,
        text: record[item.id] as string,
      }));
    }
  }
  throw new OfficeTranslationError(
    "大模型服务响应应包含字符串数组、{id,text} 数组或 id 到文本的对象。",
  );
}

function parseModelTranslations(
  modelContent: string,
  request: TranslationBatchRequest,
): TranslationOutputItem[] {
  const content = modelContent
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
  const candidates = [content];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const candidate = content.slice(start, index + 1);
        if (candidate !== content) candidates.push(candidate);
        start = -1;
      }
    }
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const translations =
        typeof parsed === "object" && parsed !== null
          ? (parsed as Record<string, unknown>).translations
          : undefined;
      if (translations !== undefined) return normalize(translations, request);
    } catch {
      // Try a complete JSON object embedded in a short model explanation.
    }
  }
  throw new OfficeTranslationError("模型没有返回规定的 JSON 结果。");
}

function chatContent(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) {
    throw new OfficeTranslationError("兼容聊天接口返回了无效响应。");
  }
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || !choices.length) {
    throw new OfficeTranslationError("兼容聊天接口没有返回候选结果。");
  }
  const message = (choices[0] as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) {
    throw new OfficeTranslationError("兼容聊天接口没有返回消息内容。");
  }
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as Record<string, unknown>).text === "string"
          ? String((item as Record<string, unknown>).text)
          : "",
      )
      .join("");
  }
  throw new OfficeTranslationError("兼容聊天接口返回了不支持的内容类型。");
}

function chatDelta(payload: unknown): {
  content: string;
  activityCharacters: number;
} {
  if (typeof payload !== "object" || payload === null) {
    return { content: "", activityCharacters: 0 };
  }
  const error = (payload as Record<string, unknown>).error;
  if (typeof error === "object" && error !== null) {
    const message = (error as Record<string, unknown>).message;
    throw new OfficeTranslationError(
      typeof message === "string" ? message : "大模型服务返回了流式错误。",
    );
  }
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || !choices.length) {
    return { content: "", activityCharacters: 0 };
  }
  const delta = (choices[0] as Record<string, unknown>).delta;
  if (typeof delta !== "object" || delta === null) {
    return { content: "", activityCharacters: 0 };
  }
  const content = (delta as Record<string, unknown>).content;
  const reasoning = (delta as Record<string, unknown>).reasoning_content;
  const contentText = typeof content === "string" ? content : "";
  return {
    content: contentText,
    activityCharacters:
      contentText.length + (typeof reasoning === "string" ? reasoning.length : 0),
  };
}

async function readChatEventStream(
  response: Response,
  onActivity?: (activity: TranslationActivity) => void,
): Promise<string> {
  if (!response.body) {
    throw new OfficeTranslationError("浏览器无法读取大模型服务的流式响应。");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let receivedCharacters = 0;

  const processLine = (line: string): boolean => {
    if (!line.startsWith("data:")) return false;
    const data = line.slice(5).trim();
    if (!data) return false;
    if (data === "[DONE]") return true;
    const delta = chatDelta(
      parseJson(data, "兼容聊天接口返回了无效的流式数据。"),
    );
    content += delta.content;
    receivedCharacters += delta.activityCharacters;
    onActivity?.({ phase: "stream", receivedCharacters });
    return false;
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop() ?? "";
    let finished = false;
    for (const line of lines) {
      if (processLine(line)) finished = true;
    }
    if (finished || done) break;
  }
  if (buffer) processLine(buffer);
  return content;
}

async function readGenericEventStream(
  response: Response,
  onActivity?: (activity: TranslationActivity) => void,
): Promise<unknown> {
  if (!response.body) {
    throw new OfficeTranslationError("浏览器无法读取翻译接口的流式响应。");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines: string[] = [];
  let result: unknown;
  let resultReceived = false;

  const dispatch = (): void => {
    if (!dataLines.length) {
      eventName = "message";
      return;
    }
    const payload = parseJson(
      dataLines.join("\n"),
      "翻译接口返回了无效的流式数据。",
    );
    const record =
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>)
        : {};
    if (eventName === "activity") {
      const phase = record.phase;
      const receivedCharacters = record.receivedCharacters;
      if (
        (phase === "response" || phase === "stream" || phase === "retry") &&
        typeof receivedCharacters === "number"
      ) {
        const retryReason = record.retryReason;
        onActivity?.({
          phase,
          receivedCharacters,
          ...(typeof record.retryAfterMs === "number"
            ? { retryAfterMs: record.retryAfterMs }
            : {}),
          ...(typeof record.attempt === "number"
            ? { attempt: record.attempt }
            : {}),
          ...(retryReason === "busy" ||
          retryReason === "format" ||
          retryReason === "request"
            ? { retryReason }
            : {}),
        });
      }
    } else if (eventName === "result") {
      result = payload;
      resultReceived = true;
    } else if (eventName === "error") {
      const message =
        typeof record.error === "string"
          ? record.error
          : "翻译接口返回了流式错误。";
      const requestId =
        typeof record.requestId === "string"
          ? record.requestId
          : response.headers.get("x-request-id") ?? "";
      const fullMessage =
        message + (requestId ? `（请求 ID：${requestId}）` : "");
      if (record.code === "upstream_timeout") {
        throw new ProviderTimeoutError(fullMessage);
      }
      throw new OfficeTranslationError(fullMessage);
    }
    eventName = "message";
    dataLines = [];
  };

  const processLine = (line: string): void => {
    if (!line) {
      dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim() || "message";
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop() ?? "";
    for (const line of lines) processLine(line);
    if (resultReceived) {
      await reader.cancel().catch(() => undefined);
      return result;
    }
    if (done) break;
  }
  if (buffer) processLine(buffer);
  dispatch();
  if (resultReceived) return result;
  throw new OfficeTranslationError("翻译接口的流式响应在返回结果前结束。");
}

function assertResponse(response: Response, content: string): void {
  if (!response.ok) {
    let serviceMessage = content.slice(0, 240);
    let requestId = response.headers.get("x-request-id") ?? "";
    try {
      const payload = JSON.parse(content) as Record<string, unknown>;
      if (typeof payload.error === "string") serviceMessage = payload.error;
      if (typeof payload.requestId === "string") requestId = payload.requestId;
    } catch {
      // Keep the truncated plain-text response.
    }
    throw new OfficeTranslationError(
      "大模型服务返回 HTTP " +
        response.status +
        (serviceMessage ? "：" + serviceMessage : "") +
        (requestId ? `（请求 ID：${requestId}）` : ""),
    );
  }
}

function supportsThinkingSwitch(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "siliconflow.cn" || host.endsWith(".siliconflow.cn");
  } catch {
    return false;
  }
}

export class BrowserChatProvider implements TranslationProvider {
  readonly name = "chat-completions";

  constructor(private readonly settings: ChatProviderSettings) {}

  async translateBatch(
    request: TranslationBatchRequest,
    signal?: AbortSignal,
    onActivity?: (activity: TranslationActivity) => void,
  ): Promise<TranslationOutputItem[]> {
    const endpoint =
      this.settings.baseUrl.replace(/\/+$/u, "") +
      "/" +
      (this.settings.path ?? "chat/completions").replace(/^\/+/u, "");
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...this.settings.extraHeaders,
    };
    if (this.settings.apiKey) {
      headers.authorization = "Bearer " + this.settings.apiKey;
    }
    const system = translationSystemPrompt();
    const fastMode = this.settings.fastMode !== false;
    const disableThinking =
      fastMode && supportsThinkingSwitch(this.settings.baseUrl);
    const response = await fetchWithTransientRetry(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.settings.model,
        stream: fastMode,
        ...(fastMode ? { max_tokens: 3_072 } : {}),
        ...(disableThinking ? { enable_thinking: false } : {}),
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: JSON.stringify({
              sourceLanguage: request.sourceLanguage ?? "auto",
              targetLanguage: request.targetLanguage,
              instructions: request.instructions ?? "",
              items: request.items,
            }),
          },
        ],
      }),
    }, signal, this.settings.requestTimeoutMs ?? 30_000, onActivity);
    if (!response.ok) {
      const errorContent = await response.text();
      assertResponse(response, errorContent);
    }
    const isEventStream =
      response.headers.get("content-type")?.includes("text/event-stream") ??
      false;
    let modelContent: string;
    if (fastMode && isEventStream) {
      modelContent = await readChatEventStream(response, onActivity);
    } else {
      const raw = await response.text();
      onActivity?.({ phase: "response", receivedCharacters: raw.length });
      const payload = parseJson(raw, "兼容聊天接口返回的不是有效 JSON。");
      modelContent = chatContent(payload);
    }
    return parseModelTranslations(modelContent, request);
  }
}

function resolvedHeaders(
  headers: Record<string, string> | undefined,
  apiKey: string | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).map(([name, value]) => [
      name,
      value.replaceAll("{{API_KEY}}", apiKey ?? ""),
    ]),
  );
}

export class BrowserGenericProvider implements TranslationProvider {
  readonly name = "generic-http";

  constructor(private readonly settings: GenericProviderSettings) {}

  async translateBatch(
    request: TranslationBatchRequest,
    signal?: AbortSignal,
    onActivity?: (activity: TranslationActivity) => void,
  ): Promise<TranslationOutputItem[]> {
    const response = await fetchWithTransientRetry(this.settings.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...resolvedHeaders(this.settings.headers, this.settings.apiKey),
      },
      body: JSON.stringify(request),
    }, signal, this.settings.requestTimeoutMs ?? 30_000, onActivity);
    const isEventStream =
      response.headers.get("content-type")?.includes("text/event-stream") ??
      false;
    if (response.ok && isEventStream) {
      const payload = await readGenericEventStream(response, onActivity);
      return normalize(
        readPath(payload, this.settings.responsePath ?? "translations"),
        request,
      );
    }
    const raw = await response.text();
    onActivity?.({ phase: "response", receivedCharacters: raw.length });
    assertResponse(response, raw);
    const payload = parseJson(raw, "通用 HTTP 接口返回的不是有效 JSON。");
    return normalize(
      readPath(payload, this.settings.responsePath ?? "translations"),
      request,
    );
  }
}

export function parseHeaders(value: string): Record<string, string> {
  if (!value.trim()) return {};
  const parsed = parseJson(value, "自定义请求头必须是有效的 JSON 对象。");
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !Object.values(parsed).every((item) => typeof item === "string")
  ) {
    throw new OfficeTranslationError("自定义请求头必须是字符串键值对。");
  }
  return parsed as Record<string, string>;
}
