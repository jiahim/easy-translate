import { ProviderResponseError } from "../errors.js";
import type {
  GenericHttpProviderConfig,
  TranslationBatchRequest,
  TranslationOutputItem,
  TranslationProvider,
} from "../types.js";
import { resolveHeaders } from "./environment.js";
import {
  providerHttpError,
  providerEndpoint,
  providerRequestError,
  providerRequestSignal,
  providerResponseText,
} from "./http.js";

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
        throw new ProviderResponseError(
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
    if (
      request.items.every((item) => typeof record[item.id] === "string")
    ) {
      return request.items.map((item) => ({
        id: item.id,
        text: record[item.id] as string,
      }));
    }
  }

  throw new ProviderResponseError(
    "The generic HTTP response must contain translations as strings, {id,text} objects, or an id-to-text object.",
  );
}

export class GenericHttpProvider implements TranslationProvider {
  readonly name = "generic-http";

  constructor(private readonly config: GenericHttpProviderConfig) {}

  async translateBatch(
    request: TranslationBatchRequest,
    signal?: AbortSignal,
  ): Promise<TranslationOutputItem[]> {
    const headers = {
      "content-type": "application/json",
      ...resolveHeaders(this.config.headers),
    };
    const body: Record<string, unknown> = {
      ...this.config.extraBody,
      targetLanguage: request.targetLanguage,
      items: request.items,
    };
    if (request.sourceLanguage) {
      body.sourceLanguage = request.sourceLanguage;
    }
    if (request.instructions) {
      body.instructions = request.instructions;
    }

    const endpoint = providerEndpoint(this.config.url, "url");
    const requestSignal = providerRequestSignal(
      signal,
      this.config.timeoutMs ?? 60_000,
    );
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: this.config.method ?? "POST",
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
      throw new ProviderResponseError(
        "Generic HTTP provider returned invalid JSON.",
        { cause: error },
      );
    }

    const translations = readPath(
      parsed,
      this.config.responsePath ?? "translations",
    );
    return normalizeTranslations(translations, request);
  }
}
