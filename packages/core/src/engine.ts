import {
  TranslationConfigurationError,
  TranslationErrorCode,
  TranslationPlanError,
  TranslationResponseError,
} from "./errors.js";
import { parseBatchOutput } from "./response.js";
import { retryOperation } from "./retry.js";
import type {
  TranslationBatchRequest,
  TranslationCheckpoint,
  TranslationCheckpointItem,
  TranslationEngineOptions,
  TranslationInputItem,
  TranslationOutputItem,
  TranslationPlan,
  TranslationProgress,
  TranslationProviderActivity,
  TranslationResult,
  TranslationRetryPolicy,
  TranslationUnit,
} from "./types.js";

interface UniqueUnit<TContext> {
  item: TranslationUnit<TContext>;
  occurrenceIds: string[];
}

interface TranslationBatch<TContext> {
  items: UniqueUnit<TContext>[];
  characters: number;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new TranslationConfigurationError(
      TranslationErrorCode.ConfigInvalidIntegerOption,
      label + " must be a positive integer.",
      {
        details: {
          option: label,
          value: resolved,
          minimum: 1,
        },
      },
    );
  }
  return resolved;
}

function validatePlan<TContext>(plan: TranslationPlan<TContext>): void {
  if (plan.schemaVersion !== 1) {
    throw new TranslationPlanError(
      TranslationErrorCode.PlanUnsupportedSchema,
      "Unsupported translation plan schema: " + plan.schemaVersion,
      { details: { schemaVersion: plan.schemaVersion } },
    );
  }
  if (!plan.document.id.trim()) {
    throw new TranslationPlanError(
      TranslationErrorCode.PlanDocumentIdRequired,
      "Translation plan document.id is required.",
      { details: { field: "document.id" } },
    );
  }
  if (!plan.document.format.trim()) {
    throw new TranslationPlanError(
      TranslationErrorCode.PlanDocumentFormatRequired,
      "Translation plan document.format is required.",
      { details: { field: "document.format" } },
    );
  }
  const ids = new Set<string>();
  for (const unit of plan.units) {
    if (!unit.id.trim()) {
      throw new TranslationPlanError(
        TranslationErrorCode.PlanUnitIdRequired,
        "Translation unit id is required.",
        { details: { field: "unit.id" } },
      );
    }
    if (ids.has(unit.id)) {
      throw new TranslationPlanError(
        TranslationErrorCode.PlanDuplicateUnitId,
        "Translation plan contains a duplicate id: " + unit.id,
        { details: { unitId: unit.id } },
      );
    }
    ids.add(unit.id);
  }
}

function uniqueUnits<TContext>(
  units: readonly TranslationUnit<TContext>[],
): UniqueUnit<TContext>[] {
  const byKey = new Map<string, UniqueUnit<TContext>>();
  for (const unit of units) {
    const key = unit.dedupeKey ?? unit.id;
    const existing = byKey.get(key);
    if (existing) {
      if (existing.item.text !== unit.text) {
        throw new TranslationPlanError(
          TranslationErrorCode.PlanDedupeTextMismatch,
          "Translation units with the same dedupeKey must have identical text: " +
            key,
          { details: { dedupeKey: key } },
        );
      }
      existing.occurrenceIds.push(unit.id);
      continue;
    }
    byKey.set(key, { item: unit, occurrenceIds: [unit.id] });
  }
  return [...byKey.values()];
}

function makeBatches<TContext>(
  items: UniqueUnit<TContext>[],
  batchSize: number,
  maxBatchCharacters: number,
): TranslationBatch<TContext>[] {
  const batches: TranslationBatch<TContext>[] = [];
  let current: TranslationBatch<TContext> = { items: [], characters: 0 };
  let currentBatchKey: string | undefined;

  for (const item of items) {
    const keyChanged =
      current.items.length > 0 && currentBatchKey !== item.item.batchKey;
    const countExceeded = current.items.length >= batchSize;
    const charactersExceeded =
      current.items.length > 0 &&
      current.characters + item.item.text.length > maxBatchCharacters;
    if (keyChanged || countExceeded || charactersExceeded) {
      batches.push(current);
      current = { items: [], characters: 0 };
      currentBatchKey = undefined;
    }
    if (!current.items.length) currentBatchKey = item.item.batchKey;
    current.items.push(item);
    current.characters += item.item.text.length;
  }
  if (current.items.length) batches.push(current);
  return batches;
}

function requestForBatch<TContext>(
  batch: TranslationBatch<TContext>,
  options: TranslationEngineOptions<TContext>,
  retryInstruction: string,
): TranslationBatchRequest<TContext> {
  const request: TranslationBatchRequest<TContext> = {
    targetLanguage: options.targetLanguage,
    items: batch.items.map(({ item }) => ({
      id: item.id,
      text: item.text,
      context: item.context,
    })),
  };
  if (options.sourceLanguage) request.sourceLanguage = options.sourceLanguage;
  const instructions = [options.instructions, retryInstruction]
    .filter(Boolean)
    .join("\n");
  if (instructions) request.instructions = instructions;
  return request;
}

