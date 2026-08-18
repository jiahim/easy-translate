import {
  TranslationErrorCode,
  TranslationResponseError,
  type TranslationResponseErrorCode,
  type TranslationResponseErrorOptions,
} from "@easy-translate/core";

const officeTranslatorErrorBrand = Symbol("OfficeTranslatorError");

function brandAsOfficeTranslatorError(error: object): void {
  Object.defineProperty(error, officeTranslatorErrorBrand, { value: true });
}

export class OfficeTranslatorError extends Error {
  static [Symbol.hasInstance](value: unknown): boolean {
    const defaultMatch = Function.prototype[Symbol.hasInstance].call(
      this,
      value,
    ) as boolean;
    if (this !== OfficeTranslatorError) return defaultMatch;
    return (
      defaultMatch ||
      (typeof value === "object" &&
        value !== null &&
        officeTranslatorErrorBrand in value)
    );
  }

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OfficeTranslatorError";
    brandAsOfficeTranslatorError(this);
  }
}

export class UnsupportedOfficeFormatError extends OfficeTranslatorError {
  constructor(fileName?: string) {
    super(
      fileName
        ? "Unsupported Office format: " + fileName +
            ". Use an OOXML file such as .docx, .pptx or .xlsx."
        : "Unable to detect a supported OOXML Office format.",
    );
    this.name = "UnsupportedOfficeFormatError";
  }
}

export class ProviderResponseError extends TranslationResponseError {
  constructor(
    message: string,
    options: TranslationResponseErrorOptions & {
      code?: TranslationResponseErrorCode;
    } = {},
  ) {
    const {
      code = TranslationErrorCode.ResponseInvalidContainer,
      ...errorOptions
    } = options;
    super(code, message, errorOptions);
    this.name = "ProviderResponseError";
    // Preserve the public pre-typed-error `instanceof OfficeTranslatorError`
    // contract while also participating in core response-error retries.
    brandAsOfficeTranslatorError(this);
  }
}
