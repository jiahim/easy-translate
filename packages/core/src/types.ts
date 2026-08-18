export interface TranslationInputItem<TContext = unknown> {
  id: string;
  text: string;
  context: TContext;
}

export interface TranslationUnit<TContext = unknown>
  extends TranslationInputItem<TContext> {
  /** Units with the same explicit key are translated once and expanded. */
  dedupeKey?: string;
  /** A batch never crosses from one adjacent batch key to another. */
  batchKey?: string;
}

export interface TranslationDocumentDescriptor {
  id: string;
  format: string;
  sourceHash?: string;
}

export interface TranslationPlan<TContext = unknown> {
  schemaVersion: 1;
  document: TranslationDocumentDescriptor;
  units: readonly TranslationUnit<TContext>[];
}

export interface TranslationOutputItem {
  id: string;
  text: string;
}

export interface TranslationBatchRequest<TContext = unknown> {
  sourceLanguage?: string;
  targetLanguage: string;
  instructions?: string;
  items: TranslationInputItem<TContext>[];
}

export interface TranslationProviderActivity {
  phase: "response" | "retry" | "stream";
  receivedCharacters: number;
  attempt?: number;
  retryAfterMs?: number;
  retryReason?: "busy" | "format" | "request";
}

export interface TranslationProvider<TContext = unknown> {
  readonly name?: string;
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

export interface TranslationRetryPolicy {
  baseDelayMs?: number;
  jitterMs?: number;
  maxDelayMs?: number;
  maxRetries?: number;
  shouldRetry?: (error: unknown, retryIndex: number) => boolean;
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
  totalUnits: number;
  translatedUnits: number;
  lastRetry?: TranslationRetryEvent;
}

export interface TranslationCheckpointItem {
  id: string;
  sourceText: string;
  translatedText: string;
}

export interface TranslationCheckpoint {
  schemaVersion: 1;
  documentId: string;
  instructions?: string;
  sourceLanguage?: string;
  targetLanguage: string;
  translations: TranslationCheckpointItem[];
}

export interface TranslationQualityIssue {
  message: string;
  issueCode?: string;
  details?: Readonly<Record<string, unknown>>;
  retryInstruction?: string;
}

export interface TranslationQualityContext<TContext = unknown> {
  item: TranslationInputItem<TContext>;
  plan: TranslationPlan<TContext>;
  request: TranslationBatchRequest<TContext>;
  translatedText: string;
}

export type TranslationQualityPolicy<TContext = unknown> = (
  context: TranslationQualityContext<TContext>,
) =>
  | Promise<TranslationQualityIssue | undefined>
  | TranslationQualityIssue
  | undefined;

export interface TranslationEngineOptions<TContext = unknown> {
  provider: TranslationProvider<TContext>;
  targetLanguage: string;
  sourceLanguage?: string;
  instructions?: string;
  batchSize?: number;
  maxBatchCharacters?: number;
  concurrency?: number;
  retry?: TranslationRetryPolicy;
  signal?: AbortSignal;
  checkpoint?: TranslationCheckpoint;
  qualityPolicy?: TranslationQualityPolicy<TContext>;
  onProviderActivity?: (
    activity: TranslationProviderActivity,
    batchIndex: number,
  ) => void;
  onCheckpoint?: (
    checkpoint: TranslationCheckpoint,
  ) => Promise<void> | void;
  onProgress?: (progress: TranslationProgress) => void;
}

export interface TranslationResult {
  translations: ReadonlyMap<string, string>;
  checkpoint: TranslationCheckpoint;
  stats: {
    batches: number;
    characters: number;
    translatedUnits: number;
  };
}

export interface PreparedDocument<TFormatState, TContext = unknown> {
  plan: TranslationPlan<TContext>;
  formatState: TFormatState;
}

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
