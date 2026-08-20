/** A single translatable item as it is handed to a provider. */
export interface TranslationInputItem<TContext = unknown> {
  id: string;
  text: string;
  context: TContext;
}

/** A translatable item inside a plan, with optional grouping hints. */
export interface TranslationUnit<TContext = unknown>
  extends TranslationInputItem<TContext> {
  /** Units with the same explicit key are translated once and expanded. */
  dedupeKey?: string | undefined;
  /** A batch never crosses from one adjacent batch key to another. */
  batchKey?: string | undefined;
}

/** Identifies the document a plan was produced from. */
export interface TranslationDocumentDescriptor {
  id: string;
  /** Free-form format tag such as `"plain"`, `"docx"` or `"pptx"`. */
  format: string;
  sourceHash?: string | undefined;
}

/**
 * The unit of work accepted by {@link translatePlan}. Build one with
 * `createPlan` instead of writing the envelope by hand.
 */
export interface TranslationPlan<TContext = unknown> {
  schemaVersion: 1;
  document: TranslationDocumentDescriptor;
  units: readonly TranslationUnit<TContext>[];
}

/** What a provider must return for every requested item. */
export interface TranslationOutputItem {
  id: string;
  text: string;
}

/** One batch of items handed to `TranslationProvider.translateBatch`. */
export interface TranslationBatchRequest<TContext = unknown> {
  sourceLanguage?: string | undefined;
  targetLanguage: string;
  /**
   * Caller instructions, plus a repair instruction appended by the engine when
   * a previous attempt returned a malformed or rejected response.
   */
  instructions?: string | undefined;
  items: TranslationInputItem<TContext>[];
}

/**
 * Optional progress signal a provider may emit while a batch is in flight, so
 * that streaming and provider-internal retries stay visible to the caller.
 */
export interface TranslationProviderActivity {
  phase: "response" | "retry" | "stream";
  receivedCharacters: number;
  attempt?: number | undefined;
  retryAfterMs?: number | undefined;
  retryReason?: "busy" | "format" | "request" | undefined;
}

/**
 * The only integration point the engine requires. Implementations translate a
 * batch and must return exactly one entry per requested id.
 */
export interface TranslationProvider<TContext = unknown> {
  readonly name?: string | undefined;
  translateBatch(
    request: TranslationBatchRequest<TContext>,
    signal?: AbortSignal,
    onActivity?: (activity: TranslationProviderActivity) => void,
  ): Promise<TranslationOutputItem[]>;
}

export type TranslationRetryReason =
  | "provider"
  | "quality"
  | "response";

/** Exponential backoff configuration shared by the engine and `retryOperation`. */
export interface TranslationRetryPolicy {
  /** @defaultValue 400 */
  baseDelayMs?: number | undefined;
  /** @defaultValue 0 */
  jitterMs?: number | undefined;
  /** @defaultValue 4000 */
  maxDelayMs?: number | undefined;
  /** Retries after the first attempt. @defaultValue 2 */
  maxRetries?: number | undefined;
  /**
   * Overrides the default rule, which retries `TranslationResponseError` and
   * any `TranslationProviderError` marked `retryable`.
   */
  shouldRetry?: ((error: unknown, retryIndex: number) => boolean) | undefined;
}

export interface TranslationRetryEvent {
  attempt: number;
  delayMs: number;
  error: unknown;
  nextAttempt: number;
  reason: TranslationRetryReason;
}

export interface TranslationProgress {
  activeBatches: number;
  completedBatches: number;
  retryingBatches: number;
  totalBatches: number;
  /** Deduplicated units in the plan. */
  totalUnits: number;
  /** Deduplicated units translated so far, including checkpoint hits. */
  translatedUnits: number;
  lastRetry?: TranslationRetryEvent | undefined;
}

export interface TranslationCheckpointItem {
  id: string;
  sourceText: string;
  translatedText: string;
}

/**
 * Resumable state. A checkpoint is only reused when its document id, languages
 * and instructions all match the current run.
 */
