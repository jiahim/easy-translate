import type {
  TranslationBatchRequest as CoreTranslationBatchRequest,
  TranslationCheckpoint,
  TranslationInputItem as CoreTranslationInputItem,
  TranslationOutputItem as CoreTranslationOutputItem,
  TranslationProvider as CoreTranslationProvider,
  TranslationQualityPolicy,
  TranslationRetryEvent,
  TranslationRetryPolicy,
} from "@easy-translate/core";

export type OfficeFormat = "word" | "powerpoint" | "excel";

export type RunDistribution = "style-aware" | "proportional" | "first";

export type TextKind =
  | "body"
  | "header"
  | "footer"
  | "footnote"
  | "endnote"
  | "comment"
  | "speaker-note"
  | "master"
  | "diagram"
  | "drawing"
  | "chart"
  | "cell";

export interface TranslationContext {
  format: OfficeFormat;
  part: string;
  kind: TextKind;
}

export type TranslationInputItem =
  CoreTranslationInputItem<TranslationContext>;

export type TranslationOutputItem = CoreTranslationOutputItem;

export type TranslationBatchRequest =
  CoreTranslationBatchRequest<TranslationContext>;

export type TranslationProvider = CoreTranslationProvider<TranslationContext>;

export interface OfficeScopeOptions {
  includeComments?: boolean;
  includeHeadersAndFooters?: boolean;
  includeNotes?: boolean;
  includeMasters?: boolean;
  includeCharts?: boolean;
  includeDiagrams?: boolean;
}

export interface TranslationProgress {
  completedBatches: number;
  totalBatches: number;
  translatedSegments: number;
  totalSegments: number;
  activeBatches?: number;
  retryingBatches?: number;
  lastRetry?: TranslationRetryEvent;
}

export interface TranslateOfficeOptions {
  provider: TranslationProvider;
  targetLanguage: string;
  sourceLanguage?: string;
  instructions?: string;
  scope?: OfficeScopeOptions;
  batchSize?: number;
  maxBatchCharacters?: number;
  concurrency?: number;
  retries?: number;
  retryPolicy?: TranslationRetryPolicy;
  runDistribution?: RunDistribution;
  signal?: AbortSignal;
  checkpoint?: TranslationCheckpoint;
  qualityPolicy?: TranslationQualityPolicy<TranslationContext>;
  onCheckpoint?: (
    checkpoint: TranslationCheckpoint,
  ) => Promise<void> | void;
  onProgress?: (progress: TranslationProgress) => void;
}

export interface TranslateOfficeFileOptions extends TranslateOfficeOptions {
  inputPath: string;
  outputPath: string;
  overwrite?: boolean;
}

export interface TranslationStats {
  format: OfficeFormat;
  partsScanned: number;
  partsChanged: number;
  segmentsFound: number;
  uniqueSegmentsTranslated: number;
  charactersTranslated: number;
  skippedFieldParagraphs: number;
  outputBytes: number;
}

export interface TranslateOfficeResult {
  buffer: Buffer;
  stats: TranslationStats;
}

export interface InspectOfficeResult {
  format: OfficeFormat;
  partsScanned: number;
  segments: TranslationInputItem[];
  skippedFieldParagraphs: number;
}

export type ProviderConfig =
  | ChatCompletionsProviderConfig
  | GenericHttpProviderConfig
  | ModuleProviderConfig;

export interface BaseHttpProviderConfig {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface ChatCompletionsProviderConfig
  extends BaseHttpProviderConfig {
  type: "chat-completions";
  baseUrl: string;
  path?: string;
  model: string;
  apiKeyEnv?: string;
  extraBody?: Record<string, unknown>;
}

export interface GenericHttpProviderConfig extends BaseHttpProviderConfig {
  type: "generic-http";
  url: string;
  method?: "POST" | "PUT";
  extraBody?: Record<string, unknown>;
  responsePath?: string;
}

export interface ModuleProviderConfig {
  type: "module";
  module: string;
  options?: unknown;
}

export interface OfficeTranslatorConfig {
  provider?: ProviderConfig;
  sourceLanguage?: string;
  targetLanguage?: string;
  instructions?: string;
  scope?: OfficeScopeOptions;
  batchSize?: number;
  maxBatchCharacters?: number;
  concurrency?: number;
  retries?: number;
  runDistribution?: RunDistribution;
}
