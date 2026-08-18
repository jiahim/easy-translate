import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  inspectOfficeFile,
  OfficeTranslationError,
  translateOfficeFileInBrowser,
  type TranslationBatchRequest,
  type TranslationCheckpoint,
  type TranslationOutputItem,
  type TranslationProgress,
  type TranslationProvider,
} from "../lib/office.js";
import { zipBuffer, zipEntry } from "./helpers.js";

class ConcurrentProvider implements TranslationProvider {
  readonly name = "concurrent-browser-test";
  readonly requests: TranslationBatchRequest[] = [];
  active = 0;
  maxActive = 0;

  async translateBatch(
    request: TranslationBatchRequest,
  ): Promise<TranslationOutputItem[]> {
    this.requests.push(request);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    this.active -= 1;
    return request.items.map((item) => ({
      id: item.id,
      text: "已完成翻译 " + item.id,
    }));
  }
}

class RepairingProvider implements TranslationProvider {
  readonly name = "quality-repair-test";
  readonly requests: TranslationBatchRequest[] = [];

  async translateBatch(
    request: TranslationBatchRequest,
  ): Promise<TranslationOutputItem[]> {
    this.requests.push(request);
    const qualityRetry = request.instructions?.includes("QUALITY RETRY");
    return request.items.map((item) => ({
      id: item.id,
      text: qualityRetry
        ? request.targetLanguage.startsWith("zh")
          ? "潜在失效模式"
          : "NMC card test: verify that the firmware information is correct."
        : item.text,
    }));
  }
}

class ContextAwareProvider implements TranslationProvider {
  readonly name = "context-aware-test";
  readonly requests: TranslationBatchRequest[] = [];

  async translateBatch(
    request: TranslationBatchRequest,
  ): Promise<TranslationOutputItem[]> {
    this.requests.push(request);
    const translations: Record<string, string> = request.targetLanguage.startsWith("zh")
      ? {
          "Potential Failure Mode": "潜在失效模式",
          "Current Control": "当前控制",
          "Failure to start": "无法启动",
          "Visual inspection": "目视检查",
        }
      : {
          "测试项目": "Test item",
          "测试步骤": "Test procedure",
          "NMC 卡测试": "NMC card test",
          "检查固件版本": "Check the firmware version",
        };
    return request.items.map((item) => ({
      id: item.id,
      text: translations[item.text] ?? (request.targetLanguage.startsWith("zh") ? "译文" : "Translation"),
    }));
  }
}

