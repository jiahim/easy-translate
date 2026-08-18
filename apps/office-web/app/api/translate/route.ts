import {
  TRIAL_MAX_REQUEST_BYTES,
  TrialRequestError,
  parseTrialTranslationContent,
  parseTrialTranslations,
  validateTrialRequest,
} from "@/lib/trial-contract";
import {
  acquireTrialQuota,
  verifyTrialSession,
} from "@/lib/trial-server";
import { translationSystemPrompt } from "@/lib/office";

export const runtime = "nodejs";
export const maxDuration = 120;

type TrialStage = "session" | "request" | "quota" | "upstream" | "response";
type StreamActivityPhase = "response" | "stream";

const encoder = new TextEncoder();

function jsonResponseHeaders(requestId?: string): HeadersInit {
  return {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    ...(requestId ? { "x-request-id": requestId } : {}),
  };
}

function streamResponseHeaders(requestId: string): HeadersInit {
  return {
    "cache-control": "no-store, no-transform",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
    "x-request-id": requestId,
  };
}

function errorDetails(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { value: String(error) };
  return {
    name: error.name,
    message: error.message,
    ...(error.cause instanceof Error
      ? { causeName: error.cause.name, causeMessage: error.cause.message }
      : {}),
  };
}

function knownTrialError(error: unknown): TrialRequestError {
  return error instanceof TrialRequestError
    ? error
    : new TrialRequestError(
        "免费翻译服务暂时不可用，请稍后重试。",
        500,
        "internal_error",
      );
}

function upstreamHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "invalid-upstream-url";
  }
}

function upstreamErrorMetadata(body: string): Record<string, unknown> {
  try {
    const payload = JSON.parse(body) as Record<string, unknown>;
    const error = payload.error;
    if (typeof error !== "object" || error === null) return {};
    const record = error as Record<string, unknown>;
    return {
      ...(typeof record.code === "string" ? { upstreamCode: record.code } : {}),
      ...(typeof record.type === "string" ? { upstreamType: record.type } : {}),
    };
  } catch {
    return {};
  }
}

function errorResponse(error: unknown, requestId: string): Response {
  const known = knownTrialError(error);
  const headers = new Headers(jsonResponseHeaders(requestId));
  if (known.status === 429) headers.set("retry-after", "30");
  return Response.json(
    { error: known.message, code: known.code, requestId },
    { status: known.status, headers },
  );
}

function upstreamConfiguration(): {
  apiKey: string;
  baseUrl: string;
  model: string;
} {
  const apiKey = process.env.SILICONFLOW_API_KEY;
  const model = process.env.SILICONFLOW_MODEL;
  const baseUrl = (
    process.env.SILICONFLOW_BASE_URL ?? "https://api.siliconflow.cn/v1"
  ).replace(/\/+$/u, "");
  if (!apiKey || !model) {
    throw new TrialRequestError(
      "免费翻译模型尚未完成配置。",
      503,
      "model_not_configured",
    );
  }
  return { apiKey, baseUrl, model };
}

function upstreamFirstByteTimeoutMs(): number {
  const configured = Number(process.env.SILICONFLOW_TIMEOUT_MS ?? "30000");
  return Number.isInteger(configured) && configured >= 10_000 && configured <= 110_000
    ? configured
    : 30_000;
}

async function readRequestJson(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > TRIAL_MAX_REQUEST_BYTES) {
    throw new TrialRequestError("翻译请求过大。", 413, "request_too_large");
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > TRIAL_MAX_REQUEST_BYTES) {
    throw new TrialRequestError("翻译请求过大。", 413, "request_too_large");
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new TrialRequestError("翻译请求不是有效 JSON。");
  }
}

function chatStreamDelta(payload: unknown): {
  content: string;
  activityCharacters: number;
} {
  if (typeof payload !== "object" || payload === null) {
    return { content: "", activityCharacters: 0 };
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.error === "object" && record.error !== null) {
    throw new TrialRequestError(
      "免费翻译模型返回了流式错误。",
      502,
      "upstream_response",
    );
  }
  const choices = record.choices;
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

async function readUpstreamEventStream(
  response: Response,
  onActivity: (phase: StreamActivityPhase, receivedCharacters: number) => void,
): Promise<string> {
  if (!response.body) {
    throw new TrialRequestError(
      "无法读取免费翻译模型的流式响应。",
      502,
      "upstream_response",
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
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch (error) {
      throw new TrialRequestError(
        "免费翻译模型返回了无效的流式数据。",
        502,
        "upstream_response",
        { cause: error },
      );
    }
    const delta = chatStreamDelta(payload);
    content += delta.content;
    receivedCharacters += delta.activityCharacters;
    if (delta.activityCharacters) onActivity("stream", receivedCharacters);
    return false;
  };

  let finished = false;
  while (!finished) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (processLine(line)) finished = true;
    }
    if (done) break;
  }
  if (buffer && !finished) processLine(buffer);
  return content;
}

