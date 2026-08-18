import type {
  RunDistribution,
  TextKind,
  TranslationContext,
  TranslationInputItem,
} from "./types.js";

export interface XmlExtractionSpec {
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

interface ElementRange {
  start: number;
  end: number;
  xml: string;
}

interface XmlTextNode {
  start: number;
  end: number;
  openTag: string;
  closeTag: string;
  text: string;
  styleKey: string;
}

export interface XmlSegmentPlan extends TranslationInputItem {
  leadingWhitespace: string;
  trailingWhitespace: string;
  nodes: XmlTextNode[];
}

export interface XmlPartPlan {
  part: string;
  xml: string;
  segments: XmlSegmentPlan[];
  skippedFieldParagraphs: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function elementRanges(
  xml: string,
  tag: string,
  baseOffset = 0,
): ElementRange[] {
  const escaped = escapeRegExp(tag);
  const expression = new RegExp(
    "<" +
      escaped +
      "(?=[\\s>])[^>]*>[\\s\\S]*?<\\/" +
      escaped +
      "\\s*>",
    "g",
  );
  const ranges: ElementRange[] = [];
  for (const match of xml.matchAll(expression)) {
    const localStart = match.index;
    ranges.push({
      start: baseOffset + localStart,
      end: baseOffset + localStart + match[0].length,
      xml: match[0],
    });
  }
  return ranges;
}

function isInsideExcludedAncestor(
  unitXml: string,
  position: number,
  tags: string[] | undefined,
): boolean {
  if (!tags?.length) {
    return false;
  }
  const before = unitXml.slice(0, position);
  return tags.some((tag) => {
    const open = before.lastIndexOf("<" + tag);
    const close = before.lastIndexOf("</" + tag);
    return open > close;
  });
}

function isInsideComplexWordField(
  unitXml: string,
  position: number,
): boolean {
  let depth = 0;
  const expression = /<w:fldChar(?=[\s/>])[^>]*>/gu;
  for (const match of unitXml.slice(0, position).matchAll(expression)) {
    const type = /\bw:fldCharType\s*=\s*(["'])(.*?)\1/iu.exec(
      match[0],
    )?.[2];
    if (type === "begin") {
      depth += 1;
    } else if (type === "end") {
      depth = Math.max(0, depth - 1);
    }
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
  if (openStart <= closeStart) {
    return "";
  }

  const runEnd = unitXml.indexOf("</" + runTag, position);
  if (openStart < 0 || runEnd < 0) {
    return "";
  }
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

function textNodes(
  unit: ElementRange,
  tag: string,
  excludedAncestorTags?: string[],
  excludeComplexWordFields = false,
): XmlTextNode[] {
  const escaped = escapeRegExp(tag);
  const expression = new RegExp(
    "<" +
      escaped +
      "(?=[\\s/>])([^>]*?)(?:\\/\\s*>|>([\\s\\S]*?)<\\/" +
      escaped +
      "\\s*>)",
    "g",
  );
  const nodes: XmlTextNode[] = [];

  for (const match of unit.xml.matchAll(expression)) {
    if (
      isInsideExcludedAncestor(
        unit.xml,
        match.index,
        excludedAncestorTags,
      ) ||
      (excludeComplexWordFields &&
        isInsideComplexWordField(unit.xml, match.index))
    ) {
      continue;
    }

    const attributes = match[1] ?? "";
    const encodedText = match[2];
    const openTag = "<" + tag + attributes + ">";
    nodes.push({
      start: unit.start + match.index,
      end: unit.start + match.index + match[0].length,
      openTag,
      closeTag: "</" + tag + ">",
      text: encodedText === undefined ? "" : decodeXmlText(encodedText),
      styleKey: containingRunStyle(unit.xml, match.index, tag),
    });
  }

  return nodes;
}

function containsHardBreak(
  xml: string,
  tags: string[] | undefined,
): boolean {
  if (!tags?.length) {
    return false;
  }
  return tags.some((tag) => {
    const escaped = escapeRegExp(tag);
    return new RegExp("<" + escaped + "(?=[\\s/>])").test(xml);
  });
}

function splitNodeGroups(
  unitXml: string,
  unitStart: number,
  nodes: XmlTextNode[],
  hardBreakTags?: string[],
): XmlTextNode[][] {
  if (nodes.length < 2 || !hardBreakTags?.length) {
    return nodes.length ? [nodes] : [];
  }

  const groups: XmlTextNode[][] = [];
  let current: XmlTextNode[] = [];
  for (const node of nodes) {
    const previous = current.at(-1);
    if (previous) {
      const localPreviousEnd = previous.end - unitStart;
      const localNodeStart = node.start - unitStart;
      const gap = unitXml.slice(localPreviousEnd, localNodeStart);
      if (containsHardBreak(gap, hardBreakTags)) {
        groups.push(current);
        current = [];
      }
    }
    current.push(node);
  }
  if (current.length) {
    groups.push(current);
  }
  return groups;
}

function splitOuterWhitespace(value: string): {
  core: string;
  leading: string;
  trailing: string;
} {
  const leading = value.match(/^\s*/u)?.[0] ?? "";
  const remainder = value.slice(leading.length);
  const trailing = remainder.match(/\s*$/u)?.[0] ?? "";
  return {
    core: remainder.slice(0, remainder.length - trailing.length),
    leading,
    trailing,
  };
}

export function shouldTranslateText(value: string): boolean {
  if (!/\p{L}/u.test(value)) {
    return false;
  }
  if (/^(?:https?:\/\/|mailto:|www\.)\S+$/iu.test(value)) {
    return false;
  }
  if (/^[\[{<(]{1,2}[\w.-]+[\]}>)]{1,2}$/u.test(value)) {
    return false;
  }
  if (/^%[\w.-]+%$/u.test(value)) {
    return false;
  }
  return true;
}

export function createXmlPartPlan(
  xml: string,
  part: string,
  format: TranslationContext["format"],
  specs: XmlExtractionSpec[],
): XmlPartPlan {
  const segments: XmlSegmentPlan[] = [];
  let skippedFieldParagraphs = 0;

  for (const spec of specs) {
    const scopes = spec.scopeTag
      ? elementRanges(xml, spec.scopeTag)
      : [{ start: 0, end: xml.length, xml }];

    for (const scope of scopes) {
      const units = elementRanges(scope.xml, spec.unitTag, scope.start);
      for (const unit of units) {
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

        const nodes = textNodes(
          unit,
          spec.textTag,
          spec.excludedAncestorTags,
          spec.excludeComplexWordFields,
        );
        for (const group of splitNodeGroups(
          unit.xml,
          unit.start,
          nodes,
          spec.hardBreakTags,
        )) {
          const combined = group.map((node) => node.text).join("");
          const whitespace = splitOuterWhitespace(combined);
          if (!shouldTranslateText(whitespace.core)) {
            continue;
          }

          const segmentIndex = segments.length;
          segments.push({
            id: part + "#" + segmentIndex,
            text: whitespace.core,
            context: { format, part, kind: spec.kind },
            leadingWhitespace: whitespace.leading,
            trailingWhitespace: whitespace.trailing,
            nodes: group,
          });
        }
      }
    }
  }

  segments.sort((left, right) => left.nodes[0]!.start - right.nodes[0]!.start);
  return { part, xml, segments, skippedFieldParagraphs };
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

function styleGroups(nodes: XmlTextNode[]): StyleGroup[] {
  const groups: StyleGroup[] = [];
  nodes.forEach((node, index) => {
    const weight = graphemes(node.text).length;
    if (!weight) {
      return;
    }
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

function distributeStyleAware(
  value: string,
  nodes: XmlTextNode[],
): string[] {
  const result = nodes.map(() => "");
  const groups = styleGroups(nodes);
  if (!groups.length) {
    return result;
  }
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

  const whitespace = splitOuterWhitespace(value);
  const translatedDelimiter = whitespace.core.search(/[:：]/u);
  if (
    labelGroupEnd >= 0 &&
    translatedDelimiter >= 0 &&
    whitespace.core.slice(translatedDelimiter + 1).trim()
  ) {
    const labelGroups = groups.slice(0, labelGroupEnd + 1);
    const bodyGroups = groups.slice(labelGroupEnd + 1);
    const labelTarget = dominantStyleGroup(labelGroups).indices[0]!;
    const bodyTarget = dominantStyleGroup(bodyGroups).indices[0]!;
    result[labelTarget] =
      whitespace.leading + whitespace.core.slice(0, translatedDelimiter + 1);
    result[bodyTarget] =
      whitespace.core.slice(translatedDelimiter + 1) + whitespace.trailing;
    return result;
  }

  result[dominantStyleGroup(groups).indices[0]!] = value;
  return result;
}

function distributeText(
  value: string,
  nodes: XmlTextNode[],
  mode: RunDistribution,
): string[] {
  const result = nodes.map(() => "");
  if (!nodes.length) {
    return result;
  }

  if (mode === "style-aware") {
    return distributeStyleAware(value, nodes);
  }

  const populatedIndices = nodes
    .map((node, index) => ({ index, weight: graphemes(node.text).length }))
    .filter((entry) => entry.weight > 0);
  const targetIndices =
    populatedIndices.length > 0
      ? populatedIndices
      : [{ index: 0, weight: 1 }];

  if (mode === "first" || targetIndices.length === 1) {
    result[targetIndices[0]!.index] = value;
    return result;
  }

  const output = graphemes(value);
  const totalWeight = targetIndices.reduce(
    (sum, entry) => sum + entry.weight,
    0,
  );
  let outputStart = 0;
  let cumulativeWeight = 0;

  targetIndices.forEach((entry, position) => {
    cumulativeWeight += entry.weight;
    const outputEnd =
      position === targetIndices.length - 1
        ? output.length
        : Math.round((cumulativeWeight / totalWeight) * output.length);
    result[entry.index] = output.slice(outputStart, outputEnd).join("");
    outputStart = outputEnd;
  });

  return result;
}

function sanitizeXmlText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, "");
}

export function encodeXmlText(value: string): string {
  return sanitizeXmlText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function decodeXmlText(value: string): string {
  return value.replace(
    /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/giu,
    (entity) => {
      switch (entity.toLowerCase()) {
        case "&amp;":
          return "&";
        case "&lt;":
          return "<";
        case "&gt;":
          return ">";
        case "&quot;":
          return '"';
        case "&apos;":
          return "'";
        default: {
          const hexadecimal = /^&#x([0-9a-f]+);$/iu.exec(entity);
          if (hexadecimal?.[1]) {
            return String.fromCodePoint(Number.parseInt(hexadecimal[1], 16));
          }
          const decimal = /^&#(\d+);$/u.exec(entity);
          return decimal?.[1]
            ? String.fromCodePoint(Number.parseInt(decimal[1], 10))
            : entity;
        }
      }
    },
  );
}

function renderNode(node: XmlTextNode, value: string): string {
  let openTag = node.openTag;
  if (
    value.length > 0 &&
    (/^\s/u.test(value) || /\s$/u.test(value)) &&
    !/\bxml:space\s*=/u.test(openTag)
  ) {
    openTag = openTag.replace(/>$/u, ' xml:space="preserve">');
  }
  return openTag + encodeXmlText(value) + node.closeTag;
}

export function applyXmlTranslations(
  plan: XmlPartPlan,
  translations: ReadonlyMap<string, string>,
  mode: RunDistribution = "style-aware",
): { xml: string; changed: boolean } {
  const replacements: Array<{ start: number; end: number; value: string }> = [];

  for (const segment of plan.segments) {
    const translated = translations.get(segment.id);
    if (translated === undefined || translated === segment.text) {
      continue;
    }
    const complete =
      segment.leadingWhitespace +
      translated +
      segment.trailingWhitespace;
    const distributed = distributeText(complete, segment.nodes, mode);
    segment.nodes.forEach((node, index) => {
      replacements.push({
        start: node.start,
        end: node.end,
        value: renderNode(node, distributed[index] ?? ""),
      });
    });
  }

  if (!replacements.length) {
    return { xml: plan.xml, changed: false };
  }

  replacements.sort((left, right) => right.start - left.start);
  let output = plan.xml;
  for (const replacement of replacements) {
    output =
      output.slice(0, replacement.start) +
      replacement.value +
      output.slice(replacement.end);
  }
  return { xml: output, changed: true };
}
