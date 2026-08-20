import { translatePlan } from "./engine.js";
import { createPlan } from "./plan.js";
import type { TranslationEngineOptions, TranslationResult } from "./types.js";

/**
 * Options for {@link translateTexts}. `checkpoint` is omitted because the
 * generated document id changes on every call, so a checkpoint could never
 * match; use `createPlan` with a stable document id to resume.
 */
export type TranslateTextsOptions = Omit<
  TranslationEngineOptions<undefined>,
  "checkpoint"
>;

/**
 * Translates plain strings without building a {@link TranslationPlan} by hand.
 * Results come back in input order.
 *
 * ```ts
 * const [greeting] = await translateTexts(["Hello"], {
 *   provider,
 *   targetLanguage: "zh-CN",
 * });
 * ```
 *
 * Identical strings are still translated separately, matching the engine rule
 * that deduplication is always explicit. Use `createPlan` with `dedupeKey` and
 * `translatePlan` when you want repeated text translated once.
 */
export async function translateTexts(
  texts: readonly string[],
  options: TranslateTextsOptions,
): Promise<string[]> {
  const plan = createPlan<undefined>(texts);
  const result = await translatePlan(plan, options);
  return plan.units.map(
    (unit) => result.translations.get(unit.id) ?? unit.text,
  );
}

/**
 * Converts `result.translations` into a plain object, for JSON responses,
 * snapshots and logs.
 */
export function toTranslationRecord(
  result: TranslationResult,
): Record<string, string> {
  return Object.fromEntries(result.translations);
}
