import {
  TranslationPlanError,
  TranslationResponseError,
} from "./errors.js";
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

const RESPONSE_FORMAT_RETRY_INSTRUCTION =
  "RESPONSE FORMAT RETRY: Return every requested id exactly once with a non-empty translated text. Do not add commentary or omit items.";

function positiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new TranslationPlanError(label + " must be a positive integer.");
  }
  return resolved;
}

function validatePlan<TContext>(plan: TranslationPlan<TContext>): void {
  if (plan.schemaVersion !== 1) {
    throw new TranslationPlanError(
      "Unsupported translation plan schema: " + plan.schemaVersion,
    );
  }
  if (!plan.document.id.trim()) {
    throw new TranslationPlanError("Translation plan document.id is required.");
  }
  if (!plan.document.format.trim()) {
    throw new TranslationPlanError(
      "Translation plan document.format is required.",
    );
  }
  const ids = new Set<string>();
  for (const unit of plan.units) {
    if (!unit.id.trim()) {
      throw new TranslationPlanError("Translation unit id is required.");
    }
    if (ids.has(unit.id)) {
      throw new TranslationPlanError(
        "Translation plan contains a duplicate id: " + unit.id,
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
          "Translation units with the same dedupeKey must have identical text: " +
            key,
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
  if (!Array.isArray(output)) {
    throw new TranslationResponseError(
      "The provider must return an array of { id, text } objects.",
      { retryInstruction: RESPONSE_FORMAT_RETRY_INSTRUCTION },
    );
  }
  const expectedIds = new Set(batch.items.map(({ item }) => item.id));
  const result = new Map<string, string>();
  for (const item of output) {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof item.id !== "string" ||
      typeof item.text !== "string"
    ) {
      throw new TranslationResponseError(
        "The provider returned an invalid translation item.",
        { retryInstruction: RESPONSE_FORMAT_RETRY_INSTRUCTION },
      );
    }
    if (!expectedIds.has(item.id)) {
      throw new TranslationResponseError(
        "The provider returned an unexpected translation id: " + item.id,
        { retryInstruction: RESPONSE_FORMAT_RETRY_INSTRUCTION },
      );
    }
    if (result.has(item.id)) {
      throw new TranslationResponseError(
        "The provider returned a duplicate translation id: " + item.id,
        { retryInstruction: RESPONSE_FORMAT_RETRY_INSTRUCTION },
      );
    }
    result.set(item.id, item.text);
  }

  for (const entry of batch.items) {
    const translatedText = result.get(entry.item.id);
    if (
      translatedText === undefined ||
      (!translatedText.trim() && entry.item.text.trim())
    ) {
      throw new TranslationResponseError(
        "The provider omitted translation id: " + entry.item.id,
        { retryInstruction: RESPONSE_FORMAT_RETRY_INSTRUCTION },
      );
    }
    const qualityItem: TranslationInputItem<TContext> = {
      id: entry.item.id,
      text: entry.item.text,
      context: entry.item.context,
    };
    const issue = await options.qualityPolicy?.({
      item: qualityItem,
      plan,
      request,
      translatedText,
    });
    if (issue) {
      throw new TranslationResponseError(
        issue.message,
        issue.retryInstruction === undefined
          ? { reason: "quality" }
          : {
              reason: "quality",
              retryInstruction: issue.retryInstruction,
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

export async function translatePlan<TContext>(
  plan: TranslationPlan<TContext>,
  options: TranslationEngineOptions<TContext>,
): Promise<TranslationResult> {
  validatePlan(plan);
  if (!options.targetLanguage.trim()) {
    throw new TranslationPlanError("targetLanguage is required.");
  }
  const batchSize = positiveInteger(options.batchSize, 40, "batchSize");
  const maxBatchCharacters = positiveInteger(
    options.maxBatchCharacters,
    8_000,
    "maxBatchCharacters",
  );
  const concurrency = positiveInteger(options.concurrency, 2, "concurrency");
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
            ...options.retry,
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
    },
  };
}