async function validateOutput<TContext>(
  batch: TranslationBatch<TContext>,
  output: TranslationOutputItem[],
  request: TranslationBatchRequest<TContext>,
  plan: TranslationPlan<TContext>,
  options: TranslationEngineOptions<TContext>,
): Promise<Map<string, string>> {
  const result = parseBatchOutput(request, output);
  if (!options.qualityPolicy) return result;

  for (const entry of batch.items) {
    const translatedText = result.get(entry.item.id)!;
    const qualityItem: TranslationInputItem<TContext> = {
      id: entry.item.id,
      text: entry.item.text,
      context: entry.item.context,
    };
    const issue = await options.qualityPolicy({
      item: qualityItem,
      plan,
      request,
      translatedText,
    });
    if (issue) {
      throw new TranslationResponseError(
        TranslationErrorCode.ResponseQualityRejected,
        issue.message,
        {
          details: {
            ...issue.details,
            ...(issue.issueCode === undefined
              ? {}
              : { issueCode: issue.issueCode }),
            unitId: entry.item.id,
          },
          ...(issue.retryInstruction === undefined
            ? {}
            : { retryInstruction: issue.retryInstruction }),
        },
      );
    }
  }
  return result;
}

function checkpointMatches<TContext>(
  checkpoint: TranslationCheckpoint | undefined,
  plan: TranslationPlan<TContext>,
  options: TranslationEngineOptions<TContext>,
): checkpoint is TranslationCheckpoint {
  if (!checkpoint || checkpoint.schemaVersion !== 1) return false;
  return (
    checkpoint.documentId === plan.document.id &&
    checkpoint.targetLanguage === options.targetLanguage &&
    (checkpoint.sourceLanguage ?? "") === (options.sourceLanguage ?? "") &&
    (checkpoint.instructions ?? "") === (options.instructions ?? "")
  );
}

function checkpointSnapshot<TContext>(
  plan: TranslationPlan<TContext>,
  options: TranslationEngineOptions<TContext>,
  items: UniqueUnit<TContext>[],
  completed: ReadonlyMap<string, TranslationCheckpointItem>,
): TranslationCheckpoint {
  const checkpoint: TranslationCheckpoint = {
    schemaVersion: 1,
    documentId: plan.document.id,
    targetLanguage: options.targetLanguage,
    translations: items.flatMap((entry) => {
      const item = completed.get(entry.item.id);
      return item ? [item] : [];
    }),
  };
  if (options.sourceLanguage) checkpoint.sourceLanguage = options.sourceLanguage;
  if (options.instructions) checkpoint.instructions = options.instructions;
  return checkpoint;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Translation was aborted.", "AbortError");
}

/**
 * Executes a translation plan: deduplicates units, splits them into batches,
 * runs batches concurrently through the provider, validates every response,
 * retries recoverable failures and emits progress and checkpoints.
 *
 * For plain strings, prefer `translateTexts`, which builds the plan for you.
 *
 * @throws {TranslationConfigurationError} Invalid options.
 * @throws {TranslationPlanError} Malformed plan.
 * @throws {TranslationResponseError} The provider kept returning invalid or
 * rejected output after all retries.
 */
