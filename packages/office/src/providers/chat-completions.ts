import { OfficeTranslatorError, ProviderResponseError } from "../errors.js";
import type {
  ChatCompletionsProviderConfig,
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

function responseContent(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) {
    throw new ProviderResponseError(
      "Chat-completions provider returned an invalid response.",
    );
  }
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || !choices.length) {
    throw new ProviderResponseError(
      "Chat-completions provider response has no choices.",
    );
  }
  const message = (choices[0] as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) {
    throw new ProviderResponseError(
      "Chat-completions provider response has no message.",
    );
  }
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "object" && item !== null) {
          const text = (item as Record<string, unknown>).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .join("");
  }
  throw new ProviderResponseError(
    "Chat-completions provider returned unsupported message content.",
  );
}

function parseJsonContent(content: string): TranslationOutputItem[] {
  const unfenced = content
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch (error) {
    throw new ProviderResponseError(
      "Chat-completions provider did not return valid JSON.",
      { cause: error },
    );
  }
  const translations =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>).translations
      : undefined;
  if (
    !Array.isArray(translations) ||
    !translations.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as Record<string, unknown>).id === "string" &&
        typeof (item as Record<string, unknown>).text === "string",
    )
  ) {
    throw new ProviderResponseError(
      'Chat-completions JSON must be {"translations":[{"id":"...","text":"..."}]}.',
    );
  }
  return translations as TranslationOutputItem[];
}

export class ChatCompletionsProvider implements TranslationProvider {
  readonly name = "chat-completions";

  constructor(private readonly config: ChatCompletionsProviderConfig) {}

  async translateBatch(
    request: TranslationBatchRequest,
    signal?: AbortSignal,
  ): Promise<TranslationOutputItem[]> {
    const endpoint = providerEndpoint(
      this.config.baseUrl.replace(/\/+$/u, "") +
        "/" +
        (this.config.path ?? "chat/completions").replace(/^\/+/u, ""),
      "baseUrl",
    );
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...resolveHeaders(this.config.headers),
    };
    if (this.config.apiKeyEnv) {
      const apiKey = process.env[this.config.apiKeyEnv];
      if (!apiKey) {
        throw new OfficeTranslatorError(
          "Missing API key environment variable: " +
            this.config.apiKeyEnv,
        );
      }
      headers.authorization = "Bearer " + apiKey;
    }

    const system = [
      "You are a translation engine for Office documents.",
      "Translate every natural-language phrase in the item text, including mixed-language text, and never copy source-language prose unchanged.",
      "Preserve placeholders, URLs, identifiers, acronyms, model names, standards, numbers, versions, whitespace intent, and XML-safe plain text.",
      "Keep compact metadata compact; when a source date is numeric, preserve a concise numeric date format instead of spelling out month names.",
      "Do not add explanations.",
      'Return strict JSON: {"translations":[{"id":"same id","text":"translated text"}]}.',
      "Return every id exactly once.",
    ].join(" ");
    const user = {
      sourceLanguage: request.sourceLanguage ?? "auto",
      targetLanguage: request.targetLanguage,
      instructions: request.instructions ?? "",
      items: request.items.map(({ id, text, context }) => ({
        id,
        text,
        context,
      })),
    };
    const body = {
      ...this.config.extraBody,
      model: this.config.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(user) },
      ],
    };

    const requestSignal = providerRequestSignal(
      signal,
      this.config.timeoutMs ?? 90_000,
    );
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: requestSignal,
      });
    } catch (error) {
      throw providerRequestError(
        "Chat-completions provider request failed.",
        error,
        signal,
        requestSignal,
      );
    }

    const raw = await providerResponseText(
      response,
      "Unable to read the chat-completions provider response.",
      signal,
      requestSignal,
    );
    if (!response.ok) {
      throw providerHttpError(
        response,
        "Chat-completions provider returned HTTP " + response.status + ".",
        raw,
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      throw new ProviderResponseError(
        "Chat-completions provider returned invalid JSON.",
        { cause: error },
      );
    }
    return parseJsonContent(responseContent(payload));
  }
}