export interface TranslationCheckpoint {
  schemaVersion: 1;
  documentId: string;
  instructions?: string | undefined;
  sourceLanguage?: string | undefined;
  targetLanguage: string;
  translations: TranslationCheckpointItem[];
}

/** Returned by a quality policy to reject a translation and trigger a retry. */
export interface TranslationQualityIssue {
  message: string;
  issueCode?: string | undefined;
  details?: Readonly<Record<string, unknown>> | undefined;
  /** Appended to the next attempt's instructions. */
  retryInstruction?: string | undefined;
}

export interface TranslationQualityContext<TContext = unknown> {
  item: TranslationInputItem<TContext>;
  plan: TranslationPlan<TContext>;
  request: TranslationBatchRequest<TContext>;
  translatedText: string;
}

/**
 * Inspects every translated unit. Return an issue to reject it, or `undefined`
 * to accept it.
 */
export type TranslationQualityPolicy<TContext = unknown> = (
  context: TranslationQualityContext<TContext>,
) =>
  | Promise<TranslationQualityIssue | undefined>
  | TranslationQualityIssue
  | undefined;

export interface TranslationEngineOptions<TContext = unknown> {
  provider: TranslationProvider<TContext>;
  targetLanguage: string;
  sourceLanguage?: string | undefined;
  /** Extra guidance forwarded to the provider on every batch. */
  instructions?: string | undefined;
  /** Maximum units per batch. @defaultValue 40 */
  batchSize?: number | undefined;
  /** Maximum source characters per batch. @defaultValue 8000 */
  maxBatchCharacters?: number | undefined;
  /** Batches translated in parallel. @defaultValue 2 */
  concurrency?: number | undefined;
  /** A number is shorthand for `{ maxRetries: n }`. */
  retry?: number | TranslationRetryPolicy | undefined;
  signal?: AbortSignal | undefined;
  /** Previous checkpoint to resume from. */
  checkpoint?: TranslationCheckpoint | undefined;
  qualityPolicy?: TranslationQualityPolicy<TContext> | undefined;
  onProviderActivity?:
    | ((activity: TranslationProviderActivity, batchIndex: number) => void)
    | undefined;
  /** Awaited and serialized, so writes never interleave. */
  onCheckpoint?:
    | ((checkpoint: TranslationCheckpoint) => Promise<void> | void)
    | undefined;
  onProgress?: ((progress: TranslationProgress) => void) | undefined;
}

export interface TranslationResult {
  /** Translation for every plan unit id, including deduplicated duplicates. */
  translations: ReadonlyMap<string, string>;
  /** Pass to a later run's `checkpoint` option to resume. */
  checkpoint: TranslationCheckpoint;
  stats: {
    batches: number;
    /** Source characters across deduplicated units. */
    characters: number;
    /**
     * @deprecated Counts deduplicated units in the plan, not units translated
     * in this run. Use `uniqueUnits`, or `freshlyTranslatedUnits` for the work
     * actually sent to the provider. Removed in 0.4.0.
     */
    translatedUnits: number;
    /** Deduplicated units in the plan. */
    uniqueUnits: number;
    /** Units sent to the provider in this run. */
    freshlyTranslatedUnits: number;
    /** Units restored from the supplied checkpoint. */
    fromCheckpointUnits: number;
  };
}

export interface PreparedDocument<TFormatState, TContext = unknown> {
  plan: TranslationPlan<TContext>;
  formatState: TFormatState;
}

/**
 * Contract for format packages: turn a source file into a plan, then merge a
 * result back into that file.
 */
export interface DocumentAdapter<
  TInput,
  TFormatState,
  TOutput,
  TContext = unknown,
  TPrepareOptions = undefined,
  TRenderOptions = undefined,
> {
  prepare(
    input: TInput,
    options?: TPrepareOptions,
  ): Promise<PreparedDocument<TFormatState, TContext>>;
  render(
    state: TFormatState,
    result: TranslationResult,
    options?: TRenderOptions,
  ): Promise<TOutput>;
}
