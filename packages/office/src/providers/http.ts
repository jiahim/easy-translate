import { TranslationProviderError } from "@easy-translate/core";

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

export function providerRequestError(
  message: string,
  error: unknown,
  signal?: AbortSignal,
): TranslationProviderError | unknown {
  if (signal?.aborted) return signal.reason ?? error;
  const timedOut =
    error instanceof DOMException && error.name === "TimeoutError";
  return new TranslationProviderError(message, {
    cause: error,
    kind: timedOut ? "timeout" : "network",
    retryable: true,
  });
}

export function providerHttpError(
  response: Response,
  message: string,
): TranslationProviderError {
  const status = response.status;
  const retryable =
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status >= 500;
  const kind =
    status === 401 || status === 403
      ? "authentication"
      : status === 429
        ? "rate-limit"
        : status === 408
          ? "timeout"
          : status >= 500
            ? "server"
            : "invalid-request";
  const retryAfterMs = retryAfterMilliseconds(response);
  return new TranslationProviderError(message, {
    kind,
    retryable,
    status,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}
