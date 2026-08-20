import type { TranslationProvider } from "./types.js";

/**
 * Identity helper that pins the context type of a provider literal, so
 * `request.items[n].context` is inferred instead of falling back to `unknown`.
 *
 * ```ts
 * const provider = defineProvider<{ kind: string }>({
 *   async translateBatch(request) {
 *     return request.items.map((item) => ({ id: item.id, text: item.context.kind }));
 *   },
 * });
 * ```
 */
export function defineProvider<TContext = unknown>(
  provider: TranslationProvider<TContext>,
): TranslationProvider<TContext> {
  return provider;
}

/**
 * A provider that echoes the source text back, optionally transformed. Meant
 * for documentation, tests and wiring checks, not for production use.
 *
 * ```ts
 * const provider = createEchoProvider((text) => "[zh] " + text);
 * ```
 */
export function createEchoProvider<TContext = unknown>(
  transform: (text: string) => string = (text) => text,
): TranslationProvider<TContext> {
  return {
    name: "echo",
    async translateBatch(request) {
      return request.items.map((item) => ({
        id: item.id,
        text: transform(item.text),
      }));
    },
  };
}
