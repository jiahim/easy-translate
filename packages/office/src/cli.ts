#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { Command, Option } from "commander";
import { loadConfig } from "./config.js";
import { OfficeTranslatorError } from "./errors.js";
import { createProviderFromConfig } from "./providers/factory.js";
import {
  inspectOfficeBuffer,
  translateOfficeFile,
} from "./translator.js";
import type {
  OfficeScopeOptions,
  OfficeTranslatorConfig,
  RunDistribution,
  TranslateOfficeFileOptions,
} from "./types.js";

interface CliOptions {
  output?: string;
  config?: string;
  providerModule?: string;
  providerOptions?: string;
  to?: string;
  from?: string;
  instructions?: string;
  batchSize?: number;
  maxBatchCharacters?: number;
  concurrency?: number;
  retries?: number;
  runDistribution?: RunDistribution;
  includeNotes?: boolean;
  includeMasters?: boolean;
  excludeComments?: boolean;
  excludeHeadersFooters?: boolean;
  excludeCharts?: boolean;
  excludeDiagrams?: boolean;
  dryRun?: boolean;
  json?: boolean;
  overwrite?: boolean;
}

function defaultOutput(input: string, targetLanguage: string): string {
  const extension = extname(input);
  const stem = basename(input, extension);
  const safeLanguage = targetLanguage.replace(
    /[^\p{L}\p{N}._-]+/gu,
    "-",
  );
  return join(dirname(input), stem + "." + safeLanguage + extension);
}

function numberOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error("Expected an integer, received: " + value);
  }
  return parsed;
}

function mergedScope(
  config: OfficeTranslatorConfig,
  cli: CliOptions,
): OfficeScopeOptions {
  const scope: OfficeScopeOptions = { ...config.scope };
  if (cli.includeNotes) {
    scope.includeNotes = true;
  }
  if (cli.includeMasters) {
    scope.includeMasters = true;
  }
  if (cli.excludeComments) {
    scope.includeComments = false;
  }
  if (cli.excludeHeadersFooters) {
    scope.includeHeadersAndFooters = false;
  }
  if (cli.excludeCharts) {
    scope.includeCharts = false;
  }
  if (cli.excludeDiagrams) {
    scope.includeDiagrams = false;
  }
  return scope;
}

function customProviderOptions(value: string | undefined): unknown {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new OfficeTranslatorError(
      "--provider-options must be valid JSON.",
      { cause: error },
    );
  }
}

function print(value: unknown, json: boolean | undefined): void {
  if (json) {
    process.stdout.write(JSON.stringify(value, null, 2) + "\n");
    return;
  }
  const record = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(record)) {
    process.stdout.write(key + ": " + String(item) + "\n");
  }
}

