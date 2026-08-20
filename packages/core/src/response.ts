import { TranslationErrorCode, TranslationResponseError } from "./errors.js";
import type {
  TranslationBatchRequest,
  TranslationOutputItem,
} from "./types.js";

/**
 * Appended to the next attempt's instructions when a provider returns output
 * the engine cannot use.
 */
export const RESPONSE_FORMAT_RETRY_INSTRUCTION =
  "RESPONSE FORMAT RETRY: Return every requested id exactly once with a non-empty translated text. Do not add commentary or omit items.";

function isOutputItem(value: unknown): value is TranslationOutputItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<TranslationOutputItem>;
  return typeof item.id === "string" && typeof item.text === "string";
}

/**
 * Validates a provider response against the items that were requested and
 * returns the translations keyed by unit id.
 *
 * `translatePlan` applies this to every batch, so providers only need it when
 * they parse a raw payload themselves and want the same guarantees. Every
 * failure is a `TranslationResponseError`, which the default retry policy
 * retries with {@link RESPONSE_FORMAT_RETRY_INSTRUCTION} attached.
 *
 * @throws {TranslationResponseError} The payload is not an array, contains a
 * malformed item, an unexpected or duplicated id, or omits a requested id.
 */
export function parseBatchOutput(
  request: TranslationBatchRequest<unknown>,
  raw: unknown,
): Map<string, string> {
  if (!Array.isArray(raw)) {
    throw new TranslationResponseError(
      TranslationErrorCode.ResponseInvalidContainer,
      "The provider must return an array of { id, text } objects.",
      { retryInstruction: RESPONSE_FORMAT_RETRY_INSTRUCTION },
    );
  }

  const expectedIds = new Set(request.items.map((item) => item.id));
  const translations = new Map<string, string>();

  for (const [outputIndex, item] of (raw as unknown[]).entries()) {
    if (!isOutputItem(item)) {
      throw new TranslationResponseError(
        TranslationErrorCode.ResponseInvalidItem,
        "The provider returned an invalid translation item.",
        {
          details: { outputIndex },
          retryInstruction: RESPONSE_FORMAT_RETRY_INSTRUCTION,
        },
      );
    }
    if (!expectedIds.has(item.id)) {
      throw new TranslationResponseError(
        TranslationErrorCode.ResponseUnexpectedId,
        "The provider returned an unexpected translation id: " + item.id,
        {
          details: { unitId: item.id },
          retryInstruction: RESPONSE_FORMAT_RETRY_INSTRUCTION,
        },
      );
    }
    if (translations.has(item.id)) {
      throw new TranslationResponseError(
        TranslationErrorCode.ResponseDuplicateId,
        "The provider returned a duplicate translation id: " + item.id,
        {
          details: { unitId: item.id },
          retryInstruction: RESPONSE_FORMAT_RETRY_INSTRUCTION,
        },
      );
    }
    translations.set(item.id, item.text);
  }

  for (const item of request.items) {
    const translatedText = translations.get(item.id);
    if (
      translatedText === undefined ||
      (!translatedText.trim() && item.text.trim())
    ) {
      throw new TranslationResponseError(
        TranslationErrorCode.ResponseMissingId,
        "The provider omitted translation id: " + item.id,
        {
          details: { unitId: item.id },
          retryInstruction: RESPONSE_FORMAT_RETRY_INSTRUCTION,
        },
      );
    }
  }

  return translations;
}
