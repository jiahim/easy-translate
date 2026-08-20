import {
  TranslationErrorCode,
  TranslationProviderError,
} from "@easy-translate/core";

interface ProviderErrorMetadata {
  providerCode?: string;
  requestId?: string;
}

function retryAfterMilliseconds(response: Response): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export function providerRequestSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function providerEndpoint(value: string, field: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch (cause) {
    throw new TranslationProviderError(
      TranslationErrorCode.ProviderInvalidRequest,
      "Provider endpoint is not a valid URL.",
      {
        cause,
        retryable: false,
        details: { field },
      },
    );
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new TranslationProviderError(
      TranslationErrorCode.ProviderInvalidRequest,
      "Provider endpoint must use HTTP or HTTPS.",
      {
        retryable: false,
        details: { field },
      },
    );
  }
  return endpoint.href;
}

export function providerRequestError(
  message: string,
  error: unknown,
  externalSignal?: AbortSignal,
  requestSignal?: AbortSignal,
): TranslationProviderError | unknown {
  if (externalSignal?.aborted) return externalSignal.reason ?? error;
  const failure = requestSignal?.aborted
    ? (requestSignal.reason ?? error)
    : error;
  const timedOut =
    failure instanceof DOMException && failure.name === "TimeoutError";
  return new TranslationProviderError(
    timedOut
      ? TranslationErrorCode.ProviderTimeout
      : TranslationErrorCode.ProviderNetwork,
    message,
    {
      cause: failure,
      retryable: true,
    },
  );
}

export async function providerResponseText(
  response: Response,
  message: string,
  externalSignal?: AbortSignal,
  requestSignal?: AbortSignal,
): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    throw providerRequestError(
      message,
      error,
      externalSignal,
      requestSignal,
    );
  }
}

function providerErrorMetadata(
  response: Response,
  body: string,
): ProviderErrorMetadata {
  let providerCode: string | undefined;
  let requestId = response.headers.get("x-request-id")?.trim() || undefined;
  try {
    const payload = JSON.parse(body) as Record<string, unknown>;
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
    // The response body is intentionally excluded from normalized errors.
  }
  return {
    ...(providerCode ? { providerCode } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

export function providerHttpError(
  response: Response,
  message: string,
  body = "",
): TranslationProviderError {
  const status = response.status;
  const metadata = providerErrorMetadata(response, body);
  const retryableStatus =
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status >= 500;
  const retryable =
    retryableStatus && metadata.providerCode !== "daily_quota_exceeded";
  const code =
    status === 401 || status === 403
      ? TranslationErrorCode.ProviderAuthentication
      : status === 429
        ? TranslationErrorCode.ProviderRateLimit
        : status === 408 || status === 504
          ? TranslationErrorCode.ProviderTimeout
          : status >= 500
            ? TranslationErrorCode.ProviderServer
            : TranslationErrorCode.ProviderInvalidRequest;
  const retryAfterMs = retryAfterMilliseconds(response);
  return new TranslationProviderError(code, message, {
    retryable,
    status,
    ...(metadata.providerCode === undefined
      ? {}
      : { providerCode: metadata.providerCode }),
    ...(metadata.requestId === undefined
      ? {}
      : { details: { requestId: metadata.requestId } }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}
