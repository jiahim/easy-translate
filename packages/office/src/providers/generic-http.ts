import {
  type TranslationBatchRequest,
  type TranslationOutputItem,
  type TranslationProvider,
} from "@easy-translate/core";
import { createGenericHttpProvider } from "@easy-translate/providers";
import type { GenericHttpProviderConfig } from "../types.js";
import { resolveHeaders } from "./environment.js";
import { wrapOfficeProviderError } from "./wrap-error.js";

/** Node.js wrapper that expands env vars in headers and preserves Office error types. */
export class GenericHttpProvider implements TranslationProvider {
  readonly name = "generic-http";
  private readonly inner: TranslationProvider;

  constructor(config: GenericHttpProviderConfig) {
    this.inner = createGenericHttpProvider({
      url: config.url,
      method: config.method,
      extraBody: config.extraBody,
      responsePath: config.responsePath,
      timeoutMs: config.timeoutMs,
      headers: resolveHeaders(config.headers),
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
