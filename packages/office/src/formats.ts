import { extname } from "node:path";
import type {
  OfficeFormat,
  OfficeScopeOptions,
  TextKind,
} from "./types.js";
import type { XmlExtractionSpec } from "./xml.js";
import { UnsupportedOfficeFormatError } from "./errors.js";

const WORD_EXTENSIONS = new Set([
  ".docx",
  ".docm",
  ".dotx",
  ".dotm",
]);
const POWERPOINT_EXTENSIONS = new Set([
  ".pptx",
  ".pptm",
  ".potx",
  ".potm",
  ".ppsx",
  ".ppsm",
]);
const EXCEL_EXTENSIONS = new Set([
  ".xlsx",
  ".xlsm",
  ".xltx",
  ".xltm",
]);

export interface ResolvedOfficeScope {
  includeComments: boolean;
  includeHeadersAndFooters: boolean;
  includeNotes: boolean;
  includeMasters: boolean;
  includeCharts: boolean;
  includeDiagrams: boolean;
}

export function resolveScope(
  scope: OfficeScopeOptions | undefined,
): ResolvedOfficeScope {
  return {
    includeComments: scope?.includeComments ?? true,
    includeHeadersAndFooters: scope?.includeHeadersAndFooters ?? true,
    includeNotes: scope?.includeNotes ?? false,
    includeMasters: scope?.includeMasters ?? false,
    includeCharts: scope?.includeCharts ?? true,
    includeDiagrams: scope?.includeDiagrams ?? true,
  };
}

export function detectFormatFromFileName(fileName: string): OfficeFormat {
  const extension = extname(fileName).toLowerCase();
  if (WORD_EXTENSIONS.has(extension)) {
    return "word";
  }
  if (POWERPOINT_EXTENSIONS.has(extension)) {
    return "powerpoint";
  }
  if (EXCEL_EXTENSIONS.has(extension)) {
    return "excel";
  }
  throw new UnsupportedOfficeFormatError(fileName);
}

function wordParagraph(kind: TextKind): XmlExtractionSpec {
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

function drawingParagraph(kind: TextKind): XmlExtractionSpec {
  return {
    unitTag: "a:p",
    textTag: "a:t",
    kind,
    excludedAncestorTags: ["a:fld"],
    hardBreakTags: ["a:br", "a:tab", "a:fld"],
    fieldContentPatterns: [/<a:fld\b/u],
  };
}

function chartStringSpecs(): XmlExtractionSpec[] {
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

export function specsForPart(
  format: OfficeFormat,
  part: string,
  scope: ResolvedOfficeScope,
): XmlExtractionSpec[] | undefined {
  if (format === "word") {
    if (part === "word/document.xml") {
      return [wordParagraph("body")];
    }
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
    if (part === "word/footnotes.xml") {
      return [wordParagraph("footnote")];
    }
    if (part === "word/endnotes.xml") {
      return [wordParagraph("endnote")];
    }
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
      return scope.includeCharts ? chartStringSpecs() : undefined;
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
      return scope.includeCharts ? chartStringSpecs() : undefined;
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
      ? [
          {
            unitTag: "text",
            textTag: "t",
            kind: "comment",
          },
        ]
      : undefined;
  }
  if (/^xl\/drawings\/drawing\d+\.xml$/u.test(part)) {
    return scope.includeDiagrams
      ? [drawingParagraph("drawing")]
      : undefined;
  }
  if (/^xl\/charts\/chart\d+\.xml$/u.test(part)) {
    return scope.includeCharts ? chartStringSpecs() : undefined;
  }
  return undefined;
}
