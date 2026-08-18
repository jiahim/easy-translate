import JSZip from "jszip";
import {
  retryOperation,
  translatePlan,
  type TranslationCheckpoint as CoreTranslationCheckpoint,
  type TranslationPlan as CoreTranslationPlan,
  type TranslationProgress as CoreTranslationProgress,
  type TranslationRetryPolicy,
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
  location?: string;
  sheetName?: string;
  cellReference?: string;
  rowNumber?: number;
  columnName?: string;
  columnHeader?: string;
  tableIndex?: number;
  tableRole?: "header" | "body";
  tableHeaders?: string[];
  rowContext?: string[];
  usageLocations?: string[];
}

export interface TranslationInputItem {
  id: string;
  text: string;
  context: TranslationContext;
}

export interface TranslationOutputItem {
  id: string;
  text: string;
}

export interface TranslationActivity {
  phase: "response" | "stream" | "retry";
  receivedCharacters: number;
  retryAfterMs?: number;
  attempt?: number;
  retryReason?: "busy" | "format" | "request";
}

export interface TranslationBatchRequest {
  sourceLanguage?: string;
  targetLanguage: string;
  instructions?: string;
  items: TranslationInputItem[];
}

export function translationSystemPrompt(): string {
  return [
    "You are a translation engine for Office documents.",
    "Translate every natural-language phrase in every item, including headings, table cells and mixed-language text.",
    "Use item.context such as sheet, cell, columnHeader, tableHeaders and rowContext only to disambiguate meaning and keep terminology consistent.",
    "Translate only item.text; never copy context values into the translated output.",
    "When a DOCUMENT GLOSSARY is supplied, use its equivalents exactly and consistently.",
    "Never copy source-language prose unchanged when it differs from the target language.",
    "Preserve placeholders, URLs, identifiers, acronyms, model names, standards, numbers, versions and whitespace intent.",
    "Keep compact metadata compact; when a source date is numeric, preserve a concise numeric date format instead of spelling out month names.",
    "Do not add explanations.",
    'Return strict JSON: {"translations":[{"id":"same id","text":"translated text"}]}.',
    "Return every id exactly once.",
  ].join(" ");
}

export interface TranslationProvider {
  readonly name?: string;
  translateBatch(
    request: TranslationBatchRequest,
    signal?: AbortSignal,
    onActivity?: (activity: TranslationActivity) => void,
  ): Promise<TranslationOutputItem[]>;
}

export function translateProviderBatchWithRetry(
  provider: TranslationProvider,
  request: TranslationBatchRequest,
  signal?: AbortSignal,
  onActivity?: (activity: TranslationActivity) => void,
  retry: TranslationRetryPolicy = {},
): Promise<TranslationOutputItem[]> {
  return retryOperation(
    () => provider.translateBatch(request, signal, onActivity),
    { ...retry, ...(signal ? { signal } : {}) },
  );
}

export interface OfficeScopeOptions {
  includeComments?: boolean;
  includeHeadersAndFooters?: boolean;
  includeNotes?: boolean;
  includeMasters?: boolean;
  includeCharts?: boolean;
  includeDiagrams?: boolean;
}

export interface TranslationProgress {
  stage: "glossary" | "translation";
  completedBatches: number;
  submittedBatches: number;
  respondingBatches: number;
  retryingBatches?: number;
  retryAfterSeconds?: number;
  retryReason?: "busy" | "format" | "request";
  totalBatches: number;
  translatedSegments: number;
  totalSegments: number;
  percentage: number;
}

export interface TranslationCheckpointItem {
  id: string;
  sourceText: string;
  translatedText: string;
}

export interface TranslationCheckpoint {
  version: 1;
  glossary: string;
  translations: TranslationCheckpointItem[];
  completedBatches: number;
  totalBatches: number;
  completedSegments: number;
  totalSegments: number;
}

export interface TranslateOptions {
  provider: TranslationProvider;
  targetLanguage: string;
  sourceLanguage?: string;
  instructions?: string;
  scope?: OfficeScopeOptions;
  batchSize?: number;
  maxBatchCharacters?: number;
  concurrency?: number;
  retries?: number;
  runDistribution?: RunDistribution;
  signal?: AbortSignal;
  onProgress?: (progress: TranslationProgress) => void;
  checkpoint?: TranslationCheckpoint;
  onCheckpoint?: (
    checkpoint: TranslationCheckpoint,
  ) => void | Promise<void>;
}

export interface InspectResult {
  format: OfficeFormat;
  partsScanned: number;
  segmentsFound: number;
  uniqueSegments: number;
  characters: number;
  skippedFieldParagraphs: number;
}

export interface TranslationStats extends InspectResult {
  partsChanged: number;
  outputBytes: number;
}

export interface BrowserTranslationResult {
  blob: Blob;
  fileName: string;
  stats: TranslationStats;
}

export class OfficeTranslationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OfficeTranslationError";
  }
}

interface ResolvedScope {
  includeComments: boolean;
  includeHeadersAndFooters: boolean;
  includeNotes: boolean;
  includeMasters: boolean;
  includeCharts: boolean;
  includeDiagrams: boolean;
}

interface XmlSpec {
  unitTag: string;
  textTag: string;
  kind: TextKind;
  scopeTag?: string;
  excludedAncestorTags?: string[];
  hardBreakTags?: string[];
  includeUnitPatterns?: RegExp[];
  excludeUnitPatterns?: RegExp[];
  rejectUnitPatterns?: RegExp[];
  excludeComplexWordFields?: boolean;
  fieldContentPatterns?: RegExp[];
}

interface XmlNode {
  start: number;
  end: number;
  openTag: string;
  closeTag: string;
  text: string;
  styleKey: string;
}

interface XmlSegment extends TranslationInputItem {
  leadingWhitespace: string;
  trailingWhitespace: string;
  nodes: XmlNode[];
}

interface XmlPartPlan {
  part: string;
  xml: string;
  segments: XmlSegment[];
  skippedFieldParagraphs: number;
}

interface PackagePlan {
  format: OfficeFormat;
  zip: JSZip;
  parts: XmlPartPlan[];
  skippedFieldParagraphs: number;
}

interface UniqueSegment {
  item: TranslationInputItem;
  occurrenceIds: string[];
}

