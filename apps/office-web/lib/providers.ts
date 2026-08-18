import {
  isTranslationCoreError,
  TranslationErrorCode,
  TranslationProviderError,
  TranslationResponseError,
  type TranslationProviderErrorCode,
} from "@easy-translate/core";
import {
  OfficeTranslationError,
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

interface ProviderFailureMetadata {
  providerCode?: string;
  requestId?: string;
  retryAfterMs?: number;
  status?: number;
}

function retryAfterMilliseconds(response: Response): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.ceil(seconds * 1_000);
    }
    const date = Date.parse(value);
    if (Number.isFinite(date)) {
      return Math.max(0, date - Date.now());
    }
  }
  return undefined;
}

function browserEndpoint(value: string): string {
  const baseUrl =
    typeof document === "undefined"
      ? "https://easy-translate.invalid/"
      : document.baseURI;
  try {
    if (!value.trim()) throw new TypeError("Provider URL is empty.");
    const endpoint = new URL(value, baseUrl);
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
      throw new TypeError("Unsupported provider URL protocol.");
    }
    return /^[a-z][a-z\d+.-]*:/iu.test(value) ? endpoint.href : value;
  } catch (cause) {
    throw new TranslationProviderError(
      TranslationErrorCode.ProviderInvalidRequest,
      "Provider endpoint is not a valid HTTP URL.",
      { cause, retryable: false },
    );
  }
}

function normalizedProviderCode(
  metadata: ProviderFailureMetadata,
): TranslationProviderErrorCode {
  const status = metadata.status;
  if (status === 401 || status === 403) {
    return TranslationErrorCode.ProviderAuthentication;
  }
  if (status === 408 || status === 504) {
    return TranslationErrorCode.ProviderTimeout;
  }
  if (status === 429) return TranslationErrorCode.ProviderRateLimit;
  if (status !== undefined && status >= 500) {
    return TranslationErrorCode.ProviderServer;
  }
  if (status !== undefined && status >= 400) {
    return TranslationErrorCode.ProviderInvalidRequest;
  }
  if (status !== undefined) return TranslationErrorCode.ProviderUnknown;
  if (metadata.providerCode === "upstream_timeout") {
    return TranslationErrorCode.ProviderTimeout;
  }
  if (metadata.providerCode === "upstream_network_error") {
    return TranslationErrorCode.ProviderNetwork;
  }
  return TranslationErrorCode.ProviderUnknown;
}

function normalizedProviderError(
  metadata: ProviderFailureMetadata,
  cause?: unknown,
): TranslationProviderError {
  const code = normalizedProviderCode(metadata);
  const neverRetry =
    metadata.providerCode === "daily_quota_exceeded" ||
    metadata.providerCode === "model_not_configured";
  const retryable =
    !neverRetry &&
    (code === TranslationErrorCode.ProviderNetwork ||
      code === TranslationErrorCode.ProviderRateLimit ||
      code === TranslationErrorCode.ProviderServer ||
      code === TranslationErrorCode.ProviderTimeout);
  return new TranslationProviderError(
    code,
    metadata.status === undefined
      ? "Provider request failed."
      : `Provider request failed with HTTP ${metadata.status}.`,
    {
      ...(cause === undefined ? {} : { cause }),
      retryable,
      ...(metadata.status === undefined ? {} : { status: metadata.status }),
      ...(metadata.providerCode === undefined
        ? {}
        : { providerCode: metadata.providerCode }),
      ...(metadata.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: metadata.retryAfterMs }),
      ...(metadata.requestId === undefined
        ? {}
        : { details: { requestId: metadata.requestId } }),
    },
  );
}

