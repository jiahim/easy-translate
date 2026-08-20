import {
  access,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { OfficeTranslatorError } from "./errors.js";
import {
  prepareOfficeDocument,
  renderOfficeDocument,
} from "./office-adapter.js";
import { translatePlan } from "@easy-translate/core";
import type { TranslationRetryPolicy } from "@easy-translate/core";
import type {
  InspectOfficeResult,
  TranslateOfficeFileOptions,
  TranslateOfficeOptions,
  TranslateOfficeResult,
  TranslationStats,
} from "./types.js";

/** `retries` is a shorthand that wins over `retryPolicy.maxRetries`. */
function resolveRetry(
  options: TranslateOfficeOptions,
): TranslationRetryPolicy | undefined {
  if (!options.retryPolicy && options.retries === undefined) return undefined;
  return {
    ...options.retryPolicy,
    maxRetries: options.retries ?? options.retryPolicy?.maxRetries,
  };
}

export async function inspectOfficeBuffer(
  buffer: Buffer,
  fileName: string,
  scope?: TranslateOfficeOptions["scope"],
): Promise<InspectOfficeResult> {
  const prepared = await prepareOfficeDocument(
    { buffer, fileName },
    scope ? { scope } : {},
  );
  const plan = prepared.formatState.packagePlan;
  return {
    format: plan.format,
    partsScanned: plan.partsScanned,
    segments: plan.parts.flatMap((part) =>
      part.segments.map((segment) => ({
        id: segment.id,
        text: segment.text,
        context: segment.context,
      })),
    ),
    skippedFieldParagraphs: plan.skippedFieldParagraphs,
  };
}

export async function translateOfficeBuffer(
  buffer: Buffer,
  fileName: string,
  options: TranslateOfficeOptions,
): Promise<TranslateOfficeResult> {
  if (!options.targetLanguage.trim()) {
    throw new OfficeTranslatorError("targetLanguage is required.");
  }

  const prepared = await prepareOfficeDocument(
    { buffer, fileName },
    options.scope ? { scope: options.scope } : {},
  );
  const plan = prepared.formatState.packagePlan;
  const segments = prepared.plan.units;
  const translated = await translatePlan(prepared.plan, {
    provider: options.provider,
    targetLanguage: options.targetLanguage,
    sourceLanguage: options.sourceLanguage,
    instructions: options.instructions,
    batchSize: options.batchSize,
    maxBatchCharacters: options.maxBatchCharacters,
    concurrency: options.concurrency,
    retry: resolveRetry(options),
    signal: options.signal,
    checkpoint: options.checkpoint,
    qualityPolicy: options.qualityPolicy,
    onCheckpoint: options.onCheckpoint,
    onProgress(progress) {
      options.onProgress?.({
        completedBatches: progress.completedBatches,
        totalBatches: progress.totalBatches,
        translatedSegments: progress.translatedUnits,
        totalSegments: progress.totalUnits,
        activeBatches: progress.activeBatches,
        retryingBatches: progress.retryingBatches,
        ...(progress.lastRetry ? { lastRetry: progress.lastRetry } : {}),
      });
    },
  });

  if (!segments.length) {
    const stats: TranslationStats = {
      format: plan.format,
      partsScanned: plan.partsScanned,
      partsChanged: 0,
      segmentsFound: 0,
      uniqueSegmentsTranslated: 0,
      charactersTranslated: 0,
      skippedFieldParagraphs: plan.skippedFieldParagraphs,
      outputBytes: buffer.length,
    };
    return { buffer, stats };
  }

  const rendered = await renderOfficeDocument(
    prepared.formatState,
    translated,
    { runDistribution: options.runDistribution ?? "style-aware" },
  );
  const stats: TranslationStats = {
    format: plan.format,
    partsScanned: plan.partsScanned,
    partsChanged: rendered.partsChanged,
    segmentsFound: segments.length,
    uniqueSegmentsTranslated: translated.stats.uniqueUnits,
    charactersTranslated: translated.stats.characters,
    skippedFieldParagraphs: plan.skippedFieldParagraphs,
    outputBytes: rendered.buffer.length,
  };
  return { buffer: rendered.buffer, stats };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function translateOfficeFile(
  options: TranslateOfficeFileOptions,
): Promise<TranslationStats> {
  const inputPath = resolve(options.inputPath);
  const outputPath = resolve(options.outputPath);

  if (!(await pathExists(inputPath))) {
    throw new OfficeTranslatorError("Input file does not exist: " + inputPath);
  }
  if ((inputPath === outputPath || (await pathExists(outputPath))) && !options.overwrite) {
    throw new OfficeTranslatorError(
      "Output already exists. Pass overwrite: true or use --overwrite.",
    );
  }

  const input = await readFile(inputPath);
  const result = await translateOfficeBuffer(
    input,
    basename(inputPath),
    options,
  );

  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath =
    outputPath + "." + process.pid + "." + Date.now() + ".tmp";
  try {
    await writeFile(temporaryPath, result.buffer, { flag: "wx" });
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw new OfficeTranslatorError(
      "Unable to write translated file: " + outputPath,
      { cause: error },
    );
  }
  return result.stats;
}
