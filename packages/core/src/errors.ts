export class TranslationCoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TranslationCoreError";
  }
}

export class TranslationPlanError extends TranslationCoreError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TranslationPlanError";
  }
}

export class TranslationResponseError extends TranslationCoreError {
  readonly reason: "quality" | "response";
  readonly retryInstruction?: string;

  constructor(
    message: string,
    options: ErrorOptions & {
      reason?: "quality" | "response";
      retryInstruction?: string;
    } = {},
  ) {
    super(message, options);
    this.name = "TranslationResponseError";
    this.reason = options.reason ?? "response";
    if (options.retryInstruction !== undefined) {
      this.retryInstruction = options.retryInstruction;
    }
  }
}

export type TranslationProviderErrorKind =
  | "authentication"
  | "invalid-request"
  | "network"
  | "rate-limit"
  | "server"
  | "timeout"
  | "unknown";

export class TranslationProviderError extends TranslationCoreError {
  readonly code?: string;
  readonly kind: TranslationProviderErrorKind;
  readonly retryAfterMs?: number;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(
    message: string,
    options: ErrorOptions & {
      code?: string;
      kind?: TranslationProviderErrorKind;
      retryAfterMs?: number;
      retryable?: boolean;
      status?: number;
    } = {},
  ) {
    super(message, options);
    this.name = "TranslationProviderError";
    this.kind = options.kind ?? "unknown";
    this.retryable = options.retryable ?? false;
    if (options.code !== undefined) this.code = options.code;
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
    if (options.status !== undefined) this.status = options.status;
  }
}