export async function translatePlan<TContext>(
  plan: TranslationPlan<TContext>,
  options: TranslationEngineOptions<TContext>,
): Promise<TranslationResult> {
  validatePlan(plan);
  if (!options.targetLanguage.trim()) {
    throw new TranslationConfigurationError(
      TranslationErrorCode.ConfigTargetLanguageRequired,
      "targetLanguage is required.",
      { details: { option: "targetLanguage" } },
    );
  }
  const batchSize = positiveInteger(options.batchSize, 40, "batchSize");
  const maxBatchCharacters = positiveInteger(
    options.maxBatchCharacters,
    8_000,
    "maxBatchCharacters",
  );
  const concurrency = positiveInteger(options.concurrency, 2, "concurrency");
  const retryPolicy: TranslationRetryPolicy =
    typeof options.retry === "number"
      ? { maxRetries: options.retry }
      : (options.retry ?? {});
  const unique = uniqueUnits(plan.units);
  const batches = makeBatches(unique, batchSize, maxBatchCharacters);
  const translations = new Map<string, string>();
  const completedItems = new Map<string, TranslationCheckpointItem>();

  if (checkpointMatches(options.checkpoint, plan, options)) {
    const uniqueById = new Map(unique.map((entry) => [entry.item.id, entry]));
    for (const cached of options.checkpoint.translations) {
      const entry = uniqueById.get(cached.id);
      if (
        !entry ||
        cached.sourceText !== entry.item.text ||
        (!cached.translatedText.trim() && entry.item.text.trim())
      ) {
        continue;
      }
      completedItems.set(entry.item.id, cached);
      for (const id of entry.occurrenceIds) {
        translations.set(id, cached.translatedText);
      }
    }
  }
  const fromCheckpointUnits = completedItems.size;

  const pendingBatches = batches.flatMap((batch, index) => {
    const items = batch.items.filter(
      (entry) => !completedItems.has(entry.item.id),
    );
    return items.length
      ? [
          {
            index,
            batch: {
              items,
              characters: items.reduce(
                (sum, entry) => sum + entry.item.text.length,
                0,
              ),
            },
          },
        ]
      : [];
  });
  let completedBatches = batches.length - pendingBatches.length;
  let nextBatch = 0;
  const activeBatches = new Set<number>();
  const retryingBatches = new Set<number>();
  let lastRetry: TranslationProgress["lastRetry"];

  const reportProgress = (): void => {
    const progress: TranslationProgress = {
      activeBatches: activeBatches.size,
      completedBatches,
      retryingBatches: retryingBatches.size,
      totalBatches: batches.length,
      totalUnits: unique.length,
      translatedUnits: completedItems.size,
    };
    if (lastRetry) progress.lastRetry = lastRetry;
    options.onProgress?.(progress);
  };

  let checkpointWrite = Promise.resolve();
  const saveCheckpoint = async (): Promise<void> => {
    if (!options.onCheckpoint) return;
    const snapshot = checkpointSnapshot(plan, options, unique, completedItems);
    checkpointWrite = checkpointWrite.then(() =>
      options.onCheckpoint?.(snapshot),
    );
    await checkpointWrite;
  };

  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener("abort", forwardAbort, { once: true });

  reportProgress();
  await saveCheckpoint();

  const worker = async (): Promise<void> => {
    while (nextBatch < pendingBatches.length) {
      if (controller.signal.aborted) throw abortError(controller.signal);
      const pending = pendingBatches[nextBatch]!;
      nextBatch += 1;
      activeBatches.add(pending.index);
      reportProgress();
      let retryInstruction = "";

      try {
        const validated = await retryOperation(
          async () => {
            retryingBatches.delete(pending.index);
            reportProgress();
            const request = requestForBatch(
              pending.batch,
              options,
              retryInstruction,
            );
            try {
              const output = await options.provider.translateBatch(
                request,
                controller.signal,
                (activity: TranslationProviderActivity) => {
                  if (activity.phase === "retry") {
                    retryingBatches.add(pending.index);
                  } else {
                    retryingBatches.delete(pending.index);
                  }
                  reportProgress();
                  options.onProviderActivity?.(activity, pending.index);
                },
              );
              return await validateOutput(
                pending.batch,
                output,
                request,
                plan,
                options,
              );
            } catch (error) {
              if (error instanceof TranslationResponseError) {
                retryInstruction = error.retryInstruction ?? "";
              }
              throw error;
            }
          },
          {
            ...retryPolicy,
            signal: controller.signal,
            onRetry(event) {
              lastRetry = event;
              retryingBatches.add(pending.index);
              reportProgress();
            },
          },
        );

        for (const entry of pending.batch.items) {
          const translatedText = validated.get(entry.item.id)!;
          completedItems.set(entry.item.id, {
            id: entry.item.id,
            sourceText: entry.item.text,
            translatedText,
          });
          for (const id of entry.occurrenceIds) {
            translations.set(id, translatedText);
          }
        }
        completedBatches += 1;
        activeBatches.delete(pending.index);
        retryingBatches.delete(pending.index);
        reportProgress();
        await saveCheckpoint();
      } catch (error) {
        activeBatches.delete(pending.index);
        retryingBatches.delete(pending.index);
        controller.abort(error);
        throw error;
      }
    }
  };

  try {
    await Promise.all(
      Array.from(
        { length: Math.min(concurrency, pendingBatches.length) },
        () => worker(),
      ),
    );
    await checkpointWrite;
  } finally {
    options.signal?.removeEventListener("abort", forwardAbort);
  }

  const checkpoint = checkpointSnapshot(plan, options, unique, completedItems);
  return {
    translations,
    checkpoint,
    stats: {
      batches: batches.length,
      characters: unique.reduce((sum, entry) => sum + entry.item.text.length, 0),
      translatedUnits: unique.length,
      uniqueUnits: unique.length,
      freshlyTranslatedUnits: completedItems.size - fromCheckpointUnits,
      fromCheckpointUnits,
    },
  };
}
