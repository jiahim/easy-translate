import {
  parseBatchOutput,
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
import type { ChatCompletionsProviderOptions } from "./types.js";

function joinChatCompletionsUrl(baseUrl: string, path?: string): string {
  const root = baseUrl.replace(/\/+$/u, "");
  const suffix = (path ?? "chat/completions").replace(/^\/+/u, "");
  return suffix ? root + "/" + suffix : root;
}

const DEFAULT_SYSTEM_PROMPT = [
  "You are a translation engine.",
  "Translate every natural-language phrase in the item text, including mixed-language text, and never copy source-language prose unchanged.",
  "Preserve placeholders, URLs, identifiers, acronyms, model names, standards, numbers, versions, whitespace intent, and XML-safe plain text.",
  "Keep compact metadata compact; when a source date is numeric, preserve a concise numeric date format instead of spelling out month names.",
  "Do not add explanations.",
  'Return strict JSON: {"translations":[{"id":"same id","text":"translated text"}]}.',
  "Return every id exactly once.",
].join(" ");

function responseContent(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) {
    throw new TranslationResponseError(
      TranslationErrorCode.ResponseInvalidContainer,
      "Chat-completions provider returned an invalid response.",
    );
  }
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || !choices.length) {
    throw new TranslationResponseError(
      TranslationErrorCode.ResponseInvalidContainer,
      "Chat-completions provider response has no choices.",
    );
  }
  const message = (choices[0] as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) {
    throw new TranslationResponseError(
      TranslationErrorCode.ResponseInvalidContainer,
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
  throw new TranslationResponseError(
    TranslationErrorCode.ResponseInvalidContainer,
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
    throw new TranslationResponseError(
      TranslationErrorCode.ResponseInvalidContainer,
      "Chat-completions provider did not return valid JSON.",
      { cause: error },
    );
  }
  const translations =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>).translations
      : undefined;
  if (!Array.isArray(translations)) {
    throw new TranslationResponseError(
      TranslationErrorCode.ResponseInvalidContainer,
      'Chat-completions JSON must be {"translations":[{"id":"...","text":"..."}]}.',
    );
  }
  return translations as TranslationOutputItem[];
}

/**
 * OpenAI-compatible Chat Completions provider. Vendor factories wrap this with
 * a default `baseUrl` and model.
 */
export function createChatCompletionsProvider(
  options: ChatCompletionsProviderOptions,
): TranslationProvider {
  return {
    name: options.name ?? "chat-completions",
    async translateBatch(request: TranslationBatchRequest, signal?: AbortSignal) {
      const endpoint = providerEndpoint(
        joinChatCompletionsUrl(options.baseUrl, options.path),
        "baseUrl",
      );
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...options.headers,
      };
      if (options.apiKey) {
        headers.authorization = "Bearer " + options.apiKey;
      }

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
        ...options.extraBody,
        model: options.model,
        messages: [
          { role: "system", content: DEFAULT_SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(user) },
        ],
      };

      const requestSignal = providerRequestSignal(
        signal,
        options.timeoutMs ?? 90_000,
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
        throw new TranslationResponseError(
          TranslationErrorCode.ResponseInvalidContainer,
          "Chat-completions provider returned invalid JSON.",
          { cause: error },
        );
      }

      const translations = parseJsonContent(responseContent(payload));
      parseBatchOutput(request, translations);
      return translations;
    },
  };
}