const WORD_EXTENSIONS = new Set(["docx", "docm", "dotx", "dotm"]);
const POWERPOINT_EXTENSIONS = new Set([
  "pptx",
  "pptm",
  "potx",
  "potm",
  "ppsx",
  "ppsm",
]);
const EXCEL_EXTENSIONS = new Set(["xlsx", "xlsm", "xltx", "xltm"]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveScope(scope?: OfficeScopeOptions): ResolvedScope {
  return {
    includeComments: scope?.includeComments ?? true,
    includeHeadersAndFooters: scope?.includeHeadersAndFooters ?? true,
    includeNotes: scope?.includeNotes ?? false,
    includeMasters: scope?.includeMasters ?? false,
    includeCharts: scope?.includeCharts ?? true,
    includeDiagrams: scope?.includeDiagrams ?? true,
  };
}

function detectFormat(fileName: string): OfficeFormat {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (WORD_EXTENSIONS.has(extension)) {
    return "word";
  }
  if (POWERPOINT_EXTENSIONS.has(extension)) {
    return "powerpoint";
  }
  if (EXCEL_EXTENSIONS.has(extension)) {
    return "excel";
  }
  throw new OfficeTranslationError(
    "暂不支持该文件格式。请使用 DOCX、PPTX、XLSX 或对应的宏文件。",
  );
}

function wordParagraph(kind: TextKind): XmlSpec {
  return {
    unitTag: "w:p",
    textTag: "w:t",
    kind,
    excludedAncestorTags: ["w:fldSimple"],
    hardBreakTags: ["w:tab", "w:br", "w:cr", "w:fldChar", "w:fldSimple"],
    excludeComplexWordFields: true,
    fieldContentPatterns: [/<w:(?:instrText|fldChar|fldSimple)\b/u],
  };
}

function drawingParagraph(kind: TextKind): XmlSpec {
  return {
    unitTag: "a:p",
    textTag: "a:t",
    kind,
    excludedAncestorTags: ["a:fld"],
    hardBreakTags: ["a:br", "a:tab", "a:fld"],
    fieldContentPatterns: [/<a:fld\b/u],
  };
}

function chartSpecs(): XmlSpec[] {
  return [
    drawingParagraph("chart"),
    {
      scopeTag: "c:strCache",
      unitTag: "c:pt",
      textTag: "c:v",
      kind: "chart",
    },
    {
      scopeTag: "c:multiLvlStrCache",
      unitTag: "c:pt",
      textTag: "c:v",
      kind: "chart",
    },
  ];
}

function specsForPart(
  format: OfficeFormat,
  part: string,
  scope: ResolvedScope,
): XmlSpec[] | undefined {
  if (format === "word") {
    if (part === "word/document.xml") return [wordParagraph("body")];
    if (/^word\/header\d*\.xml$/u.test(part)) {
      return scope.includeHeadersAndFooters
        ? [wordParagraph("header")]
        : undefined;
    }
    if (/^word\/footer\d*\.xml$/u.test(part)) {
      return scope.includeHeadersAndFooters
        ? [wordParagraph("footer")]
        : undefined;
    }
    if (part === "word/footnotes.xml") return [wordParagraph("footnote")];
    if (part === "word/endnotes.xml") return [wordParagraph("endnote")];
    if (part === "word/comments.xml") {
      return scope.includeComments ? [wordParagraph("comment")] : undefined;
    }
    if (part === "word/glossary/document.xml") {
      return [wordParagraph("body")];
    }
    if (/^word\/diagrams\/data\d+\.xml$/u.test(part)) {
      return scope.includeDiagrams
        ? [drawingParagraph("diagram")]
        : undefined;
    }
    if (/^word\/charts\/chart\d+\.xml$/u.test(part)) {
      return scope.includeCharts ? chartSpecs() : undefined;
    }
    return undefined;
  }

  if (format === "powerpoint") {
    if (/^ppt\/slides\/slide\d+\.xml$/u.test(part)) {
      return [drawingParagraph("body")];
    }
    if (/^ppt\/notesSlides\/notesSlide\d+\.xml$/u.test(part)) {
      return scope.includeNotes
        ? [drawingParagraph("speaker-note")]
        : undefined;
    }
    if (
      /^ppt\/(?:slideMasters|slideLayouts)\/(?:slideMaster|slideLayout)\d+\.xml$/u.test(
        part,
      )
    ) {
      return scope.includeMasters
        ? [drawingParagraph("master")]
        : undefined;
    }
    if (/^ppt\/diagrams\/data\d+\.xml$/u.test(part)) {
      return scope.includeDiagrams
        ? [drawingParagraph("diagram")]
        : undefined;
    }
    if (/^ppt\/charts\/chart\d+\.xml$/u.test(part)) {
      return scope.includeCharts ? chartSpecs() : undefined;
    }
    return undefined;
  }

  if (part === "xl/sharedStrings.xml") {
    return [
      {
        unitTag: "si",
        textTag: "t",
        kind: "cell",
        excludedAncestorTags: ["rPh"],
      },
    ];
  }
  if (/^xl\/worksheets\/sheet\d+\.xml$/u.test(part)) {
    return [
      {
        unitTag: "is",
        textTag: "t",
        kind: "cell",
        excludedAncestorTags: ["rPh"],
      },
      {
        unitTag: "c",
        textTag: "v",
        kind: "cell",
        includeUnitPatterns: [
          /^<c(?=[\s>])[^>]*\bt\s*=\s*(["'])str\1/u,
        ],
        excludeUnitPatterns: [/<f(?=[\s>])/u],
      },
    ];
  }
  if (/^xl\/comments\d+\.xml$/u.test(part)) {
    return scope.includeComments
      ? [{ unitTag: "text", textTag: "t", kind: "comment" }]
      : undefined;
  }
  if (/^xl\/drawings\/drawing\d+\.xml$/u.test(part)) {
    return scope.includeDiagrams
      ? [drawingParagraph("drawing")]
      : undefined;
  }
  if (/^xl\/charts\/chart\d+\.xml$/u.test(part)) {
    return scope.includeCharts ? chartSpecs() : undefined;
  }
  return undefined;
}

function elementRanges(
  xml: string,
  tag: string,
  baseOffset = 0,
): Array<{ start: number; xml: string }> {
  const escaped = escapeRegExp(tag);
  const expression = new RegExp(
    "<" +
      escaped +
      "(?=[\\s>])[^>]*>[\\s\\S]*?<\\/" +
      escaped +
      "\\s*>",
    "g",
  );
  return Array.from(xml.matchAll(expression), (match) => ({
    start: baseOffset + match.index,
    xml: match[0],
  }));
}

function decodeXml(value: string): string {
  return value.replace(
    /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/giu,
    (entity) => {
      const normalized = entity.toLowerCase();
      if (normalized === "&amp;") return "&";
      if (normalized === "&lt;") return "<";
      if (normalized === "&gt;") return ">";
      if (normalized === "&quot;") return '"';
      if (normalized === "&apos;") return "'";
      const hexadecimal = /^&#x([0-9a-f]+);$/iu.exec(entity);
      if (hexadecimal?.[1]) {
        return String.fromCodePoint(Number.parseInt(hexadecimal[1], 16));
      }
      const decimal = /^&#(\d+);$/u.exec(entity);
      return decimal?.[1]
        ? String.fromCodePoint(Number.parseInt(decimal[1], 10))
        : entity;
    },
  );
}

function encodeXml(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function insideExcludedAncestor(
  unitXml: string,
  position: number,
  tags?: string[],
): boolean {
  const before = unitXml.slice(0, position);
  return (
    tags?.some(
      (tag) =>
        before.lastIndexOf("<" + tag) > before.lastIndexOf("</" + tag),
    ) ?? false
  );
}

function insideComplexWordField(unitXml: string, position: number): boolean {
  let depth = 0;
  const expression = /<w:fldChar(?=[\s/>])[^>]*>/gu;
  for (const match of unitXml.slice(0, position).matchAll(expression)) {
    const type = /\bw:fldCharType\s*=\s*(["'])(.*?)\1/iu.exec(
      match[0],
    )?.[2];
    if (type === "begin") depth += 1;
    else if (type === "end") depth = Math.max(0, depth - 1);
  }
  return depth > 0;
}

function containingRunStyle(
  unitXml: string,
  position: number,
  textTag: string,
): string {
  const separator = textTag.indexOf(":");
  const prefix = separator < 0 ? "" : textTag.slice(0, separator + 1);
  const runTag = prefix + "r";
  const escapedRun = escapeRegExp(runTag);
  const before = unitXml.slice(0, position);
  let openStart = -1;
  for (const match of before.matchAll(
    new RegExp("<" + escapedRun + "(?=[\\s>])[^>]*>", "gu"),
  )) {
    openStart = match.index;
  }
  let closeStart = -1;
  for (const match of before.matchAll(
    new RegExp("</" + escapedRun + "(?=[\\s>])", "gu"),
  )) {
    closeStart = match.index;
  }
  if (openStart <= closeStart) return "";

  const runEnd = unitXml.indexOf("</" + runTag, position);
  if (openStart < 0 || runEnd < 0) return "";
  const runXml = unitXml.slice(openStart, runEnd);
  const propertiesTag = prefix + "rPr";
  const escapedProperties = escapeRegExp(propertiesTag);
  const properties = new RegExp(
    "<" +
      escapedProperties +
      "(?=[\\s/>])(?:[^>]*\\/\\s*>|[^>]*>[\\s\\S]*?<\\/" +
      escapedProperties +
      "\\s*>)",
    "u",
  ).exec(runXml)?.[0];
  return properties?.replace(/\s+/gu, " ").trim() ?? "";
}

function findTextNodes(
  unit: { start: number; xml: string },
  tag: string,
  excludedAncestorTags?: string[],
  excludeComplexWordFields = false,
): XmlNode[] {
  const escaped = escapeRegExp(tag);
  const expression = new RegExp(
    "<" +
      escaped +
      "(?=[\\s/>])([^>]*?)(?:\\/\\s*>|>([\\s\\S]*?)<\\/" +
      escaped +
      "\\s*>)",
    "g",
  );
  const nodes: XmlNode[] = [];
  for (const match of unit.xml.matchAll(expression)) {
    if (
      insideExcludedAncestor(
        unit.xml,
        match.index,
        excludedAncestorTags,
      ) ||
      (excludeComplexWordFields &&
        insideComplexWordField(unit.xml, match.index))
    ) {
      continue;
    }
    const attributes = match[1] ?? "";
    nodes.push({
      start: unit.start + match.index,
      end: unit.start + match.index + match[0].length,
      openTag: "<" + tag + attributes + ">",
      closeTag: "</" + tag + ">",
      text: match[2] === undefined ? "" : decodeXml(match[2]),
      styleKey: containingRunStyle(unit.xml, match.index, tag),
    });
  }
  return nodes;
}

function hasHardBreak(xml: string, tags?: string[]): boolean {
  return (
    tags?.some((tag) =>
      new RegExp("<" + escapeRegExp(tag) + "(?=[\\s/>])").test(xml),
    ) ?? false
  );
}

function groupNodes(
  unitXml: string,
  unitStart: number,
  nodes: XmlNode[],
  hardBreakTags?: string[],
): XmlNode[][] {
  if (!nodes.length) return [];
  if (!hardBreakTags?.length) return [nodes];
  const groups: XmlNode[][] = [];
  let current: XmlNode[] = [];
  for (const node of nodes) {
    const previous = current.at(-1);
    if (
      previous &&
      hasHardBreak(
        unitXml.slice(previous.end - unitStart, node.start - unitStart),
        hardBreakTags,
      )
    ) {
      groups.push(current);
      current = [];
    }
    current.push(node);
  }
  if (current.length) groups.push(current);
  return groups;
}

function shouldTranslate(value: string): boolean {
  if (!/\p{L}/u.test(value)) return false;
  if (/^(?:https?:\/\/|mailto:|www\.)\S+$/iu.test(value)) return false;
  if (/^[\[{<(]{1,2}[\w.-]+[\]}>)]{1,2}$/u.test(value)) return false;
  if (/^%[\w.-]+%$/u.test(value)) return false;
  return true;
}

function planXmlPart(
  xml: string,
  part: string,
  format: OfficeFormat,
  specs: XmlSpec[],
): XmlPartPlan {
  const segments: XmlSegment[] = [];
  let skippedFieldParagraphs = 0;
  for (const spec of specs) {
    const scopes = spec.scopeTag
      ? elementRanges(xml, spec.scopeTag)
      : [{ start: 0, xml }];
    for (const scope of scopes) {
      for (const unit of elementRanges(scope.xml, spec.unitTag, scope.start)) {
        if (
          spec.includeUnitPatterns?.some((pattern) => !pattern.test(unit.xml)) ||
          spec.excludeUnitPatterns?.some((pattern) => pattern.test(unit.xml))
        ) {
          continue;
        }
        if (
          spec.rejectUnitPatterns?.some((pattern) => pattern.test(unit.xml))
        ) {
          skippedFieldParagraphs += 1;
          continue;
        }
        if (
          spec.fieldContentPatterns?.some((pattern) => pattern.test(unit.xml))
        ) {
          skippedFieldParagraphs += 1;
        }
        const nodes = findTextNodes(
          unit,
          spec.textTag,
          spec.excludedAncestorTags,
          spec.excludeComplexWordFields,
        );
        for (const group of groupNodes(
          unit.xml,
          unit.start,
          nodes,
          spec.hardBreakTags,
        )) {
          const combined = group.map((node) => node.text).join("");
          const leading = combined.match(/^\s*/u)?.[0] ?? "";
          const remainder = combined.slice(leading.length);
          const trailing = remainder.match(/\s*$/u)?.[0] ?? "";
          const text = remainder.slice(0, remainder.length - trailing.length);
          if (!shouldTranslate(text)) continue;
          segments.push({
            id: part + "#" + segments.length,
            text,
            context: { format, part, kind: spec.kind },
            leadingWhitespace: leading,
            trailingWhitespace: trailing,
            nodes: group,
          });
        }
      }
    }
  }
  segments.sort((left, right) => left.nodes[0]!.start - right.nodes[0]!.start);
  return { part, xml, segments, skippedFieldParagraphs };
}

interface XmlRange {
  start: number;
  end: number;
  xml: string;
  openTag: string;
}

interface CellContextData {
  sheetName?: string;
  cellReference?: string;
  rowNumber: number;
  columnName?: string;
  columnHeader?: string;
  tableIndex?: number;
  tableRole: "header" | "body";
  tableHeaders: string[];
  rowContext: string[];
}

function pairedTagRanges(xml: string, tag: string): XmlRange[] {
  const expression = new RegExp(
    "<(/?)" + escapeRegExp(tag) + "(?=[\\s>])[^>]*>",
    "gu",
  );
  const stack: Array<{ start: number; openTag: string }> = [];
  const ranges: XmlRange[] = [];
  for (const match of xml.matchAll(expression)) {
    const closing = match[1] === "/";
    if (!closing && /\/\s*>$/u.test(match[0])) continue;
    if (!closing) {
      stack.push({ start: match.index, openTag: match[0] });
      continue;
    }
    const opening = stack.pop();
    if (!opening) continue;
    const end = match.index + match[0].length;
    ranges.push({
      start: opening.start,
      end,
      xml: xml.slice(opening.start, end),
      openTag: opening.openTag,
    });
  }
  return ranges.sort((left, right) => left.start - right.start);
}

function attributeValue(openTag: string, name: string): string | undefined {
  const match = new RegExp(
    "(?:^|\\s)" + escapeRegExp(name) + "\\s*=\\s*([\"'])(.*?)\\1",
    "u",
  ).exec(openTag);
  return match?.[2] === undefined ? undefined : decodeXml(match[2]);
}

function textFromXml(xml: string, tag: string): string {
  return findTextNodes({ start: 0, xml }, tag)
    .map((node) => node.text)
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
}

function compactContextText(value: string, maximum = 160): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length <= maximum
    ? compact
    : compact.slice(0, Math.max(1, maximum - 1)) + "…";
}

function containingRange<T extends XmlRange>(
  ranges: T[],
  position: number,
): T | undefined {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (ranges[middle]!.start <= position) low = middle + 1;
    else high = middle;
  }
  for (let index = low - 1; index >= 0; index -= 1) {
    const range = ranges[index]!;
    if (position < range.end) return range;
  }
  return undefined;
}

function directChildren<T extends XmlRange>(
  children: T[],
  parents: XmlRange[],
  parent: XmlRange,
): T[] {
  return children.filter(
    (child) => containingRange(parents, child.start) === parent,
  );
}

function enrichWordTableContexts(parts: XmlPartPlan[]): void {
  for (const part of parts) {
    if (!part.part.startsWith("word/") || !part.xml.includes("<w:tbl")) {
      continue;
    }
    const tables = pairedTagRanges(part.xml, "w:tbl");
    const rows = pairedTagRanges(part.xml, "w:tr");
    const cells = pairedTagRanges(part.xml, "w:tc");
    const cellContexts = new Map<XmlRange, CellContextData>();

    tables.forEach((table, tableIndex) => {
      const tableRows = directChildren(rows, tables, table);
      const headerRow =
        tableRows.find((row) => /<w:tblHeader(?=[\s/>])/u.test(row.xml)) ??
        tableRows[0];
      const headerCells = headerRow
        ? directChildren(cells, rows, headerRow)
        : [];
      const headers = headerCells
        .map((cell) => compactContextText(textFromXml(cell.xml, "w:t"), 100))
        .filter(Boolean)
        .slice(0, 8);

      tableRows.forEach((row, rowIndex) => {
        const rowCells = directChildren(cells, rows, row);
        const values = rowCells.map((cell) =>
          compactContextText(textFromXml(cell.xml, "w:t")),
        );
        rowCells.forEach((cell, columnIndex) => {
          const rowContext = values
            .map((value, index) => {
              if (!value || index === columnIndex) return "";
              const header = headers[index];
              return compactContextText(
                header ? header + ": " + value : value,
              );
            })
            .filter(Boolean)
            .slice(0, 4);
          cellContexts.set(cell, {
            rowNumber: rowIndex + 1,
            columnName: String(columnIndex + 1),
            ...(headers[columnIndex]
              ? { columnHeader: headers[columnIndex] }
              : {}),
            tableIndex: tableIndex + 1,
            tableRole: row === headerRow ? "header" : "body",
            tableHeaders: headers,
            rowContext,
          });
        });
      });
    });

    for (const segment of part.segments) {
      const cell = containingRange(cells, segment.nodes[0]!.start);
      const data = cell && cellContexts.get(cell);
      if (!data) continue;
      segment.context = {
        ...segment.context,
        ...data,
        location: `表格 ${data.tableIndex} · 第 ${data.rowNumber} 行 · 第 ${data.columnName} 列`,
      };
    }
  }
}

function normalizedRelationshipTarget(target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  if (target.startsWith("xl/")) return target;
  const pieces = ("xl/" + target).split("/");
  const normalized: string[] = [];
  for (const piece of pieces) {
    if (!piece || piece === ".") continue;
    if (piece === "..") normalized.pop();
    else normalized.push(piece);
  }
  return normalized.join("/");
}

function columnNameFromReference(reference: string): string | undefined {
  return /^([A-Z]+)\d+$/iu.exec(reference)?.[1]?.toUpperCase();
}

function rowNumberFromReference(reference: string): number | undefined {
  const value = /^(?:[A-Z]+)(\d+)$/iu.exec(reference)?.[1];
  return value ? Number.parseInt(value, 10) : undefined;
}

async function excelSheetNames(zip: JSZip): Promise<Map<string, string>> {
  const workbookEntry = zip.file("xl/workbook.xml");
  const relationshipsEntry = zip.file("xl/_rels/workbook.xml.rels");
  if (!workbookEntry) return new Map();
  const workbook = await workbookEntry.async("string");
  const relationships = relationshipsEntry
    ? await relationshipsEntry.async("string")
    : "";
  const pathsByRelationship = new Map<string, string>();
  for (const match of relationships.matchAll(/<Relationship(?=[\s>])[^>]*\/?>/gu)) {
    const id = attributeValue(match[0], "Id");
    const target = attributeValue(match[0], "Target");
    if (id && target) {
      pathsByRelationship.set(id, normalizedRelationshipTarget(target));
    }
  }

  const result = new Map<string, string>();
  let fallbackIndex = 0;
  for (const match of workbook.matchAll(/<sheet(?=[\s>])[^>]*\/?>/gu)) {
    fallbackIndex += 1;
    const name = attributeValue(match[0], "name") ?? `Sheet${fallbackIndex}`;
    const relationshipId = attributeValue(match[0], "r:id");
    const path = relationshipId
      ? pathsByRelationship.get(relationshipId)
      : undefined;
    result.set(path ?? `xl/worksheets/sheet${fallbackIndex}.xml`, name);
  }
  return result;
}

async function enrichExcelTableContexts(
  zip: JSZip,
  parts: XmlPartPlan[],
): Promise<void> {
  const partByPath = new Map(parts.map((part) => [part.part, part]));
  const sharedPart = partByPath.get("xl/sharedStrings.xml");
  const sharedRanges = sharedPart
    ? pairedTagRanges(sharedPart.xml, "si")
    : [];
  const sharedRangeIndexes = new Map(
    sharedRanges.map((range, index) => [range, index]),
  );
  const sharedTexts = sharedRanges.map((range) => textFromXml(range.xml, "t"));
  const sharedUsages = new Map<number, CellContextData[]>();
  const sheetNames = await excelSheetNames(zip);

  for (const [sheetPath, sheetName] of sheetNames) {
    const entry = zip.file(sheetPath);
    if (!entry) continue;
    const sheetXml = await entry.async("string");
    const cellRanges = pairedTagRanges(sheetXml, "c");
    const cells = cellRanges
      .map((range) => {
        const reference = attributeValue(range.openTag, "r") ?? "";
        const type = attributeValue(range.openTag, "t");
        const rawValue = textFromXml(range.xml, "v");
        const sharedIndex =
          type === "s" && /^\d+$/u.test(rawValue)
            ? Number.parseInt(rawValue, 10)
            : undefined;
        const value =
          sharedIndex !== undefined
            ? sharedTexts[sharedIndex] ?? ""
            : type === "inlineStr"
              ? textFromXml(range.xml, "t")
              : type === "str"
                ? rawValue
                : "";
        return {
          range,
          reference,
          columnName: columnNameFromReference(reference),
          rowNumber: rowNumberFromReference(reference),
          sharedIndex,
          value: compactContextText(value),
        };
      })
      .filter((cell) => cell.rowNumber !== undefined);
    const rows = new Map<number, typeof cells>();
    for (const cell of cells) {
      const row = rows.get(cell.rowNumber!) ?? [];
      row.push(cell);
      rows.set(cell.rowNumber!, row);
    }
    const orderedRows = [...rows.entries()].sort(([left], [right]) => left - right);
    const autoFilterTag = /<autoFilter(?=[\s>])[^>]*\/?>/u.exec(sheetXml)?.[0];
    const autoFilterStart = autoFilterTag
      ? rowNumberFromReference(
          (attributeValue(autoFilterTag, "ref") ?? "").split(":")[0] ?? "",
        )
      : undefined;
    const headerEntry =
      (autoFilterStart !== undefined
        ? orderedRows.find(([rowNumber]) => rowNumber === autoFilterStart)
        : undefined) ??
      orderedRows
        .slice(0, 12)
        .find(
          ([, row]) =>
            row.filter((cell) => shouldTranslate(cell.value)).length >= 2,
        ) ??
      orderedRows.find(([, row]) =>
        row.some((cell) => shouldTranslate(cell.value)),
      );
    const headerRowNumber = headerEntry?.[0];
    const headersByColumn = new Map(
      (headerEntry?.[1] ?? [])
        .filter((cell) => cell.columnName && cell.value)
        .map((cell) => [cell.columnName!, compactContextText(cell.value, 100)]),
    );
    const headers = [...headersByColumn.values()].slice(0, 8);
    const contextByRange = new Map<XmlRange, CellContextData>();

    for (const [, row] of orderedRows) {
      for (const cell of row) {
        const rowContext = row
          .filter((neighbor) => neighbor !== cell && neighbor.value)
          .map((neighbor) => {
            const header = neighbor.columnName
              ? headersByColumn.get(neighbor.columnName)
              : undefined;
            return compactContextText(
              header ? header + ": " + neighbor.value : neighbor.value,
            );
          })
          .slice(0, 4);
        const data: CellContextData = {
          sheetName,
          cellReference: cell.reference,
          rowNumber: cell.rowNumber!,
          ...(cell.columnName ? { columnName: cell.columnName } : {}),
          ...(cell.columnName && headersByColumn.get(cell.columnName)
            ? { columnHeader: headersByColumn.get(cell.columnName)! }
            : {}),
          tableRole: cell.rowNumber === headerRowNumber ? "header" : "body",
          tableHeaders: headers,
          rowContext,
        };
        contextByRange.set(cell.range, data);
        if (cell.sharedIndex !== undefined) {
          const usages = sharedUsages.get(cell.sharedIndex) ?? [];
          usages.push(data);
          sharedUsages.set(cell.sharedIndex, usages);
        }
      }
    }

    const plannedSheet = partByPath.get(sheetPath);
    if (plannedSheet) {
      for (const segment of plannedSheet.segments) {
        const cell = containingRange(cellRanges, segment.nodes[0]!.start);
        const data = cell && contextByRange.get(cell);
        if (!data) continue;
        segment.context = {
          ...segment.context,
          ...data,
          location: `${sheetName}!${data.cellReference}`,
        };
      }
    }
  }

  if (!sharedPart) return;
  for (const segment of sharedPart.segments) {
    const sharedRange = containingRange(sharedRanges, segment.nodes[0]!.start);
    const sharedIndex = sharedRange
      ? sharedRangeIndexes.get(sharedRange) ?? -1
      : -1;
    const usages = sharedUsages.get(sharedIndex) ?? [];
    const primary = usages[0];
    if (!primary) continue;
    const usageLocations = [
      ...new Set(
        usages.map((usage) => `${usage.sheetName}!${usage.cellReference}`),
      ),
    ].slice(0, 5);
    segment.context = {
      ...segment.context,
      ...primary,
      location: usageLocations[0]!,
      usageLocations,
      tableHeaders: [
        ...new Set(usages.flatMap((usage) => usage.tableHeaders)),
      ].slice(0, 8),
      rowContext: [
        ...new Set(usages.flatMap((usage) => usage.rowContext)),
      ].slice(0, 4),
    };
  }
}

async function enrichTableContexts(plan: PackagePlan): Promise<void> {
  if (plan.format === "word") enrichWordTableContexts(plan.parts);
  if (plan.format === "excel") {
    await enrichExcelTableContexts(plan.zip, plan.parts);
  }
}

function requiredPart(format: OfficeFormat): string {
  if (format === "word") return "word/document.xml";
  if (format === "powerpoint") return "ppt/presentation.xml";
  return "xl/workbook.xml";
}

async function planPackage(
  bytes: ArrayBuffer,
  fileName: string,
  scopeOptions?: OfficeScopeOptions,
): Promise<PackagePlan> {
  const format = detectFormat(fileName);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (error) {
    throw new OfficeTranslationError(
      "无法打开文件。加密、损坏或旧版二进制 Office 文件暂不支持。",
      { cause: error },
    );
  }
  if (!zip.file("[Content_Types].xml") || !zip.file(requiredPart(format))) {
    throw new OfficeTranslationError("文件内容与扩展名不匹配或不是有效的 Office 文件。");
  }

  const scope = resolveScope(scopeOptions);
  const parts: XmlPartPlan[] = [];
  for (const part of Object.keys(zip.files).sort()) {
    const specs = specsForPart(format, part, scope);
    const entry = zip.file(part);
    if (!specs?.length || !entry) continue;
    parts.push(planXmlPart(await entry.async("string"), part, format, specs));
  }
  const plan: PackagePlan = {
    format,
    zip,
    parts,
    skippedFieldParagraphs: parts.reduce(
      (sum, part) => sum + part.skippedFieldParagraphs,
      0,
    ),
  };
  await enrichTableContexts(plan);
  return plan;
}

function graphemes(value: string): string[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return Array.from(segmenter.segment(value), (entry) => entry.segment);
}

interface StyleGroup {
  indices: number[];
  sourceText: string;
  styleKey: string;
  weight: number;
}

function styleGroups(nodes: XmlNode[]): StyleGroup[] {
  const groups: StyleGroup[] = [];
  nodes.forEach((node, index) => {
    const weight = graphemes(node.text).length;
    if (!weight) return;
    const previous = groups.at(-1);
    if (previous?.styleKey === node.styleKey) {
      previous.indices.push(index);
      previous.sourceText += node.text;
      previous.weight += weight;
      return;
    }
    groups.push({
      indices: [index],
      sourceText: node.text,
      styleKey: node.styleKey,
      weight,
    });
  });
  if (!groups.length && nodes.length) {
    groups.push({
      indices: [0],
      sourceText: "",
      styleKey: nodes[0]!.styleKey,
      weight: 1,
    });
  }
  return groups;
}

function dominantStyleGroup(groups: StyleGroup[]): StyleGroup {
  const weights = new Map<string, number>();
  for (const group of groups) {
    weights.set(group.styleKey, (weights.get(group.styleKey) ?? 0) + group.weight);
  }
  let dominant = groups[0]!;
  let dominantWeight = weights.get(dominant.styleKey) ?? dominant.weight;
  for (const group of groups.slice(1)) {
    const weight = weights.get(group.styleKey) ?? group.weight;
    if (weight > dominantWeight) {
      dominant = group;
      dominantWeight = weight;
    }
  }
  return dominant;
}

function distributeStyleAware(value: string, nodes: XmlNode[]): string[] {
  const result = nodes.map(() => "");
  const groups = styleGroups(nodes);
  if (!groups.length) return result;
  if (groups.length === 1) {
    result[groups[0]!.indices[0]!] = value;
    return result;
  }

  let sourcePrefix = "";
  let labelGroupEnd = -1;
  for (let index = 0; index < groups.length - 1; index += 1) {
    sourcePrefix += groups[index]!.sourceText;
    if (/[:：]\s*$/u.test(sourcePrefix)) {
      labelGroupEnd = index;
      break;
    }
  }

  const leading = value.match(/^\s*/u)?.[0] ?? "";
  const remainder = value.slice(leading.length);
  const trailing = remainder.match(/\s*$/u)?.[0] ?? "";
  const core = remainder.slice(0, remainder.length - trailing.length);
  const translatedDelimiter = core.search(/[:：]/u);
  if (
    labelGroupEnd >= 0 &&
    translatedDelimiter >= 0 &&
    core.slice(translatedDelimiter + 1).trim()
  ) {
    const labelTarget = dominantStyleGroup(
      groups.slice(0, labelGroupEnd + 1),
    ).indices[0]!;
    const bodyTarget = dominantStyleGroup(
      groups.slice(labelGroupEnd + 1),
    ).indices[0]!;
    result[labelTarget] = leading + core.slice(0, translatedDelimiter + 1);
    result[bodyTarget] = core.slice(translatedDelimiter + 1) + trailing;
    return result;
  }

  result[dominantStyleGroup(groups).indices[0]!] = value;
  return result;
}

function distribute(
  value: string,
  nodes: XmlNode[],
  mode: RunDistribution,
): string[] {
  const result = nodes.map(() => "");
  if (mode === "style-aware") {
    return distributeStyleAware(value, nodes);
  }
  const populated = nodes
    .map((node, index) => ({ index, weight: graphemes(node.text).length }))
    .filter((entry) => entry.weight > 0);
  const targets = populated.length ? populated : [{ index: 0, weight: 1 }];
  if (mode === "first" || targets.length === 1) {
    result[targets[0]!.index] = value;
    return result;
  }
  const output = graphemes(value);
  const totalWeight = targets.reduce((sum, entry) => sum + entry.weight, 0);
  let outputStart = 0;
  let cumulativeWeight = 0;
  targets.forEach((entry, index) => {
    cumulativeWeight += entry.weight;
    const outputEnd =
      index === targets.length - 1
        ? output.length
        : Math.round((cumulativeWeight / totalWeight) * output.length);
    result[entry.index] = output.slice(outputStart, outputEnd).join("");
    outputStart = outputEnd;
  });
  return result;
}

function renderNode(node: XmlNode, value: string): string {
  let openTag = node.openTag;
  if (
    value.length > 0 &&
    (/^\s/u.test(value) || /\s$/u.test(value)) &&
    !/\bxml:space\s*=/u.test(openTag)
  ) {
    openTag = openTag.replace(/>$/u, ' xml:space="preserve">');
  }
  return openTag + encodeXml(value) + node.closeTag;
}

function applyPart(
  part: XmlPartPlan,
  translations: ReadonlyMap<string, string>,
  mode: RunDistribution,
): { xml: string; changed: boolean } {
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  for (const segment of part.segments) {
    const translated = translations.get(segment.id);
    if (translated === undefined || translated === segment.text) continue;
    const complete =
      segment.leadingWhitespace +
      translated +
      segment.trailingWhitespace;
    const pieces = distribute(complete, segment.nodes, mode);
    segment.nodes.forEach((node, index) => {
      replacements.push({
        start: node.start,
        end: node.end,
        value: renderNode(node, pieces[index] ?? ""),
      });
    });
  }
  if (!replacements.length) return { xml: part.xml, changed: false };
  replacements.sort((left, right) => right.start - left.start);
  let xml = part.xml;
  for (const replacement of replacements) {
    xml =
      xml.slice(0, replacement.start) +
      replacement.value +
      xml.slice(replacement.end);
  }
  return { xml, changed: true };
}

function translationDedupeKey(item: TranslationInputItem): string {
  const contextDiscriminator =
    item.text.length <= 80
      ? item.context.columnHeader ?? item.context.tableHeaders?.join("|") ?? ""
      : "";
  return item.text + "\u0000" + contextDiscriminator;
}

function uniqueSegments(items: TranslationInputItem[]): UniqueSegment[] {
  const byTextAndContext = new Map<string, UniqueSegment>();
  for (const item of items) {
    const key = translationDedupeKey(item);
    const existing = byTextAndContext.get(key);
    if (existing) {
      existing.occurrenceIds.push(item.id);
    } else {
      byTextAndContext.set(key, { item, occurrenceIds: [item.id] });
    }
  }
  return [...byTextAndContext.values()];
}

function glossaryCandidates(items: TranslationInputItem[]): TranslationInputItem[] {
  const firstByText = new Map<string, TranslationInputItem>();
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const value of [
      item.context.columnHeader,
      ...(item.context.tableHeaders ?? []),
    ]) {
      if (!value || !shouldTranslate(value)) continue;
      const text = compactContextText(value, 100);
      if (!firstByText.has(text)) {
        firstByText.set(text, { ...item, text });
      }
    }
    if (item.text.length <= 64) {
      counts.set(item.text, (counts.get(item.text) ?? 0) + 1);
      if (!firstByText.has(item.text)) firstByText.set(item.text, item);
    }
  }
  const headers = new Set(
    items.flatMap((item) => [
      item.context.columnHeader,
      ...(item.context.tableHeaders ?? []),
    ]).filter((value): value is string => Boolean(value)),
  );
  return [...firstByText]
    .filter(([text]) => headers.has(text) || (counts.get(text) ?? 0) >= 3)
    .slice(0, 16)
    .map(([text, item], index) => ({
      ...item,
      id: `document-glossary:${index}`,
      text,
    }));
}

async function buildDocumentGlossary(
  items: TranslationInputItem[],
  options: TranslateOptions,
): Promise<string> {
  const candidates = glossaryCandidates(items);
  if (!candidates.length) return "";
  const report = (
    completedBatches: number,
    submittedBatches: number,
    respondingBatches: number,
  ) => {
    options.onProgress?.({
      stage: "glossary",
      completedBatches,
      submittedBatches,
      respondingBatches,
      totalBatches: 1,
      translatedSegments: completedBatches ? candidates.length : 0,
      totalSegments: candidates.length,
      percentage: completedBatches ? 100 : 0,
    });
  };
  report(0, 0, 0);
  const request: TranslationBatchRequest = {
    targetLanguage: options.targetLanguage,
    instructions: [
      options.instructions,
      "DOCUMENT GLOSSARY PASS: Translate every term concisely and consistently.",
      "Return only the target-language equivalent for each item. Preserve technical identifiers, acronyms, standards, model names, numbers and versions.",
    ]
      .filter(Boolean)
      .join("\n"),
    items: candidates,
  };
  if (options.sourceLanguage && options.sourceLanguage !== "auto") {
    request.sourceLanguage = options.sourceLanguage;
  }
  report(0, 1, 0);
  let responding = false;
  try {
    const output = await translateProviderBatchWithRetry(
      options.provider,
      request,
      options.signal,
      () => {
        if (!responding) {
          responding = true;
          report(0, 1, 1);
        }
      },
      {
        baseDelayMs: 400,
        maxDelayMs: 2_000,
        maxRetries: options.retries ?? 2,
      },
    );
    const expected = candidates.map((item) => ({
      item,
      occurrenceIds: [item.id],
    }));
    const translated = validateOutput(expected, output);
    const entries = candidates
      .map((candidate) => [
        candidate.text,
        translated.get(candidate.id) ?? "",
      ] as const)
      .filter(
        ([source, target]) =>
          normalizedText(source) !== normalizedText(target) &&
          !needsQualityRetry(source, target, options.targetLanguage),
      );
    report(1, 1, 0);
    if (!entries.length) return "";
    return [
      "DOCUMENT GLOSSARY (use these exact equivalents consistently whenever the source term appears):",
      ...entries.map(([source, target]) => `- ${JSON.stringify(source)} => ${JSON.stringify(target)}`),
    ].join("\n");
  } catch {
    assertNotAborted(options.signal);
    return "";
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("翻译已取消", "AbortError");
  }
}

function validateOutput(
  expected: UniqueSegment[],
  output: TranslationOutputItem[],
): Map<string, string> {
  if (!Array.isArray(output)) {
    throw new OfficeTranslationError("大模型服务返回了无法识别的数据。");
  }
  const result = new Map<string, string>();
  for (const item of output) {
    if (
      typeof item?.id !== "string" ||
      typeof item?.text !== "string" ||
      result.has(item.id)
    ) {
      throw new OfficeTranslationError("大模型服务返回的 id 或文本格式不正确。");
    }
    result.set(item.id, item.text);
  }
  for (const entry of expected) {
    const translated = result.get(entry.item.id);
    if (translated === undefined || (!translated.trim() && entry.item.text.trim())) {
      throw new OfficeTranslationError(
        "大模型服务遗漏了文本片段：" + entry.item.id,
      );
    }
  }
  return result;
}

function naturalEnglishWords(value: string): string[] {
  return Array.from(
    value.matchAll(/\b(?:[A-Z][a-z]{2,}|[a-z]{3,})\b/gu),
    (match) => match[0].toLocaleLowerCase(),
  );
}

function normalizedText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function isLikelyModelDesignation(value: string): boolean {
  const words = naturalEnglishWords(value);
  if (words.length > 1 || /[.!?。！？,，;；]/u.test(value)) return false;

  const tokens = value.split(/\s+/u);
  const hasRangeCode = tokens.some(
    (token) =>
      token.includes("/") &&
      /[A-Za-z]/u.test(token) &&
      /\d/u.test(token) &&
      /^[A-Za-z\d/_.+-]+$/u.test(token),
  );
  const hasModelCode = tokens.some(
    (token) =>
      !token.includes("/") &&
      /[A-Za-z]/u.test(token) &&
      /^[A-Za-z\d._+-]+$/u.test(token) &&
      (/\d/u.test(token) || /^[A-Z]{2,8}$/u.test(token)),
  );
  return hasRangeCode && hasModelCode;
}

function needsQualityRetry(
  source: string,
  translated: string,
  targetLanguage: string,
): boolean {
  const sourceText = normalizedText(source);
  const translatedText = normalizedText(translated);
  if (!sourceText || !translatedText) return false;

  if (/^en(?:\b|-|_)/iu.test(targetLanguage)) {
    return /\p{Script=Han}/u.test(translatedText);
  }

  if (/^zh(?:\b|-|_)/iu.test(targetLanguage)) {
    if (
      sourceText === translatedText &&
      isLikelyModelDesignation(sourceText)
    ) {
      return false;
    }
    const sourceWords = [...new Set(naturalEnglishWords(sourceText))];
    if (!sourceWords.length) return false;
    if (!/\p{Script=Han}/u.test(translatedText)) return true;
    const translatedLower = translatedText.toLocaleLowerCase();
    const retainedWords = sourceWords.filter((word) =>
      new RegExp("\\b" + escapeRegExp(word) + "\\b", "u").test(
        translatedLower,
      ),
    );
    return sourceWords.length >= 2 && retainedWords.length / sourceWords.length >= 0.6;
  }

  return false;
}

function browserTranslationPlanId(
  items: TranslationInputItem[],
  format: OfficeFormat,
): string {
  let hash = 2_166_136_261;
  for (const item of items) {
    const value =
      format +
      "\u0000" +
      item.id +
      "\u0000" +
      translationDedupeKey(item) +
      "\u0001";
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619);
    }
  }
  return `browser-office:${items.length}:${(hash >>> 0).toString(16)}`;
}