const program = new Command()
  .name("office-translate")
  .description(
    "Translate OOXML Word, PowerPoint and Excel files without rebuilding their formatting.",
  )
  .argument("<input>", "input Office file")
  .option("-o, --output <path>", "output file path")
  .option("-c, --config <path>", "config file (.mjs, .js, .cjs or .json)")
  .option(
    "--provider-module <path>",
    "custom provider module; overrides provider in config",
  )
  .option(
    "--provider-options <json>",
    "JSON options passed to the custom provider module",
  )
  .option("-t, --to <language>", "target language; can also be set in config")
  .option("-s, --from <language>", "source language; defaults to auto")
  .option("--instructions <text>", "extra translation instructions")
  .option("--batch-size <number>", "maximum segments per request", numberOption)
  .option(
    "--max-batch-characters <number>",
    "maximum source characters per request",
    numberOption,
  )
  .option("--concurrency <number>", "parallel provider requests", numberOption)
  .option("--retries <number>", "retries after provider errors", numberOption)
  .addOption(
    new Option(
      "--run-distribution <mode>",
      "how translated text is distributed across styled runs",
    ).choices(["style-aware", "proportional", "first"]),
  )
  .option("--include-notes", "translate PowerPoint speaker notes")
  .option("--include-masters", "translate PowerPoint masters and layouts")
  .option("--exclude-comments", "do not translate comments")
  .option(
    "--exclude-headers-footers",
    "do not translate Word headers and footers",
  )
  .option("--exclude-charts", "do not translate chart text")
  .option("--exclude-diagrams", "do not translate diagram and drawing text")
  .option("--dry-run", "inspect translatable segments without calling a provider")
  .option("--json", "print machine-readable result JSON")
  .option("--overwrite", "allow replacing an existing output")
  .showHelpAfterError()
  .action(async (input: string, cli: CliOptions) => {
    const absoluteInput = resolve(input);
    const loaded = await loadConfig(cli.config);
    const config = loaded.config;
    const targetLanguage = cli.to ?? config.targetLanguage;
    const scope = mergedScope(config, cli);

    if (cli.dryRun) {
      const inspected = await inspectOfficeBuffer(
        await readFile(absoluteInput),
        basename(absoluteInput),
        scope,
      );
      const unique = new Set(inspected.segments.map((item) => item.text));
      print(
        {
          format: inspected.format,
          partsScanned: inspected.partsScanned,
          segmentsFound: inspected.segments.length,
          uniqueSegments: unique.size,
          characters: [...unique].reduce(
            (sum, text) => sum + text.length,
            0,
          ),
          skippedFieldParagraphs: inspected.skippedFieldParagraphs,
        },
        cli.json,
      );
      return;
    }

    if (!targetLanguage) {
      throw new OfficeTranslatorError(
        "Target language is required. Use --to or targetLanguage in config.",
      );
    }

    const providerConfig = cli.providerModule
      ? {
          type: "module" as const,
          module: cli.providerModule,
          options: customProviderOptions(cli.providerOptions),
        }
      : config.provider;
    if (!providerConfig) {
      throw new OfficeTranslatorError(
        "Provider is required. Configure provider or pass --provider-module.",
      );
    }
    const provider = await createProviderFromConfig(
      providerConfig,
      cli.providerModule ? process.cwd() : loaded.baseDirectory,
    );
    const outputPath = resolve(
      cli.output ?? defaultOutput(absoluteInput, targetLanguage),
    );
    const translationOptions: TranslateOfficeFileOptions = {
      inputPath: absoluteInput,
      outputPath,
      provider,
      targetLanguage,
      scope,
      overwrite: cli.overwrite ?? false,
      onProgress(progress) {
        if (!cli.json && process.stderr.isTTY) {
          process.stderr.write(
            "\rTranslating " +
              progress.translatedSegments +
              "/" +
              progress.totalSegments +
              " unique segments",
          );
          if (progress.completedBatches === progress.totalBatches) {
            process.stderr.write("\n");
          }
        }
      },
    };
    const sourceLanguage = cli.from ?? config.sourceLanguage;
    const instructions = cli.instructions ?? config.instructions;
    if (sourceLanguage) {
      translationOptions.sourceLanguage = sourceLanguage;
    }
    if (instructions) {
      translationOptions.instructions = instructions;
    }
    const batchSize = cli.batchSize ?? config.batchSize;
    const maxBatchCharacters =
      cli.maxBatchCharacters ?? config.maxBatchCharacters;
    const concurrency = cli.concurrency ?? config.concurrency;
    const retries = cli.retries ?? config.retries;
    const runDistribution =
      cli.runDistribution ?? config.runDistribution;
    if (batchSize !== undefined) {
      translationOptions.batchSize = batchSize;
    }
    if (maxBatchCharacters !== undefined) {
      translationOptions.maxBatchCharacters = maxBatchCharacters;
    }
    if (concurrency !== undefined) {
      translationOptions.concurrency = concurrency;
    }
    if (retries !== undefined) {
      translationOptions.retries = retries;
    }
    if (runDistribution !== undefined) {
      translationOptions.runDistribution = runDistribution;
    }

    const stats = await translateOfficeFile(translationOptions);
    print({ output: outputPath, ...stats }, cli.json);
  });

program.parseAsync().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Unknown office-translate error";
  process.stderr.write("Error: " + message + "\n");
  if (
    error instanceof Error &&
    error.cause instanceof Error &&
    process.env.DEBUG
  ) {
    process.stderr.write("Cause: " + error.cause.stack + "\n");
  }
  process.exitCode = 1;
});