function responseFailureMetadata(
  response: Response,
  content: string,
): ProviderFailureMetadata {
  let providerCode: string | undefined;
  let requestId = response.headers.get("x-request-id")?.trim() || undefined;
  try {
    const payload = JSON.parse(content) as Record<string, unknown>;
    const nestedError =
      typeof payload.error === "object" && payload.error !== null
        ? (payload.error as Record<string, unknown>)
        : undefined;
    const rawCode = payload.code ?? nestedError?.code;
    const rawRequestId = payload.requestId ?? nestedError?.requestId;
    if (typeof rawCode === "string" && rawCode) providerCode = rawCode;
    if (typeof rawRequestId === "string" && rawRequestId) {
      requestId = rawRequestId;
    }
  } catch {
    // Raw provider content is deliberately excluded from normalized errors.
  }
  const retryAfterMs = retryAfterMilliseconds(response);
  return {
    status: response.status,
    ...(providerCode ? { providerCode } : {}),
    ...(requestId ? { requestId } : {}),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

async function fetchProviderResponse(
  input: string,
  init: RequestInit,
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Response> {
  const endpoint = browserEndpoint(input);
  const controller = new AbortController();
  let timedOut = false;
  const requestSignal = externalSignal
    ? AbortSignal.any([externalSignal, controller.signal])
    : controller.signal;
  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(endpoint, { ...init, signal: requestSignal });
  } catch (error) {
    if (externalSignal?.aborted) {
      throw externalSignal.reason ?? error;
    }
    if (timedOut) {
      throw new TranslationProviderError(
        TranslationErrorCode.ProviderTimeout,
        "Provider did not start responding before the request timeout.",
        {
          cause: error,
          retryable: true,
          details: { timeoutMs },
        },
      );
    }
    throw new TranslationProviderError(
      TranslationErrorCode.ProviderNetwork,
      "Unable to connect to the provider.",
      { cause: error, retryable: true },
    );
  } finally {
    globalThis.clearTimeout(timer);
  }
}

async function providerResponseText(
  response: Response,
  signal?: AbortSignal,
): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    throw new TranslationProviderError(
      TranslationErrorCode.ProviderNetwork,
      "Unable to read the provider response.",
      { cause: error, retryable: true },
    );
  }
}

const PROVIDER_RESPONSE_RETRY_INSTRUCTION = [
  "RESPONSE FORMAT RETRY: Return a complete translation result in the requested JSON shape.",
  "Return every requested id exactly once and do not add explanatory text.",
].join(" ");

function providerResponseError(
  code:
    | typeof TranslationErrorCode.ResponseInvalidContainer
    | typeof TranslationErrorCode.ResponseInvalidItem
    | typeof TranslationErrorCode.ResponseMissingId,
  message: string,
  details?: Readonly<Record<string, unknown>>,
  cause?: unknown,
): TranslationResponseError {
  return new TranslationResponseError(code, message, {
    ...(cause === undefined ? {} : { cause }),
    ...(details === undefined ? {} : { details }),
    retryInstruction: PROVIDER_RESPONSE_RETRY_INSTRUCTION,
  });
}

function parseJson(content: string, message: string): unknown {
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new OfficeTranslationError(message, { cause: error });
  }
}