async function translateSegmentsWithCore(
  items: TranslationInputItem[],
  options: TranslateOptions,
  glossary: string,
  format: OfficeFormat,
): Promise<Map<string, string>> {
  const documentId = browserTranslationPlanId(items, format);
  const plan: CoreTranslationPlan<TranslationContext> = {
    schemaVersion: 1,
    document: { id: documentId, format },
    units: items.map((item) => ({
      ...item,
      dedupeKey: translationDedupeKey(item),
    })),
  };
  const sourceLanguage =
    options.sourceLanguage && options.sourceLanguage !== "auto"
      ? options.sourceLanguage
      : undefined;
  let currentProgress: CoreTranslationProgress = {
    activeBatches: 0,
    completedBatches: 0,
    retryingBatches: 0,
    totalBatches: 0,
    totalUnits: 0,
    translatedUnits: 0,
  };
  let submittedBatches = 0;
  const respondingBatchIndexes = new Set<number>();
  const providerRetries = new Map<
    number,
    {
      reason: "busy" | "format" | "request";
      retryAfterMs: number;
    }
  >();

  const emitProgress = (): void => {
    submittedBatches = Math.max(
      submittedBatches,
      currentProgress.completedBatches + currentProgress.activeBatches,
    );
    if (!currentProgress.activeBatches) {
      respondingBatchIndexes.clear();
      providerRetries.clear();
    }
    const lastRetry = currentProgress.lastRetry;
    const providerRetry = [...providerRetries.values()][0];
    const retryReason = providerRetry?.reason ??
      (lastRetry?.reason === "response" || lastRetry?.reason === "quality"
        ? "format"
        : lastRetry
          ? "request"
          : undefined);
    const retryAfterMs = providerRetry?.retryAfterMs ?? lastRetry?.delayMs;
    options.onProgress?.({
      stage: "translation",
      completedBatches: currentProgress.completedBatches,
      submittedBatches,
      respondingBatches: Math.min(
        respondingBatchIndexes.size,
        currentProgress.activeBatches,
      ),
      ...(currentProgress.retryingBatches
        ? {
            retryingBatches: currentProgress.retryingBatches,
            retryReason: retryReason ?? "request",
            retryAfterSeconds: Math.max(
              1,
              Math.ceil((retryAfterMs ?? 0) / 1_000),
            ),
          }
        : {}),
      totalBatches: currentProgress.totalBatches,
      translatedSegments: currentProgress.translatedUnits,
      totalSegments: currentProgress.totalUnits,
      percentage: currentProgress.totalUnits
        ? Math.round(
            (currentProgress.translatedUnits / currentProgress.totalUnits) *
              100,
          )
        : 100,
    });
  };

  const checkpoint: CoreTranslationCheckpoint | undefined =
    options.checkpoint?.version === 1
      ? {
          schemaVersion: 1,
          documentId,
          targetLanguage: options.targetLanguage,
          translations: options.checkpoint.translations,
          ...(sourceLanguage ? { sourceLanguage } : {}),
          ...(options.instructions
            ? { instructions: options.instructions }
            : {}),
        }
      : undefined;
  const result = await translatePlan(plan, {
    provider: options.provider,
    targetLanguage: options.targetLanguage,
    ...(sourceLanguage ? { sourceLanguage } : {}),
    ...(options.instructions ? { instructions: options.instructions } : {}),
    batchSize: options.batchSize ?? 4,
    maxBatchCharacters: options.maxBatchCharacters ?? 2_000,
    concurrency: options.concurrency ?? 1,
    retry: {
      baseDelayMs: 400,
      maxDelayMs: 2_000,
      maxRetries: options.retries ?? 2,
    },
    ...(options.signal ? { signal: options.signal } : {}),
    ...(checkpoint ? { checkpoint } : {}),
    qualityPolicy({ item, translatedText }) {
      if (!needsQualityRetry(item.text, translatedText, options.targetLanguage)) {
        return undefined;
      }
      return {
        issueCode: "source_text_unchanged",
        message: "大模型服务未完整翻译这段内容：" + item.text.slice(0, 80),
        retryInstruction: [
          "QUALITY RETRY: Translate every natural-language phrase in every item into the target language.",
          "Do not copy any source-language sentence or heading unchanged.",
          "Preserve only identifiers, acronyms, model names, standards, numbers and version strings.",
        ].join(" "),
      };
    },
    onProviderActivity(activity, batchIndex) {
      if (activity.phase === "retry") {
        respondingBatchIndexes.delete(batchIndex);
        providerRetries.set(batchIndex, {
          reason: activity.retryReason ?? "request",
          retryAfterMs: activity.retryAfterMs ?? 0,
        });
      } else {
        respondingBatchIndexes.add(batchIndex);
        providerRetries.delete(batchIndex);
      }
      emitProgress();
    },
    onProgress(progress) {
      currentProgress = progress;
      emitProgress();
    },
    ...(options.onCheckpoint
      ? {
          async onCheckpoint(value: CoreTranslationCheckpoint) {
            await options.onCheckpoint?.({
              version: 1,
              glossary,
              translations: value.translations,
              completedBatches: currentProgress.completedBatches,
              totalBatches: currentProgress.totalBatches,
              completedSegments: value.translations.length,
              totalSegments: currentProgress.totalUnits,
            });
          },
        }
      : {}),
  });
  return new Map(result.translations);
}