describe("browser translation progress", () => {
  it("uses style-aware Word run replacement and translates around fields", async () => {
    const input = await zipBuffer({
      "[Content_Types].xml": "<Types/>",
      "word/document.xml":
        '<w:document xmlns:w="w"><w:body>' +
        "<w:p>" +
        "<w:r><w:rPr><w:b/></w:rPr><w:t>项目背景：</w:t></w:r>" +
        "<w:r><w:t>初期接手维护旧系统。</w:t></w:r>" +
        "</w:p>" +
        "<w:p>" +
        "<w:r><w:t>核心技术：</w:t></w:r>" +
        '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
        "<w:r><w:instrText> PAGE </w:instrText></w:r>" +
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
        "<w:r><w:t>Page 1</w:t></w:r>" +
        '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
        "<w:r><w:t>熟悉前端开发。</w:t></w:r>" +
        "</w:p>" +
        "</w:body></w:document>",
    });
    const translations: Record<string, string> = {
      "项目背景：初期接手维护旧系统。":
        "Project Background: Initially took over maintenance of the legacy system.",
      "核心技术：": "Core technologies:",
      "熟悉前端开发。": "Experienced in front-end development.",
    };
    const provider: TranslationProvider = {
      async translateBatch(request) {
        return request.items.map((item) => ({
          id: item.id,
          text: translations[item.text]!,
        }));
      },
    };

    const result = await translateOfficeFileInBrowser(
      new File([Uint8Array.from(input)], "styled-resume.docx"),
      { provider, targetLanguage: "en" },
    );
    const documentXml = (await zipEntry(
      Buffer.from(await result.blob.arrayBuffer()),
      "word/document.xml",
    )) as string;
    const textNodes = Array.from(
      documentXml.matchAll(/<w:t[^>]*>(.*?)<\/w:t>/gu),
      (match) => match[1],
    );

    assert.deepEqual(textNodes, [
      "Project Background:",
      " Initially took over maintenance of the legacy system.",
      "Core technologies:",
      "Page 1",
      "Experienced in front-end development.",
    ]);
    assert.match(
      documentXml,
      /<w:rPr><w:b\/><\/w:rPr><w:t>Project Background:<\/w:t>/u,
    );
    assert.match(documentXml, /<w:instrText> PAGE <\/w:instrText>/u);
  });

  it("detects worksheet string-value cells and skips formula caches", async () => {
    const input = await zipBuffer({
      "[Content_Types].xml": "<Types/>",
      "xl/workbook.xml": '<workbook xmlns="spreadsheet"/>',
      "xl/worksheets/sheet1.xml":
        '<worksheet xmlns="spreadsheet"><sheetData><row r="1">' +
        '<c r="A1" t="str"><v>Customer complaint</v></c>' +
        '<c r="B1" t="str"><f>CONCAT("Formula", " result")</f><v>Formula result</v></c>' +
        '<c r="C1" t="e"><v>#NAME?</v></c>' +
        "</row></sheetData></worksheet>",
    });
    const file = new File([Uint8Array.from(input)], "string-values.xlsx");
    const inspection = await inspectOfficeFile(file);

    assert.equal(inspection.segmentsFound, 1);
    assert.equal(inspection.uniqueSegments, 1);
    assert.equal(inspection.characters, "Customer complaint".length);

    const provider: TranslationProvider = {
      async translateBatch(request) {
        return request.items.map((item) => ({
          id: item.id,
          text: "客诉现象",
        }));
      },
    };
    const result = await translateOfficeFileInBrowser(file, {
      provider,
      targetLanguage: "zh-CN",
    });
    const worksheet = (await zipEntry(
      Buffer.from(await result.blob.arrayBuffer()),
      "xl/worksheets/sheet1.xml",
    )) as string;

    assert.match(worksheet, /<v>客诉现象<\/v>/u);
    assert.match(worksheet, /<f>CONCAT\("Formula", " result"\)<\/f><v>Formula result<\/v>/u);
    assert.match(worksheet, /<c r="C1" t="e"><v>#NAME\?<\/v><\/c>/u);
  });

  it("submits batches serially and reports progress before completion", async () => {
    const paragraphs = Array.from(
      { length: 20 },
      (_, index) =>
        `<w:p><w:r><w:t>Segment ${index} ${"x".repeat(220)}</w:t></w:r></w:p>`,
    ).join("");
    const input = await zipBuffer({
      "[Content_Types].xml": "<Types/>",
      "word/document.xml":
        '<w:document xmlns:w="w"><w:body>' +
        paragraphs +
        "</w:body></w:document>",
    });
    const provider = new ConcurrentProvider();
    const progress: TranslationProgress[] = [];
    const file = new File([Uint8Array.from(input)], "progress.docx");

    await translateOfficeFileInBrowser(file, {
      provider,
      targetLanguage: "zh-CN",
      onProgress: (value) => progress.push({ ...value }),
    });

    assert.equal(provider.requests.length, 5);
    assert.equal(provider.maxActive, 1);
    assert.ok(provider.requests.every((request) => request.items.length <= 4));
    assert.ok(
      provider.requests.every(
        (request) =>
          request.items.reduce((sum, item) => sum + item.text.length, 0) <=
          2_000,
      ),
    );
    assert.deepEqual(progress[0], {
      stage: "translation",
      completedBatches: 0,
      submittedBatches: 0,
      respondingBatches: 0,
      totalBatches: 5,
      translatedSegments: 0,
      totalSegments: 20,
      percentage: 0,
    });
    assert.ok(
      progress.some(
        (value) => value.submittedBatches > 0 && value.completedBatches === 0,
      ),
    );
    assert.deepEqual(progress.at(-1), {
      stage: "translation",
      completedBatches: 5,
      submittedBatches: 5,
      respondingBatches: 0,
      totalBatches: 5,
      translatedSegments: 20,
      totalSegments: 20,
      percentage: 100,
    });
  });

  it("saves completed batches and resumes only the unfinished text with another provider", async () => {
    const paragraphs = Array.from(
      { length: 8 },
      (_, index) =>
        `<w:p><w:r><w:t>Checkpoint segment ${index}</w:t></w:r></w:p>`,
    ).join("");
    const input = await zipBuffer({
      "[Content_Types].xml": "<Types/>",
      "word/document.xml":
        '<w:document xmlns:w="w"><w:body>' +
        paragraphs +
        "</w:body></w:document>",
    });
    const file = new File([Uint8Array.from(input)], "checkpoint.docx");
    let failedProviderCalls = 0;
    let checkpoint: TranslationCheckpoint | undefined;
    const failedProvider: TranslationProvider = {
      async translateBatch(request) {
        failedProviderCalls += 1;
        if (failedProviderCalls > 1) {
          throw new OfficeTranslationError(
            "模型没有返回规定的 JSON 结果。",
          );
        }
        return request.items.map((item) => ({
          id: item.id,
          text: "已缓存段落 " + item.text.match(/\d+$/u)?.[0],
        }));
      },
    };

    await assert.rejects(
      translateOfficeFileInBrowser(file, {
        provider: failedProvider,
        targetLanguage: "zh-CN",
        retries: 0,
        onCheckpoint(value) {
          checkpoint = structuredClone(value);
        },
      }),
      /JSON/u,
    );
    assert.equal(failedProviderCalls, 2);
    assert.equal(checkpoint?.completedSegments, 4);
    assert.equal(checkpoint?.totalSegments, 8);
    assert.ok(checkpoint);

    const resumedRequests: TranslationBatchRequest[] = [];
    const resumedProvider: TranslationProvider = {
      async translateBatch(request) {
        resumedRequests.push(request);
        return request.items.map((item) => ({
          id: item.id,
          text: "新模型续译段落 " + item.text.match(/\d+$/u)?.[0],
        }));
      },
    };
    const result = await translateOfficeFileInBrowser(file, {
      provider: resumedProvider,
      targetLanguage: "zh-CN",
      checkpoint,
    });
    const documentXml = (await zipEntry(
      Buffer.from(await result.blob.arrayBuffer()),
      "word/document.xml",
    )) as string;

    assert.equal(resumedRequests.length, 1);
    assert.deepEqual(
      resumedRequests[0]?.items.map((item) => item.text),
      Array.from({ length: 4 }, (_, index) => `Checkpoint segment ${index + 4}`),
    );
    assert.match(documentXml, /已缓存段落 0/u);
    assert.match(documentXml, /新模型续译段落 7/u);
  });

  it("retries a batch when the model returns an incomplete JSON result", async () => {
    const input = await zipBuffer({
      "[Content_Types].xml": "<Types/>",
      "word/document.xml":
        '<w:document xmlns:w="w"><w:body><w:p><w:r>' +
        "<w:t>Retry this segment</w:t>" +
        "</w:r></w:p></w:body></w:document>",
    });
    const requests: TranslationBatchRequest[] = [];
    const provider: TranslationProvider = {
      async translateBatch(request) {
        requests.push(structuredClone(request));
        if (requests.length === 1) return [];
        return request.items.map((item) => ({
          id: item.id,
          text: "已在重试后完成",
        }));
      },
    };

    await translateOfficeFileInBrowser(
      new File([Uint8Array.from(input)], "retry-json.docx"),
      { provider, targetLanguage: "zh-CN", retries: 1 },
    );

    assert.equal(requests.length, 2);
    assert.match(requests[1]?.instructions ?? "", /RESPONSE FORMAT RETRY/u);
  });

  it("honors custom browser concurrency and per-batch character limits", async () => {
    const paragraphs = Array.from(
      { length: 12 },
      (_, index) =>
        `<w:p><w:r><w:t>Request ${index} ${"x".repeat(210)}</w:t></w:r></w:p>`,
    ).join("");
    const input = await zipBuffer({
      "[Content_Types].xml": "<Types/>",
      "word/document.xml":
        '<w:document xmlns:w="w"><w:body>' +
        paragraphs +
        "</w:body></w:document>",
    });
    const provider = new ConcurrentProvider();

    await translateOfficeFileInBrowser(
      new File([Uint8Array.from(input)], "custom-limits.docx"),
      {
        provider,
        targetLanguage: "zh-CN",
        concurrency: 3,
        maxBatchCharacters: 500,
      },
    );

    assert.equal(provider.requests.length, 6);
    assert.equal(provider.maxActive, 3);
    assert.ok(
      provider.requests.every(
        (request) =>
          request.items.reduce((sum, item) => sum + item.text.length, 0) <=
          500,
      ),
    );
  });

  it("detects unchanged source text and repairs Word and Excel items", async () => {
    const wordInput = await zipBuffer({
      "[Content_Types].xml": "<Types/>",
      "word/document.xml":
        '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>' +
        "NMC 卡测试：检查 NMC 卡的固件版本信息是否正确。" +
        "</w:t></w:r></w:p></w:body></w:document>",
    });
    const wordProvider = new RepairingProvider();
    const wordResult = await translateOfficeFileInBrowser(
      new File([Uint8Array.from(wordInput)], "quality.docx"),
      { provider: wordProvider, targetLanguage: "en" },
    );
    const wordXml = (await zipEntry(
      Buffer.from(await wordResult.blob.arrayBuffer()),
      "word/document.xml",
    )) as string;

    assert.match(wordXml, /NMC card test/);
    assert.doesNotMatch(wordXml, /卡测试|固件版本信息/u);
    assert.ok(
      wordProvider.requests.some((value) =>
        value.instructions?.includes("QUALITY RETRY"),
      ),
    );

    const excelInput = await zipBuffer({
      "[Content_Types].xml": "<Types/>",
      "xl/workbook.xml": '<workbook xmlns="spreadsheet"/>',
      "xl/sharedStrings.xml":
        '<sst xmlns="spreadsheet"><si><t>Potential Failure Mode</t></si></sst>',
      "xl/worksheets/sheet1.xml": '<worksheet xmlns="spreadsheet"/>',
    });
    const excelProvider = new RepairingProvider();
    const excelResult = await translateOfficeFileInBrowser(
      new File([Uint8Array.from(excelInput)], "quality.xlsx"),
      { provider: excelProvider, targetLanguage: "zh-CN" },
    );
    const sharedStrings = (await zipEntry(
      Buffer.from(await excelResult.blob.arrayBuffer()),
      "xl/sharedStrings.xml",
    )) as string;

    assert.match(sharedStrings, /潜在失效模式/u);
    assert.doesNotMatch(sharedStrings, /Potential Failure Mode/u);
    assert.ok(
      excelProvider.requests.some((value) =>
        value.instructions?.includes("QUALITY RETRY"),
      ),
    );
  });

  it("preserves a PowerPoint model designation without reporting it as untranslated", async () => {
    const input = await zipBuffer({
      "[Content_Types].xml": "<Types/>",
      "ppt/presentation.xml": '<p:presentation xmlns:p="p"/>',
      "ppt/slides/slide1.xml":
        '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld>' +
        "<a:p><a:r><a:t>Timon 5K/6K FFR</a:t></a:r></a:p>" +
        "<a:p><a:r><a:t>Timon 5K/6K FFR1</a:t></a:r></a:p>" +
        "</p:cSld></p:sld>",
    });
    const requests: TranslationBatchRequest[] = [];
    const provider: TranslationProvider = {
      async translateBatch(request) {
        requests.push(request);
        return request.items.map((item) => ({ id: item.id, text: item.text }));
      },
    };

    const result = await translateOfficeFileInBrowser(
      new File([Uint8Array.from(input)], "model-name.pptx"),
      { provider, targetLanguage: "zh-CN" },
    );
    const slideXml = (await zipEntry(
      Buffer.from(await result.blob.arrayBuffer()),
      "ppt/slides/slide1.xml",
    )) as string;

    assert.match(slideXml, /Timon 5K\/6K FFR<\/a:t>/u);
    assert.match(slideXml, /Timon 5K\/6K FFR1<\/a:t>/u);
    assert.equal(requests.length, 1);
    assert.ok(
      requests.every(
        (request) => !request.instructions?.includes("QUALITY RETRY"),
      ),
    );
  });

  it("sends Excel sheet, cell, header and neighboring-row context with a document glossary", async () => {
    const input = await zipBuffer({
      "[Content_Types].xml": "<Types/>",
      "xl/workbook.xml":
        '<workbook xmlns="spreadsheet" xmlns:r="relationships"><sheets>' +
        '<sheet name="FMEA" sheetId="1" r:id="rId1"/>' +
        '<sheet name="Risks" sheetId="2" r:id="rId2"/>' +
        "</sheets></workbook>",
      "xl/_rels/workbook.xml.rels":
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
      "xl/sharedStrings.xml":
        '<sst xmlns="spreadsheet">' +
        "<si><t>Potential Failure Mode</t></si>" +
        "<si><t>Current Control</t></si>" +
        "<si><t>Failure to start</t></si>" +
        "<si><t>Visual inspection</t></si>" +
        "</sst>",
      "xl/worksheets/sheet1.xml":
        '<worksheet xmlns="spreadsheet"><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c></row>' +
        "</sheetData></worksheet>",
      "xl/worksheets/sheet2.xml":
        '<worksheet xmlns="spreadsheet"><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c></row>' +
        "</sheetData></worksheet>",
    });
    const provider = new ContextAwareProvider();
    const progress: TranslationProgress[] = [];

    await translateOfficeFileInBrowser(
      new File([Uint8Array.from(input)], "context.xlsx"),
      {
        provider,
        targetLanguage: "zh-CN",
        onProgress: (value) => progress.push({ ...value }),
      },
    );

    const glossaryRequest = provider.requests.find((request) =>
      request.instructions?.includes("DOCUMENT GLOSSARY PASS"),
    );
    assert.deepEqual(
      glossaryRequest?.items.map((item) => item.text),
      ["Potential Failure Mode", "Current Control"],
    );
    const bodyItem = provider.requests
      .filter((request) => request.instructions?.includes("DOCUMENT GLOSSARY (use"))
      .flatMap((request) => request.items)
      .find((item) => item.text === "Failure to start");
    assert.equal(bodyItem?.context.sheetName, "FMEA");
    assert.equal(bodyItem?.context.cellReference, "A2");
    assert.equal(bodyItem?.context.columnHeader, "Potential Failure Mode");
    assert.deepEqual(bodyItem?.context.tableHeaders, [
      "Potential Failure Mode",
      "Current Control",
    ]);
    assert.deepEqual(bodyItem?.context.rowContext, [
      "Current Control: Visual inspection",
    ]);
    assert.deepEqual(bodyItem?.context.usageLocations, [
      "FMEA!A2",
      "Risks!A2",
    ]);
    assert.ok(progress.some((value) => value.stage === "glossary"));
    assert.ok(progress.some((value) => value.stage === "translation"));
  });

  it("sends Word table headers and neighboring cells as context", async () => {
    const input = await zipBuffer({
      "[Content_Types].xml": "<Types/>",
      "word/document.xml":
        '<w:document xmlns:w="w"><w:body><w:tbl>' +
        '<w:tr><w:trPr><w:tblHeader/></w:trPr>' +
        '<w:tc><w:p><w:r><w:t>测试项目</w:t></w:r></w:p></w:tc>' +
        '<w:tc><w:p><w:r><w:t>测试步骤</w:t></w:r></w:p></w:tc></w:tr>' +
        "<w:tr>" +
        '<w:tc><w:p><w:r><w:t>NMC 卡测试</w:t></w:r></w:p></w:tc>' +
        '<w:tc><w:p><w:r><w:t>检查固件版本</w:t></w:r></w:p></w:tc>' +
        "</w:tr></w:tbl></w:body></w:document>",
    });
    const provider = new ContextAwareProvider();

    await translateOfficeFileInBrowser(
      new File([Uint8Array.from(input)], "context.docx"),
      { provider, targetLanguage: "en" },
    );

    const bodyItem = provider.requests
      .filter((request) => request.instructions?.includes("DOCUMENT GLOSSARY (use"))
      .flatMap((request) => request.items)
      .find((item) => item.text === "NMC 卡测试");
    assert.equal(bodyItem?.context.tableIndex, 1);
    assert.equal(bodyItem?.context.rowNumber, 2);
    assert.equal(bodyItem?.context.columnHeader, "测试项目");
    assert.deepEqual(bodyItem?.context.tableHeaders, ["测试项目", "测试步骤"]);
    assert.deepEqual(bodyItem?.context.rowContext, ["测试步骤: 检查固件版本"]);
  });
});
