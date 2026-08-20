/**
 * Stable, locale-free error codes. Select from this object instead of writing
 * protocol strings such as `"provider.timeout"` by hand.
 */
export const TranslationErrorCode = {
  ConfigTargetLanguageRequired: "config.target_language_required",
  ConfigInvalidIntegerOption: "config.invalid_integer_option",
  PlanUnsupportedSchema: "plan.unsupported_schema",
  PlanDocumentIdRequired: "plan.document_id_required",
  PlanDocumentFormatRequired: "plan.document_format_required",
  PlanUnitIdRequired: "plan.unit_id_required",
  PlanDuplicateUnitId: "plan.duplicate_unit_id",
  PlanDedupeTextMismatch: "plan.dedupe_text_mismatch",
  ResponseInvalidContainer: "response.invalid_container",
  ResponseInvalidItem: "response.invalid_item",
  ResponseUnexpectedId: "response.unexpected_id",
  ResponseDuplicateId: "response.duplicate_id",
  ResponseMissingId: "response.missing_id",
  ResponseQualityRejected: "response.quality_rejected",
  ProviderAuthentication: "provider.authentication",
  ProviderInvalidRequest: "provider.invalid_request",
  ProviderNetwork: "provider.network",
  ProviderRateLimit: "provider.rate_limit",
  ProviderServer: "provider.server",
  ProviderTimeout: "provider.timeout",
  ProviderUnknown: "provider.unknown",
} as const;

type ValueOf<T> = T[keyof T];

export type TranslationErrorCode = ValueOf<typeof TranslationErrorCode>;
export type TranslationConfigurationErrorCode = Extract<
  TranslationErrorCode,
  `config.${string}`
>;
export type TranslationPlanErrorCode = Extract<
  TranslationErrorCode,
  `plan.${string}`
>;
export type TranslationResponseErrorCode = Extract<
  TranslationErrorCode,
  `response.${string}`
>;
export type TranslationProviderErrorCode = Extract<
  TranslationErrorCode,
  `provider.${string}`
>;

export type TranslationErrorDetails = Readonly<Record<string, unknown>>;

export interface TranslationCoreErrorOptions extends ErrorOptions {
  /** Structured, locale-free context for logs and UI messages. */
  details?: TranslationErrorDetails | undefined;
}

/** Base class for every error raised by this package. */
export abstract class TranslationCoreError<
  TCode extends TranslationErrorCode = TranslationErrorCode,
> extends Error {
  readonly code: TCode;
  readonly details: TranslationErrorDetails;

  protected constructor(
    code: TCode,
    message: string,
    options: TranslationCoreErrorOptions = {},
  ) {
    super(message, options);
    this.name = "TranslationCoreError";
    this.code = code;
    this.details = Object.freeze({ ...options.details });
  }
}

/** Narrows an unknown error to the package's error hierarchy. */
export function isTranslationCoreError(
  error: unknown,
): error is TranslationCoreError<TranslationErrorCode> {
  return error instanceof TranslationCoreError;
}

/** Invalid engine options. Never retried. */
export class TranslationConfigurationError extends TranslationCoreError<
  TranslationConfigurationErrorCode
> {
  constructor(
    code: TranslationConfigurationErrorCode,
    message: string,
    options?: TranslationCoreErrorOptions,
  ) {
    super(code, message, options);
    this.name = "TranslationConfigurationError";
  }
}

/** Malformed `TranslationPlan`. Never retried. */
export class TranslationPlanError extends TranslationCoreError<
  TranslationPlanErrorCode
> {
  constructor(
    code: TranslationPlanErrorCode,
    message: string,
    options?: TranslationCoreErrorOptions,
  ) {
    super(code, message, options);
    this.name = "TranslationPlanError";
  }
}

export interface TranslationResponseErrorOptions
  extends TranslationCoreErrorOptions {
  /** Appended to the next attempt's instructions so the provider can correct itself. */
  retryInstruction?: string | undefined;
}

/**
 * The provider replied, but the response was malformed or rejected by the
 * quality policy. Retried by default.
 */

export class TranslationResponseError extends TranslationCoreError<
  TranslationResponseErrorCode
> {
  readonly reason: "quality" | "response";
  readonly retryInstruction?: string;

  constructor(
    code: TranslationResponseErrorCode,
    message: string,
    options: TranslationResponseErrorOptions = {},
  ) {
    super(code, message, options);
    this.name = "TranslationResponseError";
    this.reason =
      code === TranslationErrorCode.ResponseQualityRejected
        ? "quality"
        : "response";
    if (options.retryInstruction !== undefined) {
      this.retryInstruction = options.retryInstruction;
    }
  }
}

/**
 * Kebab-case counterpart of the `provider.*` codes, derived automatically.
 * `provider.rate_limit` maps to `"rate-limit"`, `provider.invalid_request` to
 * `"invalid-request"`, and so on. Branch on `error.code` for stable checks.
 */
export type TranslationProviderErrorKind =
  | "authentication"
  | "invalid-request"
  | "network"
  | "rate-limit"
  | "server"
  | "timeout"
  | "unknown";

const PROVIDER_KIND_BY_CODE = {
  [TranslationErrorCode.ProviderAuthentication]: "authentication",
  [TranslationErrorCode.ProviderInvalidRequest]: "invalid-request",
  [TranslationErrorCode.ProviderNetwork]: "network",
  [TranslationErrorCode.ProviderRateLimit]: "rate-limit",
  [TranslationErrorCode.ProviderServer]: "server",
  [TranslationErrorCode.ProviderTimeout]: "timeout",
  [TranslationErrorCode.ProviderUnknown]: "unknown",
} as const satisfies Record<
  TranslationProviderErrorCode,
  TranslationProviderErrorKind
>;

export interface TranslationProviderErrorOptions
  extends TranslationCoreErrorOptions {
  /** Raw upstream code. Never use it for cross-provider control flow. */
  providerCode?: string | undefined;
  /** Honored as a lower bound for the next backoff delay. */
  retryAfterMs?: number | undefined;
  /** Must be `true` for the default retry policy to retry. @defaultValue false */
  retryable?: boolean | undefined;
  status?: number | undefined;
}

/** Raised by provider implementations for transport and upstream failures. */
export class TranslationProviderError extends TranslationCoreError<
  TranslationProviderErrorCode
> {
  readonly kind: TranslationProviderErrorKind;
  readonly providerCode?: string;
  readonly retryAfterMs?: number;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(
    code: TranslationProviderErrorCode,
    message: string,
    options: TranslationProviderErrorOptions = {},
  ) {
    super(code, message, options);
    this.name = "TranslationProviderError";
    this.kind = PROVIDER_KIND_BY_CODE[code];
    this.retryable = options.retryable ?? false;
    if (options.providerCode !== undefined) {
      this.providerCode = options.providerCode;
    }
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
    if (options.status !== undefined) this.status = options.status;
  }
}
