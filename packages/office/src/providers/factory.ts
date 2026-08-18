import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { OfficeTranslatorError } from "../errors.js";
import type {
  ProviderConfig,
  TranslationProvider,
} from "../types.js";
import { ChatCompletionsProvider } from "./chat-completions.js";
import { GenericHttpProvider } from "./generic-http.js";

function isProvider(value: unknown): value is TranslationProvider {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as TranslationProvider).translateBatch === "function"
  );
}

function resolveModuleUrl(specifier: string, baseDirectory: string): string {
  if (specifier.startsWith("file:")) {
    return specifier;
  }
  if (
    isAbsolute(specifier) ||
    specifier.startsWith("./") ||
    specifier.startsWith("../")
  ) {
    return pathToFileURL(resolve(baseDirectory, specifier)).href;
  }
  const require = createRequire(resolve(baseDirectory, "package.json"));
  return pathToFileURL(require.resolve(specifier)).href;
}

async function loadModuleProvider(
  specifier: string,
  options: unknown,
  baseDirectory: string,
): Promise<TranslationProvider> {
  const imported = (await import(
    resolveModuleUrl(specifier, baseDirectory)
  )) as Record<string, unknown>;

  let candidate: unknown;
  if (typeof imported.createProvider === "function") {
    candidate = await (
      imported.createProvider as (options: unknown) => unknown
    )(options);
  } else if (typeof imported.default === "function") {
    candidate = await (
      imported.default as (options: unknown) => unknown
    )(options);
  } else {
    candidate = imported.default ?? imported.provider;
  }

  if (!isProvider(candidate)) {
    throw new OfficeTranslatorError(
      "Custom provider module must export createProvider(options), a default factory, or a provider object with translateBatch().",
    );
  }
  return candidate;
}

export async function createProviderFromConfig(
  config: ProviderConfig,
  baseDirectory = process.cwd(),
): Promise<TranslationProvider> {
  switch (config.type) {
    case "chat-completions":
      return new ChatCompletionsProvider(config);
    case "generic-http":
      return new GenericHttpProvider(config);
    case "module":
      return loadModuleProvider(
        config.module,
        config.options,
        baseDirectory,
      );
    default: {
      const exhaustive: never = config;
      throw new OfficeTranslatorError(
        "Unsupported provider type: " + JSON.stringify(exhaustive),
      );
    }
  }
}
