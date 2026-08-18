import {
  TranslationConfigurationError,
  TranslationErrorCode,
  TranslationProviderError,
  TranslationResponseError,
} from "./errors.js";
import type {
  TranslationRetryEvent,
  TranslationRetryPolicy,
  TranslationRetryReason,
} from "./types.js";

export interface RetryRuntime {
  random: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}

export interface RetryOperationOptions extends TranslationRetryPolicy {
  runtime?: Partial<RetryRuntime>;
  signal?: AbortSignal;
  onRetry?: (event: TranslationRetryEvent) => Promise<void> | void;
}

const DEFAULT_RUNTIME: RetryRuntime = {
  random: Math.random,
  sleep: (milliseconds) =>
    new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds)),
};

function nonNegativeInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0) {
    throw new TranslationConfigurationError(
      TranslationErrorCode.ConfigInvalidIntegerOption,
      label + " must be a non-negative integer.",
      {
        details: {
          option: label,
          value: resolved,
          minimum: 0,
        },
      },
    );
  }
  return resolved;
}

function retryReason(error: unknown): TranslationRetryReason {
  if (error instanceof TranslationResponseError) {
    return error.reason;
  }
  return "provider";
}

function defaultShouldRetry(error: unknown): boolean {
  if (error instanceof TranslationProviderError) return error.retryable;
  return error instanceof TranslationResponseError;
}

function providerRetryAfter(error: unknown): number {
  return error instanceof TranslationProviderError
    ? (error.retryAfterMs ?? 0)
    : 0;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

async function waitForDelay(
  milliseconds: number,
  runtime: RetryRuntime,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);
  if (!signal) {
    await runtime.sleep(milliseconds);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = () =>
      finish(() =>
        reject(
          signal.reason ??
            new DOMException("The operation was aborted.", "AbortError"),
        ),
      );
    signal.addEventListener("abort", abort, { once: true });
    void runtime.sleep(milliseconds).then(
      () => finish(resolve),
      (error) => finish(() => reject(error)),
    );
  });
}

export async function retryOperation<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOperationOptions = {},
): Promise<T> {
  const maxRetries = nonNegativeInteger(options.maxRetries, 2, "maxRetries");
  const baseDelayMs = nonNegativeInteger(
    options.baseDelayMs,
    400,
    "baseDelayMs",
  );
  const maxDelayMs = nonNegativeInteger(
    options.maxDelayMs,
    4_000,
    "maxDelayMs",
  );
  const jitterMs = nonNegativeInteger(options.jitterMs, 0, "jitterMs");
  const runtime: RetryRuntime = { ...DEFAULT_RUNTIME, ...options.runtime };
  const shouldRetry = options.shouldRetry ?? defaultShouldRetry;

  for (let attempt = 0; ; attempt += 1) {
    throwIfAborted(options.signal);
    try {
      return await operation(attempt);
    } catch (error) {
      throwIfAborted(options.signal);
      if (attempt >= maxRetries || !shouldRetry(error, attempt)) throw error;

      const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const jitter = Math.floor(
        Math.min(Math.max(runtime.random(), 0), 1 - Number.EPSILON) *
          (jitterMs + 1),
      );
      const delayMs = Math.max(
        Math.min(maxDelayMs, exponential + jitter),
        providerRetryAfter(error),
      );
      const event: TranslationRetryEvent = {
        attempt: attempt + 1,
        delayMs,
        error,
        nextAttempt: attempt + 2,
        reason: retryReason(error),
      };
      await options.onRetry?.(event);
      await waitForDelay(delayMs, runtime, options.signal);
    }
  }
}
