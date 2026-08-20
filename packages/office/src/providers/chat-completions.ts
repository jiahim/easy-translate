import {
  type TranslationBatchRequest,
  type TranslationOutputItem,
  type TranslationProvider,
} from "@easy-translate/core";
import { createChatCompletionsProvider } from "@easy-translate/providers";
import { OfficeTranslatorError } from "../errors.js";
import type { ChatCompletionsProviderConfig } from "../types.js";
import { resolveHeaders } from "./environment.js";
import { wrapOfficeProviderError } from "./wrap-error.js";

function requireApiKey(name: string): string {
  const apiKey = process.env[name];
  if (!apiKey) {
    throw new OfficeTranslatorError(
      "Missing API key environment variable: " + name,
    );
  }
  return apiKey;
}

/** Node.js wrapper that reads `apiKeyEnv` and preserves Office error types. */
export class ChatCompletionsProvider implements TranslationProvider {
  readonly name = "chat-completions";
  private readonly inner: TranslationProvider;

  constructor(config: ChatCompletionsProviderConfig) {
    this.inner = createChatCompletionsProvider({
      name: "chat-completions",
      baseUrl: config.baseUrl,
      model: config.model,
      path: config.path,
      timeoutMs: config.timeoutMs,
      extraBody: config.extraBody,
      headers: resolveHeaders(config.headers),
      apiKey: config.apiKeyEnv ? requireApiKey(config.apiKeyEnv) : undefined,
    });
  }

  async translateBatch(
    request: TranslationBatchRequest,
    signal?: AbortSignal,
  ): Promise<TranslationOutputItem[]> {
    try {
      return await this.inner.translateBatch(request, signal);
    } catch (error) {
      throw wrapOfficeProviderError(error);
    }
  }
}
