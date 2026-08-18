import JSZip from "jszip";
import { OfficeTranslatorError } from "./errors.js";
import {
  detectFormatFromFileName,
  resolveScope,
  specsForPart,
  type ResolvedOfficeScope,
} from "./formats.js";
import type {
  OfficeFormat,
  OfficeScopeOptions,
  RunDistribution,
} from "./types.js";
import {
  applyXmlTranslations,
  createXmlPartPlan,
  type XmlPartPlan,
} from "./xml.js";

export interface OfficePackagePlan {
  format: OfficeFormat;
  zip: JSZip;
  parts: XmlPartPlan[];
  partsScanned: number;
  skippedFieldParagraphs: number;
}

function requiredMainPart(format: OfficeFormat): string {
  switch (format) {
    case "word":
      return "word/document.xml";
    case "powerpoint":
      return "ppt/presentation.xml";
    case "excel":
      return "xl/workbook.xml";
  }
}

function validatePackage(zip: JSZip, format: OfficeFormat): void {
  if (!zip.file("[Content_Types].xml")) {
    throw new OfficeTranslatorError(
      "The input is a ZIP file, but it is not a valid OOXML Office package.",
    );
  }
  const mainPart = requiredMainPart(format);
  if (!zip.file(mainPart)) {
    throw new OfficeTranslatorError(
      "The file extension indicates " +
        format +
        ", but the package is missing " +
        mainPart +
        ".",
    );
  }
}

async function loadEligibleParts(
  zip: JSZip,
  format: OfficeFormat,
  scope: ResolvedOfficeScope,
): Promise<XmlPartPlan[]> {
  const plans: XmlPartPlan[] = [];
  const names = Object.keys(zip.files).sort();

  for (const name of names) {
    const specs = specsForPart(format, name, scope);
    if (!specs?.length) {
      continue;
    }
    const entry = zip.file(name);
    if (!entry) {
      continue;
    }
    const xml = await entry.async("string");
    plans.push(createXmlPartPlan(xml, name, format, specs));
  }
  return plans;
}

export async function planOfficePackage(
  buffer: Buffer,
  fileName: string,
  scopeOptions?: OfficeScopeOptions,
): Promise<OfficePackagePlan> {
  const format = detectFormatFromFileName(fileName);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (error) {
    throw new OfficeTranslatorError(
      "Unable to open the Office package. Encrypted or damaged files are not supported.",
      { cause: error },
    );
  }

  validatePackage(zip, format);
  const parts = await loadEligibleParts(zip, format, resolveScope(scopeOptions));
  return {
    format,
    zip,
    parts,
    partsScanned: parts.length,
    skippedFieldParagraphs: parts.reduce(
      (sum, part) => sum + part.skippedFieldParagraphs,
      0,
    ),
  };
}

export async function renderOfficePackage(
  plan: OfficePackagePlan,
  translations: ReadonlyMap<string, string>,
  runDistribution: RunDistribution,
): Promise<{ buffer: Buffer; partsChanged: number }> {
  let partsChanged = 0;

  for (const part of plan.parts) {
    const rewritten = applyXmlTranslations(
      part,
      translations,
      runDistribution,
    );
    if (!rewritten.changed) {
      continue;
    }

    const original = plan.zip.file(part.part);
    const options: JSZip.JSZipFileOptions = {
      createFolders: false,
      compression: "DEFLATE",
    };
    if (original?.date) {
      options.date = original.date;
    }
    if (original?.comment) {
      options.comment = original.comment;
    }
    if (original?.unixPermissions !== null && original?.unixPermissions !== undefined) {
      options.unixPermissions = original.unixPermissions;
    }
    if (original?.dosPermissions !== null && original?.dosPermissions !== undefined) {
      options.dosPermissions = original.dosPermissions;
    }
    plan.zip.file(part.part, rewritten.xml, options);
    partsChanged += 1;
  }

  const buffer = await plan.zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    platform: "UNIX",
  });

  try {
    await JSZip.loadAsync(buffer, { checkCRC32: true });
  } catch (error) {
    throw new OfficeTranslatorError(
      "The translated OOXML package failed the ZIP integrity check.",
      { cause: error },
    );
  }
  return { buffer, partsChanged };
}
