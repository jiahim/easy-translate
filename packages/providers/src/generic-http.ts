import {
  TranslationErrorCode,
  TranslationResponseError,
  type TranslationBatchRequest,
  type TranslationOutputItem,
  type TranslationProvider,
} from "@easy-translate/core";
import {
  providerEndpoint,
  providerHttpError,
  providerRequestError,
  providerRequestSignal,
  providerResponseText,
} from "./http.js";
import type { GenericHttpProviderOptions } from "./types.js";

function readPath(value: unknown, path: string): unknown {
  return path
    .split(".")
    .filter(Boolean)
    .reduce<unknown>((current, key) => {
      if (
        typeof current !== "object" ||
        current === null ||
        !(key in current)
      ) {
        return undefined;
      }
      return (current as Record<string, unknown>)[key];
    }, value);
}

function normalizeTranslations(
  value: unknown,
  request: TranslationBatchRequest,
): TranslationOutputItem[] {
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string")) {
      if (value.length !== request.items.length) {
        throw new TranslationResponseError(
          TranslationErrorCode.ResponseInvalidContainer,
          "The generic HTTP provider returned the wrong number of translations.",
        );
      }
      return value.map((text, index) => ({
        id: request.items[index]!.id,
        text,
      }));
    }
    if (
      value.every(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as Record<string, unknown>).id === "string" &&
          typeof (item as Record<string, unknown>).text === "string",
      )
    ) {
      return value as TranslationOutputItem[];
    }
  }

  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (request.items.every((item) => typeof record[item.id] === "string")) {
      return request.items.map((item) => ({
        id: item.id,
        text: record[item.id] as string,
      }));
    }
  }

  throw new TranslationResponseError(
    TranslationErrorCode.ResponseInvalidContainer,
    "The generic HTTP response must contain translations as strings, {id,text} objects, or an id-to-text object.",
  );
}

/** Provider for a custom translation HTTP API that returns JSON translations. */
export function createGenericHttpProvider(
  options: GenericHttpProviderOptions,
): TranslationProvider {
  return {
    name: "generic-http",
    async translateBatch(request, signal) {
      const endpoint = providerEndpoint(options.url, "url");
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...options.headers,
      };
      const body: Record<string, unknown> = {
        ...options.extraBody,
        targetLanguage: request.targetLanguage,
        items: request.items,
      };
      if (request.sourceLanguage) {
        body.sourceLanguage = request.sourceLanguage;
      }
      if (request.instructions) {
        body.instructions = request.instructions;
      }

      const requestSignal = providerRequestSignal(
        signal,
        options.timeoutMs ?? 60_000,
      );
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: options.method ?? "POST",
          headers,
          body: JSON.stringify(body),
          signal: requestSignal,
        });
      } catch (error) {
        throw providerRequestError(
          "Generic HTTP provider request failed.",
          error,
          signal,
          requestSignal,
        );
      }

      const raw = await providerResponseText(
        response,
        "Unable to read the generic HTTP provider response.",
        signal,
        requestSignal,
      );
      if (!response.ok) {
        throw providerHttpError(
          response,
          "Generic HTTP provider returned HTTP " + response.status + ".",
          raw,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        throw new TranslationResponseError(
          TranslationErrorCode.ResponseInvalidContainer,
          "Generic HTTP provider returned invalid JSON.",
          { cause: error },
        );
      }

      const translations = readPath(
        parsed,
        options.responsePath ?? "translations",
      );
      return normalizeTranslations(translations, request);
    },
  };
}
