export interface ChatCompletionsProviderOptions {
  /** Sent as `Authorization: Bearer` when provided. */
  apiKey?: string | undefined;
  /**
   * API root, for example `https://api.example.com/v1`.
   * Do not include `/chat/completions` unless `path` is `""`.
   */
  baseUrl: string;
  model: string;
  /** @defaultValue `"chat-completions"` */
  name?: string | undefined;
  /**
   * Path appended to `baseUrl`.
   * @defaultValue `"chat/completions"`
   */
  path?: string | undefined;
  /** @defaultValue 90000 */
  timeoutMs?: number | undefined;
  extraBody?: Record<string, unknown> | undefined;
  headers?: Record<string, string> | undefined;
}

export interface GenericHttpProviderOptions {
  url: string;
  /** @defaultValue `"POST"` */
  method?: "POST" | "PUT" | undefined;
  extraBody?: Record<string, unknown> | undefined;
  /** Dot path to the translations payload. @defaultValue `"translations"` */
  responsePath?: string | undefined;
  /** @defaultValue 60000 */
  timeoutMs?: number | undefined;
  headers?: Record<string, string> | undefined;
}

export interface VendorProviderOptions {
  apiKey: string;
  model?: string | undefined;
  timeoutMs?: number | undefined;
  extraBody?: Record<string, unknown> | undefined;
  headers?: Record<string, string> | undefined;
}

export interface RequiredModelProviderOptions extends VendorProviderOptions {
  model: string;
}
