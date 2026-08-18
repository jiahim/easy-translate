import { access, readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { OfficeTranslatorError } from "./errors.js";
import type { OfficeTranslatorConfig } from "./types.js";

const DEFAULT_CONFIG_NAMES = [
  "office-translator.config.mjs",
  "office-translator.config.js",
  "office-translator.config.cjs",
  "office-translator.config.json",
];

export interface LoadedConfig {
  config: OfficeTranslatorConfig;
  path?: string;
  baseDirectory: string;
}

export function defineConfig(
  config: OfficeTranslatorConfig,
): OfficeTranslatorConfig {
  return config;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findDefaultConfig(
  workingDirectory: string,
): Promise<string | undefined> {
  for (const name of DEFAULT_CONFIG_NAMES) {
    const candidate = resolve(workingDirectory, name);
    if (await exists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function assertConfig(value: unknown, path: string): OfficeTranslatorConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OfficeTranslatorError(
      "Configuration must export an object: " + path,
    );
  }
  return value as OfficeTranslatorConfig;
}

export async function loadConfig(
  requestedPath?: string,
  workingDirectory = process.cwd(),
): Promise<LoadedConfig> {
  const path = requestedPath
    ? resolve(workingDirectory, requestedPath)
    : await findDefaultConfig(workingDirectory);
  if (!path) {
    return { config: {}, baseDirectory: workingDirectory };
  }
  if (!(await exists(path))) {
    throw new OfficeTranslatorError("Config file does not exist: " + path);
  }

  const extension = extname(path).toLowerCase();
  let value: unknown;
  if (extension === ".json") {
    try {
      value = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      throw new OfficeTranslatorError("Unable to parse config: " + path, {
        cause: error,
      });
    }
  } else if ([".js", ".mjs", ".cjs"].includes(extension)) {
    try {
      const imported = (await import(
        pathToFileURL(path).href + "?t=" + Date.now()
      )) as Record<string, unknown>;
      value = imported.default ?? imported.config;
    } catch (error) {
      throw new OfficeTranslatorError("Unable to load config: " + path, {
        cause: error,
      });
    }
  } else {
    throw new OfficeTranslatorError(
      "Config must be .json, .js, .mjs or .cjs: " + path,
    );
  }

  return {
    config: assertConfig(value, path),
    path,
    baseDirectory: dirname(path),
  };
}
