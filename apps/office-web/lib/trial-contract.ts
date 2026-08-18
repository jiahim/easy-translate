import type {
  TranslationBatchRequest,
  TranslationContext,
  TranslationInputItem,
  TranslationOutputItem,
} from "./office.js";

export const TRIAL_MAX_DOCUMENT_CHARACTERS = 20_000;
export const TRIAL_MAX_REQUEST_BYTES = 64 * 1024;
export const TRIAL_MAX_ITEMS = 16;
export const TRIAL_MAX_BATCH_CHARACTERS = 2_000;
export const TRIAL_MAX_CONCURRENCY = 3;

const LANGUAGES = new Set([
  "zh-CN",
  "zh-TW",
  "en",
  "ja",
  "ko",
  "fr",
  "de",
  "es",
  "pt",
  "ru",
  "ar",
]);

const FORMATS = new Set(["word", "powerpoint", "excel"]);
const KINDS = new Set([
  "body",
  "header",
  "footer",
  "footnote",
  "endnote",
  "comment",
  "speaker-note",
  "master",
  "diagram",
  "drawing",
  "chart",
  "cell",
]);

export class TrialRequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "invalid_request",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TrialRequestError";
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TrialRequestError("请求内容必须是 JSON 对象。");
  }
  return value as Record<string, unknown>;
}

function optionalString(
  value: unknown,
  name: string,
  maximum: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new TrialRequestError(`${name} 必须是字符串。`);
  }
  if (value.length > maximum) {
    throw new TrialRequestError(`${name} 超过允许长度。`, 413, "request_too_large");
  }
  return value;
}

function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TrialRequestError(`${name} 必须是数字。`);
  }
  return value;
}

function stringArray(
  value: unknown,
  name: string,
  maximumItems: number,
  maximumCharacters: number,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > maximumItems ||
    !value.every(
      (entry) => typeof entry === "string" && entry.length <= maximumCharacters,
    )
  ) {
    throw new TrialRequestError(`${name} 格式不正确。`);
  }
  return value;
}

function validateContext(value: unknown): TranslationContext {
  const input = record(value);
  const format = optionalString(input.format, "context.format", 20);
  const part = optionalString(input.part, "context.part", 300);
  const kind = optionalString(input.kind, "context.kind", 30);
  if (!format || !FORMATS.has(format) || !part || !kind || !KINDS.has(kind)) {
    throw new TrialRequestError("文本上下文格式不正确。");
  }

  const context: TranslationContext = {
    format: format as TranslationContext["format"],
    part,
    kind: kind as TranslationContext["kind"],
  };
  const stringFields = [
    "location",
    "sheetName",
    "cellReference",
    "columnName",
    "columnHeader",
  ] as const;
  for (const field of stringFields) {
    const normalized = optionalString(input[field], `context.${field}`, 200);
    if (normalized !== undefined) context[field] = normalized;
  }
  const rowNumber = optionalNumber(input.rowNumber, "context.rowNumber");
  if (rowNumber !== undefined) context.rowNumber = rowNumber;
  const tableIndex = optionalNumber(input.tableIndex, "context.tableIndex");
  if (tableIndex !== undefined) context.tableIndex = tableIndex;
  if (input.tableRole !== undefined) {
    if (input.tableRole !== "header" && input.tableRole !== "body") {
      throw new TrialRequestError("context.tableRole 格式不正确。");
    }
    context.tableRole = input.tableRole;
  }
  const tableHeaders = stringArray(
    input.tableHeaders,
    "context.tableHeaders",
    12,
    200,
  );
  if (tableHeaders) context.tableHeaders = tableHeaders;
  const rowContext = stringArray(input.rowContext, "context.rowContext", 8, 300);
  if (rowContext) context.rowContext = rowContext;
  const usageLocations = stringArray(
    input.usageLocations,
    "context.usageLocations",
    8,
    200,
  );
  if (usageLocations) context.usageLocations = usageLocations;
  return context;
}

function validateItem(value: unknown): TranslationInputItem {
  const input = record(value);
  const id = optionalString(input.id, "item.id", 300);
  const text = optionalString(input.text, "item.text", 2_000);
  if (!id?.trim() || text === undefined) {
    throw new TrialRequestError("每个文本项都必须包含 id 和 text。");
  }
  return { id, text, context: validateContext(input.context) };
}

