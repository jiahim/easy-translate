export class OfficeTranslatorError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OfficeTranslatorError";
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

export class ProviderResponseError extends OfficeTranslatorError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderResponseError";
  }
}
