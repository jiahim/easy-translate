import type {
  TranslationDocumentDescriptor,
  TranslationPlan,
  TranslationUnit,
} from "./types.js";

/**
 * A unit accepted by {@link createPlan}. Pass a bare string for the common
 * case, or an object when you need `dedupeKey`, `batchKey`, a stable `id` or a
 * context payload.
 */
export type PlanUnitInput<TContext> =
  | string
  | (Omit<TranslationUnit<TContext>, "context" | "id"> & {
      /** @defaultValue `"u"` followed by the array index */
      id?: string | undefined;
      context?: TContext | undefined;
    });

let autoDocumentId = 0;

function toUnit<TContext>(
  unit: PlanUnitInput<TContext>,
  index: number,
): TranslationUnit<TContext> {
  if (typeof unit === "string") {
    return { id: "u" + index, text: unit, context: undefined as TContext };
  }
  const { id, context, ...rest } = unit;
  return {
    ...rest,
    id: id ?? "u" + index,
    context: context as TContext,
  };
}

/**
 * Builds a valid {@link TranslationPlan} from plain strings or partial units,
 * filling in `schemaVersion`, the document descriptor, unit ids and context.
 *
 * ```ts
 * const plan = createPlan(["Hello", "World"]);
 * const scoped = createPlan(
 *   [{ text: "Hello", dedupeKey: "greeting" }],
 *   { id: "guide.md", format: "markdown" },
 * );
 * ```
 *
 * Supply a stable `document.id` whenever you intend to resume from a
 * checkpoint; the generated fallback changes on every call.
 */
export function createPlan<TContext = undefined>(
  units: readonly PlanUnitInput<TContext>[],
  document: Partial<TranslationDocumentDescriptor> = {},
): TranslationPlan<TContext> {
  const descriptor: TranslationDocumentDescriptor = {
    id: document.id ?? "doc-" + (autoDocumentId += 1),
    format: document.format ?? "plain",
  };
  if (document.sourceHash !== undefined) {
    descriptor.sourceHash = document.sourceHash;
  }
  return {
    schemaVersion: 1,
    document: descriptor,
    units: units.map((unit, index) => toUnit(unit, index)),
  };
}