export function validateTrialRequest(value: unknown): TranslationBatchRequest {
  const input = record(value);
  const sourceLanguage = optionalString(input.sourceLanguage, "sourceLanguage", 20);
  const targetLanguage = optionalString(input.targetLanguage, "targetLanguage", 20);
  const instructions = optionalString(input.instructions, "instructions", 8_000);
  if (sourceLanguage && !LANGUAGES.has(sourceLanguage)) {
    throw new TrialRequestError("不支持该源语言。");
  }
  if (!targetLanguage || !LANGUAGES.has(targetLanguage)) {
    throw new TrialRequestError("不支持该目标语言。");
  }
  if (!Array.isArray(input.items) || input.items.length < 1) {
    throw new TrialRequestError("请求至少需要一个文本项。");
  }
  if (input.items.length > TRIAL_MAX_ITEMS) {
    throw new TrialRequestError(
      `单次最多翻译 ${TRIAL_MAX_ITEMS} 个文本项。`,
      413,
      "request_too_large",
    );
  }
  const items = input.items.map(validateItem);
  const ids = new Set(items.map((item) => item.id));
  if (ids.size !== items.length) {
    throw new TrialRequestError("文本项 id 不能重复。");
  }
  const characters = items.reduce((total, item) => total + item.text.length, 0);
  if (characters > TRIAL_MAX_BATCH_CHARACTERS) {
    throw new TrialRequestError(
      `单次最多翻译 ${TRIAL_MAX_BATCH_CHARACTERS} 个字符。`,
      413,
      "request_too_large",
    );
  }
  return {
    ...(sourceLanguage ? { sourceLanguage } : {}),
    targetLanguage,
    ...(instructions ? { instructions } : {}),
    items,
  };
}

function contentFromChatCompletion(value: unknown): string {
  const payload = record(value);
  if (!Array.isArray(payload.choices) || payload.choices.length < 1) {
    throw new TrialRequestError("模型服务没有返回候选结果。", 502, "upstream_response");
  }
  const choice = record(payload.choices[0]);
  const message = record(choice.message);
  if (typeof message.content !== "string") {
    throw new TrialRequestError("模型服务没有返回文本内容。", 502, "upstream_response");
  }
  return message.content;
}

export function parseTrialTranslations(
  payload: unknown,
  request: TranslationBatchRequest,
): TranslationOutputItem[] {
  return parseTrialTranslationContent(contentFromChatCompletion(payload), request);
}

export function parseTrialTranslationContent(
  modelContent: string,
  request: TranslationBatchRequest,
): TranslationOutputItem[] {
  const content = modelContent
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
  const candidates = [content];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const candidate = content.slice(start, index + 1);
        if (candidate !== content) candidates.push(candidate);
        start = -1;
      }
    }
  }
  let parsed: unknown;
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as unknown;
      if (
        typeof value === "object" &&
        value !== null &&
        "translations" in value
      ) {
        parsed = value;
        break;
      }
    } catch {
      // Some free models wrap valid JSON in a short explanation. Try the next
      // complete object before asking the model to generate the batch again.
    }
  }
  if (parsed === undefined) {
    throw new TrialRequestError("模型没有返回规定的 JSON 结果。", 502, "upstream_response");
  }
  const translations = record(parsed).translations;
  if (!Array.isArray(translations)) {
    throw new TrialRequestError("模型返回的译文格式不正确。", 502, "upstream_response");
  }
  const expectedIds = new Set(request.items.map((item) => item.id));
  const output: TranslationOutputItem[] = [];
  const returnedIds = new Set<string>();
  for (const entry of translations) {
    const item = record(entry);
    if (
      typeof item.id !== "string" ||
      typeof item.text !== "string" ||
      item.text.length > 12_000 ||
      !expectedIds.has(item.id) ||
      returnedIds.has(item.id)
    ) {
      throw new TrialRequestError("模型返回了无效或重复的文本项。", 502, "upstream_response");
    }
    returnedIds.add(item.id);
    output.push({ id: item.id, text: item.text });
  }
  if (returnedIds.size !== expectedIds.size) {
    throw new TrialRequestError("模型遗漏了部分文本项。", 502, "upstream_response");
  }
  return output;
}
