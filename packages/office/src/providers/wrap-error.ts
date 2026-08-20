import { TranslationResponseError } from "@easy-translate/core";
import { ProviderResponseError } from "../errors.js";

/** Keep `instanceof ProviderResponseError` / `OfficeTranslatorError` for CLI users. */
export function wrapOfficeProviderError(error: unknown): unknown {
  if (error instanceof ProviderResponseError) return error;
  if (error instanceof TranslationResponseError) {
    return new ProviderResponseError(error.message, {
      code: error.code,
      cause: error,
      details: error.details,
      retryInstruction: error.retryInstruction,
    });
  }
  return error;
}