async function upstreamError(
  response: Response,
  metadata: {
    requestId: string;
    model: string;
    baseUrl: string;
    upstreamStartedAt: number;
    firstByteTimeoutMs: number;
    itemCount: number;
    inputCharacters: number;
    requestBytes: number;
    maxTokens: number;
    disableThinking: boolean;
  },
): Promise<never> {
  const responseBody = await response.text().catch(() => "");
  console.error("[trial.translate] upstream returned an error", {
    requestId: metadata.requestId,
    model: metadata.model,
    upstreamHost: upstreamHost(metadata.baseUrl),
    durationMs: Date.now() - metadata.upstreamStartedAt,
    firstByteTimeoutMs: metadata.firstByteTimeoutMs,
    itemCount: metadata.itemCount,
    inputCharacters: metadata.inputCharacters,
    requestBytes: metadata.requestBytes,
    maxTokens: metadata.maxTokens,
    disableThinking: metadata.disableThinking,
    upstreamStatus: response.status,
    upstreamRequestId:
      response.headers.get("x-request-id") ??
      response.headers.get("request-id") ??
      undefined,
    responseBytes: encoder.encode(responseBody).byteLength,
    ...upstreamErrorMetadata(responseBody),
  });
  if (response.status === 429 || response.status === 503 || response.status === 504) {
    throw new TrialRequestError(
      "免费翻译模型当前繁忙，请稍后重试。",
      503,
      "upstream_busy",
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new TrialRequestError(
      "免费翻译模型的服务端凭据无效，请联系站点管理员。",
      503,
      "upstream_authentication",
    );
  }
  throw new TrialRequestError(
    "免费翻译模型返回了错误，请稍后重试。",
    502,
    "upstream_error",
  );
}

async function requestSiliconFlow(
  request: ReturnType<typeof validateTrialRequest>,
  requestId: string,
  externalSignal: AbortSignal,
  onActivity: (phase: StreamActivityPhase, receivedCharacters: number) => void,
  formatRetry = false,
): Promise<unknown> {
  const { apiKey, baseUrl, model } = upstreamConfiguration();
  const configuredMaxTokens = Number(
    process.env.SILICONFLOW_MAX_TOKENS ?? "3072",
  );
  const maxTokens =
    Number.isInteger(configuredMaxTokens) &&
    configuredMaxTokens >= 128 &&
    configuredMaxTokens <= 32_768
      ? configuredMaxTokens
      : 3_072;
  const disableThinking = process.env.SILICONFLOW_DISABLE_THINKING !== "false";
  const firstByteTimeoutMs = upstreamFirstByteTimeoutMs();
  const inputCharacters = request.items.reduce(
    (total, item) => total + item.text.length,
    0,
  );
  const requestBody = JSON.stringify({
    model,
    stream: true,
    max_tokens: maxTokens,
    ...(disableThinking ? { enable_thinking: false } : {}),
    ...(process.env.SILICONFLOW_JSON_MODE === "true"
      ? { response_format: { type: "json_object" } }
      : {}),
    messages: [
      {
        role: "system",
        content: [
          translationSystemPrompt(),
          formatRetry
            ? "Your previous response could not be parsed. Return exactly one JSON object matching the required schema. Start with { and end with }. Do not add Markdown, commentary or any text outside the JSON object."
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      },
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
  });
  const requestBytes = encoder.encode(requestBody).byteLength;
  const upstreamStartedAt = Date.now();
  const controller = new AbortController();
  let firstByteTimedOut = false;
  const forwardAbort = () => controller.abort(externalSignal.reason);
  if (externalSignal.aborted) forwardAbort();
  else externalSignal.addEventListener("abort", forwardAbort, { once: true });
  const firstByteTimer = globalThis.setTimeout(() => {
    firstByteTimedOut = true;
    controller.abort();
  }, firstByteTimeoutMs);

  try {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: requestBody,
        signal: controller.signal,
      });
    } finally {
      // Match the browser's own-key provider: this timer only covers waiting
      // for response headers. Streaming generation is not a total-time limit.
      globalThis.clearTimeout(firstByteTimer);
    }
    if (!response.ok) {
      return await upstreamError(response, {
        requestId,
        model,
        baseUrl,
        upstreamStartedAt,
        firstByteTimeoutMs,
        itemCount: request.items.length,
        inputCharacters,
        requestBytes,
        maxTokens,
        disableThinking,
      });
    }
    onActivity("response", 0);
    const isEventStream =
      response.headers.get("content-type")?.includes("text/event-stream") ?? false;
    if (isEventStream) {
      const content = await readUpstreamEventStream(response, onActivity);
      return { streamedContent: content };
    }
    try {
      return await response.json();
    } catch (error) {
      throw new TrialRequestError(
        "免费翻译模型返回了无效响应。",
        502,
        "upstream_response",
        { cause: error },
      );
    }
  } catch (error) {
    if (error instanceof TrialRequestError) throw error;
    if (externalSignal.aborted && !firstByteTimedOut) throw error;
    console.error("[trial.translate] upstream request failed", {
      requestId,
      model,
      upstreamHost: upstreamHost(baseUrl),
      durationMs: Date.now() - upstreamStartedAt,
      firstByteTimeoutMs,
      itemCount: request.items.length,
      inputCharacters,
      requestBytes,
      maxTokens,
      disableThinking,
      firstByteTimedOut,
      ...errorDetails(error),
    });
    throw new TrialRequestError(
      firstByteTimedOut
        ? `免费翻译模型在 ${Math.max(1, Math.round(firstByteTimeoutMs / 1_000))} 秒内没有开始响应，请稍后重试。`
        : "无法连接免费翻译模型，请稍后重试。",
      firstByteTimedOut ? 504 : 502,
      firstByteTimedOut ? "upstream_timeout" : "upstream_network_error",
      { cause: error },
    );
  } finally {
    globalThis.clearTimeout(firstByteTimer);
    externalSignal.removeEventListener("abort", forwardAbort);
  }
}