function parseProviderJson(content: string, message: string): unknown {
  try {
    return JSON.parse(content);
  } catch (cause) {
    throw providerResponseError(
      TranslationErrorCode.ResponseInvalidContainer,
      message,
      undefined,
      cause,
    );
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
        throw providerResponseError(
          TranslationErrorCode.ResponseMissingId,
          "Provider returned the wrong number of translations.",
          {
            actualCount: value.length,
            expectedCount: request.items.length,
          },
        );
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
  throw providerResponseError(
    TranslationErrorCode.ResponseInvalidContainer,
    "Provider response does not contain a supported translation collection.",
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
  throw providerResponseError(
    TranslationErrorCode.ResponseInvalidContainer,
    "Model did not return the required translation JSON.",
  );
}

function chatContent(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) {
    throw providerResponseError(
      TranslationErrorCode.ResponseInvalidContainer,
      "Chat provider returned an invalid response.",
    );
  }
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || !choices.length) {
    throw providerResponseError(
      TranslationErrorCode.ResponseInvalidContainer,
      "Chat provider response has no choices.",
    );
  }
  const message = (choices[0] as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) {
    throw providerResponseError(
      TranslationErrorCode.ResponseInvalidItem,
      "Chat provider response has no message.",
    );
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
  throw providerResponseError(
    TranslationErrorCode.ResponseInvalidItem,
    "Chat provider returned an unsupported content type.",
  );
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
    const record = error as Record<string, unknown>;
    throw normalizedProviderError({
      status: 502,
      ...(typeof record.code === "string"
        ? { providerCode: record.code }
        : {}),
      ...(typeof record.requestId === "string"
        ? { requestId: record.requestId }
        : {}),
    });
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

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  try {
    return await reader.read();
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    if (isTranslationCoreError(error)) throw error;
    throw new TranslationProviderError(
      TranslationErrorCode.ProviderNetwork,
      "Unable to read the provider response stream.",
      { cause: error, retryable: true },
    );
  }
}

async function readChatEventStream(
  response: Response,
  onActivity?: (activity: TranslationActivity) => void,
  signal?: AbortSignal,
): Promise<string> {
  if (!response.body) {
    throw new TranslationProviderError(
      TranslationErrorCode.ProviderNetwork,
      "Provider response stream is unavailable.",
      { retryable: true },
    );
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
      parseProviderJson(data, "Chat provider returned invalid stream data."),
    );
    content += delta.content;
    receivedCharacters += delta.activityCharacters;
    onActivity?.({ phase: "stream", receivedCharacters });
    return false;
  };

  let streamClosed = false;
  try {
    while (true) {
      const { value, done } = await readStreamChunk(reader, signal);
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? "";
      let finished = false;
      for (const line of lines) {
        if (processLine(line)) finished = true;
      }
      if (finished) {
        await reader.cancel().catch(() => undefined);
        streamClosed = true;
        break;
      }
      if (done) {
        streamClosed = true;
        break;
      }
    }
    if (buffer) processLine(buffer);
    return content;
  } finally {
    if (!streamClosed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function readGenericEventStream(
  response: Response,
  onActivity?: (activity: TranslationActivity) => void,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!response.body) {
    throw new TranslationProviderError(
      TranslationErrorCode.ProviderNetwork,
      "Provider response stream is unavailable.",
      { retryable: true },
    );
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
    const payload = parseProviderJson(
      dataLines.join("\n"),
      "Provider returned invalid stream data.",
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
      const requestId =
        typeof record.requestId === "string"
          ? record.requestId
          : response.headers.get("x-request-id") ?? "";
      throw normalizedProviderError({
        ...(typeof record.status === "number"
          ? { status: record.status }
          : {}),
        ...(typeof record.code === "string"
          ? { providerCode: record.code }
          : {}),
        ...(requestId ? { requestId } : {}),
        ...(typeof record.retryAfterMs === "number"
          ? { retryAfterMs: record.retryAfterMs }
          : {}),
      });
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

  let streamClosed = false;
  try {
    while (true) {
      const { value, done } = await readStreamChunk(reader, signal);
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? "";
      for (const line of lines) processLine(line);
      if (resultReceived) {
        await reader.cancel().catch(() => undefined);
        streamClosed = true;
        return result;
      }
      if (done) {
        streamClosed = true;
        break;
      }
    }
    if (buffer) processLine(buffer);
    dispatch();
    if (resultReceived) return result;
    throw providerResponseError(
      TranslationErrorCode.ResponseInvalidContainer,
      "Provider response stream ended before returning a result.",
    );
  } finally {
    if (!streamClosed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function assertResponse(response: Response, content: string): void {
  if (!response.ok) {
    throw normalizedProviderError(responseFailureMetadata(response, content));
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
    const response = await fetchProviderResponse(
      endpoint,
      {
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
      },
      signal,
      this.settings.requestTimeoutMs ?? 30_000,
    );
    if (!response.ok) {
      const errorContent = await providerResponseText(response, signal);
      assertResponse(response, errorContent);
    }
    const isEventStream =
      response.headers.get("content-type")?.includes("text/event-stream") ??
      false;
    let modelContent: string;
    if (fastMode && isEventStream) {
      modelContent = await readChatEventStream(response, onActivity, signal);
    } else {
      const raw = await providerResponseText(response, signal);
      onActivity?.({ phase: "response", receivedCharacters: raw.length });
      const payload = parseProviderJson(
        raw,
        "Chat provider returned invalid JSON.",
      );
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
    const response = await fetchProviderResponse(
      this.settings.url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...resolvedHeaders(this.settings.headers, this.settings.apiKey),
        },
        body: JSON.stringify(request),
      },
      signal,
      this.settings.requestTimeoutMs ?? 30_000,
    );
    const isEventStream =
      response.headers.get("content-type")?.includes("text/event-stream") ??
      false;
    if (response.ok && isEventStream) {
      const payload = await readGenericEventStream(
        response,
        onActivity,
        signal,
      );
      return normalize(
        readPath(payload, this.settings.responsePath ?? "translations"),
        request,
      );
    }
    const raw = await providerResponseText(response, signal);
    onActivity?.({ phase: "response", receivedCharacters: raw.length });
    assertResponse(response, raw);
    const payload = parseProviderJson(
      raw,
      "Generic HTTP provider returned invalid JSON.",
    );
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
