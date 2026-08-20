import {
  TranslationErrorCode,
  TranslationProviderError,
  type TranslationProvider,
} from "@easy-translate/core";
import { createChatCompletionsProvider } from "./chat-completions.js";
import { createGenericHttpProvider } from "./generic-http.js";
import type {
  ChatCompletionsProviderOptions,
  GenericHttpProviderOptions,
} from "./types.js";

export type ProviderProtocol = "openai-chat-completions" | "generic-http";

export type CustomChatCompletionsProviderOptions = Omit<
  ChatCompletionsProviderOptions,
  "baseUrl"
> & {
  /**
   * OpenAI-compatible Chat Completions. This is the default.
   * `baseUrl` is the API root (for example `https://api.example.com/v1`).
   */
  protocol?: "openai-chat-completions" | undefined;
  /** API root. Required unless `url` is the full Chat Completions endpoint. */
  baseUrl?: string | undefined;
  /** Full request URL. When set, `path` is not appended. */
  url?: string | undefined;
};

export interface CustomGenericHttpProviderOptions
  extends GenericHttpProviderOptions {
  protocol: "generic-http";
}

export type CustomProviderOptions =
  | CustomChatCompletionsProviderOptions
  | CustomGenericHttpProviderOptions;

/**
 * Configure a provider that is not in the built-in vendor list.
 * Pass the endpoint, protocol, model and API key yourself.
 */
export function createCustomProvider(
  options: CustomProviderOptions,
): TranslationProvider {
  if (options.protocol === "generic-http") {
    return createGenericHttpProvider(options);
  }

  if (!options.model?.trim()) {
    throw new TranslationProviderError(
      TranslationErrorCode.ProviderInvalidRequest,
      "Custom Chat Completions provider requires a model id.",
      { retryable: false, details: { field: "model" } },
    );
  }

  const fullUrl = options.url?.trim();
  const baseUrl = options.baseUrl?.trim();
  if (fullUrl) {
    return createChatCompletionsProvider({
      name: options.name ?? "custom",
      apiKey: options.apiKey,
      baseUrl: fullUrl,
      path: "",
      model: options.model,
      timeoutMs: options.timeoutMs,
      extraBody: options.extraBody,
      headers: options.headers,
    });
  }
  if (!baseUrl) {
    throw new TranslationProviderError(
      TranslationErrorCode.ProviderInvalidRequest,
      "Custom Chat Completions provider requires baseUrl or url.",
      { retryable: false, details: { field: "baseUrl" } },
    );
  }
  return createChatCompletionsProvider({
    name: options.name ?? "custom",
    apiKey: options.apiKey,
    baseUrl,
    model: options.model,
    path: options.path,
    timeoutMs: options.timeoutMs,
    extraBody: options.extraBody,
    headers: options.headers,
  });
}