function encodeEvent(event: string, value: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}

function trialEventStream(
  request: Request,
  input: ReturnType<typeof validateTrialRequest>,
  requestId: string,
  startedAt: number,
  lease: Awaited<ReturnType<typeof acquireTrialQuota>>,
): ReadableStream<Uint8Array> {
  const streamAbort = new AbortController();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const enqueue = (value: Uint8Array): boolean => {
        if (closed || streamAbort.signal.aborted) return false;
        try {
          controller.enqueue(value);
          return true;
        } catch {
          return false;
        }
      };
      enqueue(encoder.encode(": connected\n\n"));
      const heartbeat = globalThis.setInterval(() => {
        enqueue(encoder.encode(": heartbeat\n\n"));
      }, 15_000);

      void (async () => {
        let stage: TrialStage = "upstream";
        try {
          let translations: ReturnType<typeof parseTrialTranslationContent>;
          for (let attempt = 0; ; attempt += 1) {
            try {
              const payload = await requestSiliconFlow(
                input,
                requestId,
                streamAbort.signal,
                (phase, receivedCharacters) => {
                  enqueue(
                    encodeEvent("activity", { phase, receivedCharacters }),
                  );
                },
                attempt > 0,
              );
              stage = "response";
              translations =
                typeof payload === "object" &&
                payload !== null &&
                typeof (payload as Record<string, unknown>).streamedContent === "string"
                  ? parseTrialTranslationContent(
                      (payload as Record<string, unknown>).streamedContent as string,
                      input,
                    )
                  : parseTrialTranslations(payload, input);
              break;
            } catch (error) {
              const retryInvalidFormat =
                attempt === 0 &&
                error instanceof TrialRequestError &&
                error.code === "upstream_response" &&
                !streamAbort.signal.aborted &&
                !request.signal.aborted;
              if (!retryInvalidFormat) throw error;
              stage = "upstream";
              enqueue(
                encodeEvent("activity", {
                  phase: "retry",
                  receivedCharacters: 0,
                  retryAfterMs: 0,
                  attempt: 1,
                  retryReason: "format",
                }),
              );
            }
          }
          enqueue(encodeEvent("result", { translations, requestId }));
        } catch (error) {
          if (!streamAbort.signal.aborted && !request.signal.aborted) {
            const known = knownTrialError(error);
            console.error("[trial.translate] request failed", {
              requestId,
              stage,
              durationMs: Date.now() - startedAt,
              status: known.status,
              code: known.code,
              ...errorDetails(error),
            });
            enqueue(
              encodeEvent("error", {
                error: known.message,
                code: known.code,
                status: known.status,
                requestId,
              }),
            );
          }
        } finally {
          globalThis.clearInterval(heartbeat);
          await lease.release();
          closed = true;
          try {
            controller.close();
          } catch {
            // The browser may already have cancelled the stream.
          }
        }
      })();
    },
    cancel(reason) {
      streamAbort.abort(reason);
    },
  });
}

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  let stage: TrialStage = "session";
  try {
    const session = await verifyTrialSession(
      request,
      request.headers.get("x-trial-session"),
    );
    stage = "request";
    const input = validateTrialRequest(await readRequestJson(request));
    stage = "quota";
    const lease = await acquireTrialQuota(
      session.ipHash,
      session.sessionHash,
      input,
    );
    const body = trialEventStream(request, input, requestId, startedAt, lease);
    return new Response(body, {
      status: 200,
      headers: streamResponseHeaders(requestId),
    });
  } catch (error) {
    const known = knownTrialError(error);
    console.error("[trial.translate] request failed", {
      requestId,
      stage,
      durationMs: Date.now() - startedAt,
      status: known.status,
      code: known.code,
      ...errorDetails(error),
    });
    return errorResponse(error, requestId);
  }
}
