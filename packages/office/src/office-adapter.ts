import { createHash } from "node:crypto";
import {
  planOfficePackage,
  renderOfficePackage,
  type OfficePackagePlan,
} from "./package.js";
import type {
  OfficeScopeOptions,
  RunDistribution,
  TranslationContext,
} from "./types.js";
import type {
  DocumentAdapter,
  PreparedDocument,
  TranslationPlan,
  TranslationResult,
} from "@easy-translate/core";

export interface OfficeDocumentInput {
  buffer: Buffer;
  fileName: string;
}

export interface OfficePrepareOptions {
  scope?: OfficeScopeOptions;
}

export interface OfficeRenderOptions {
  runDistribution?: RunDistribution;
}

export interface OfficeFormatState {
  packagePlan: OfficePackagePlan;
}

export interface OfficeRenderedDocument {
  buffer: Buffer;
  partsChanged: number;
}

export type PreparedOfficeDocument = PreparedDocument<
  OfficeFormatState,
  TranslationContext
>;

function sourceHash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function prepareOfficeDocument(
  input: OfficeDocumentInput,
  options: OfficePrepareOptions = {},
): Promise<PreparedOfficeDocument> {
  const packagePlan = await planOfficePackage(
    input.buffer,
    input.fileName,
    options.scope,
  );
  const hash = sourceHash(input.buffer);
  const plan: TranslationPlan<TranslationContext> = {
    schemaVersion: 1,
    document: {
      id: `office:${packagePlan.format}:${hash}`,
      format: packagePlan.format,
      sourceHash: hash,
    },
    units: packagePlan.parts.flatMap((part) =>
      part.segments.map((segment) => ({
        id: segment.id,
        text: segment.text,
        context: segment.context,
        dedupeKey: segment.text,
      })),
    ),
  };
  return { plan, formatState: { packagePlan } };
}

export async function renderOfficeDocument(
  state: OfficeFormatState,
  result: TranslationResult,
  options: OfficeRenderOptions = {},
): Promise<OfficeRenderedDocument> {
  return renderOfficePackage(
    state.packagePlan,
    result.translations,
    options.runDistribution ?? "style-aware",
  );
}

export const officeDocumentAdapter: DocumentAdapter<
  OfficeDocumentInput,
  OfficeFormatState,
  OfficeRenderedDocument,
  TranslationContext,
  OfficePrepareOptions,
  OfficeRenderOptions
> = {
  prepare: prepareOfficeDocument,
  render: renderOfficeDocument,
};