function inspection(plan: PackagePlan): InspectResult {
  const segments = plan.parts.flatMap((part) => part.segments);
  const unique = uniqueSegments(segments);
  return {
    format: plan.format,
    partsScanned: plan.parts.length,
    segmentsFound: segments.length,
    uniqueSegments: unique.length,
    characters: unique.reduce((sum, item) => sum + item.item.text.length, 0),
    skippedFieldParagraphs: plan.skippedFieldParagraphs,
  };
}

export async function inspectOfficeFile(
  file: File,
  scope?: OfficeScopeOptions,
): Promise<InspectResult> {
  const plan = await planPackage(await file.arrayBuffer(), file.name, scope);
  return inspection(plan);
}

function outputFileName(input: string, language: string): string {
  const dot = input.lastIndexOf(".");
  const safeLanguage = language.replace(/[^\p{L}\p{N}._-]+/gu, "-");
  return dot < 0
    ? input + "." + safeLanguage
    : input.slice(0, dot) + "." + safeLanguage + input.slice(dot);
}

export async function translateOfficeFileInBrowser(
  file: File,
  options: TranslateOptions,
): Promise<BrowserTranslationResult> {
  if (!options.targetLanguage.trim()) {
    throw new OfficeTranslationError("请选择目标语言。");
  }
  assertNotAborted(options.signal);
  const plan = await planPackage(
    await file.arrayBuffer(),
    file.name,
    options.scope,
  );
  const inspect = inspection(plan);
  if (!inspect.segmentsFound) {
    throw new OfficeTranslationError("文件中没有检测到可翻译文本。");
  }

  const segments = plan.parts.flatMap((part) => part.segments);
  const glossary =
    options.checkpoint?.version === 1
      ? options.checkpoint.glossary
      : await buildDocumentGlossary(segments, options);
  const translations = await translateSegmentsWithCore(segments, {
    ...options,
    instructions: [
      glossary,
      options.instructions
        ? "USER INSTRUCTIONS (override the glossary if they conflict):\n" +
          options.instructions
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
  }, glossary, plan.format);
  assertNotAborted(options.signal);
  let partsChanged = 0;
  for (const part of plan.parts) {
    const rendered = applyPart(
      part,
      translations,
      options.runDistribution ?? "style-aware",
    );
    if (!rendered.changed) continue;
    const original = plan.zip.file(part.part);
    plan.zip.file(part.part, rendered.xml, {
      ...(original?.date ? { date: original.date } : {}),
      createFolders: false,
      compression: "DEFLATE",
    });
    partsChanged += 1;
  }
  const bytes = await plan.zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  await JSZip.loadAsync(bytes, { checkCRC32: true });
  const blob = new Blob([Uint8Array.from(bytes)], {
    type: "application/vnd.openxmlformats-officedocument",
  });
  return {
    blob,
    fileName: outputFileName(file.name, options.targetLanguage),
    stats: {
      ...inspect,
      partsChanged,
      outputBytes: bytes.byteLength,
    },
  };
}
