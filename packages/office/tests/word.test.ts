import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { translateOfficeBuffer } from "../src/translator.js";
import { MappingProvider, joinedText, zipBuffer, zipEntry } from "./helpers.js";

describe("Word translation", () => {
  it("translates normal text around a complex field without changing the field", async () => {
    const documentXml =
      '<w:document xmlns:w="w"><w:body><w:p>' +
      "<w:r><w:t>核心技术：</w:t></w:r>" +
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
      "<w:r><w:instrText> PAGE </w:instrText></w:r>" +
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
      "<w:r><w:t>Page 1</w:t></w:r>" +
      '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
      "<w:r><w:t>熟悉前端开发。</w:t></w:r>" +
      "</w:p></w:body></w:document>";
    const input = await zipBuffer({
      "[Content_Types].xml": "<Types/>",
      "word/document.xml": documentXml,
    });
    const provider = new MappingProvider((text) =>
      text === "核心技术："
        ? "Core technologies:"
        : "Experienced in front-end development.",
    );

    const result = await translateOfficeBuffer(input, "field.docx", {
      provider,
      targetLanguage: "en",
      concurrency: 1,
    });
    const translatedDocument = (await zipEntry(
      result.buffer,
      "word/document.xml",
    )) as string;

    assert.match(translatedDocument, /<w:t>Core technologies:<\/w:t>/u);
    assert.match(
      translatedDocument,
      /<w:t>Experienced in front-end development\.<\/w:t>/u,
    );
    assert.match(translatedDocument, /<w:instrText> PAGE <\/w:instrText>/u);
    assert.match(translatedDocument, /<w:t>Page 1<\/w:t>/u);
    assert.deepEqual(
      provider.requests.flatMap((request) =>
        request.items.map((item) => item.text),
      ),
      ["核心技术：", "熟悉前端开发。"],
    );
    assert.equal(result.stats.skippedFieldParagraphs, 1);
  });

  it("changes only text-bearing XML and skips field paragraphs", async () => {
    const media = Buffer.from([0, 1, 2, 3, 255]);
    const documentXml =
      '<w:document xmlns:w="w"><w:body>' +
      '<w:p w:rsidR="A"><w:r><w:rPr><w:b/></w:rPr><w:t>Hello </w:t></w:r>' +
      "<w:r><w:rPr><w:i/></w:rPr><w:t>world</w:t></w:r></w:p>" +
      "<w:p><w:r><w:fldChar w:fldCharType=\"begin\"/></w:r>" +
      "<w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:t>Page 1</w:t></w:r></w:p>" +
      "</w:body></w:document>";
    const input = await zipBuffer({
      "[Content_Types].xml": "<Types/>",
      "word/document.xml": documentXml,
      "word/header1.xml":
        '<w:hdr xmlns:w="w"><w:p><w:r><w:t>Hello world</w:t></w:r></w:p></w:hdr>',
      "word/styles.xml": '<w:styles xmlns:w="w"><w:style w:styleId="Body"/></w:styles>',
      "word/media/image1.png": media,
    });
    const provider = new MappingProvider((text) =>
      text === "Hello world" ? "你好，世界" : "译:" + text,
    );

    const result = await translateOfficeBuffer(input, "sample.docx", {
      provider,
      targetLanguage: "zh-CN",
      concurrency: 1,
    });
    const translatedDocument = (await zipEntry(
      result.buffer,
      "word/document.xml",
    )) as string;
    const translatedHeader = (await zipEntry(
      result.buffer,
      "word/header1.xml",
    )) as string;

    assert.equal(joinedText(translatedDocument, "w:t"), "你好，世界Page 1");
    assert.equal(joinedText(translatedHeader, "w:t"), "你好，世界");
    assert.ok(translatedDocument.includes("<w:rPr><w:b/></w:rPr>"));
    assert.ok(translatedDocument.includes("<w:rPr><w:i/></w:rPr>"));
    assert.ok(translatedDocument.includes("<w:instrText> PAGE </w:instrText>"));
    assert.equal(await zipEntry(result.buffer, "word/styles.xml"),
      '<w:styles xmlns:w="w"><w:style w:styleId="Body"/></w:styles>',
    );
    assert.deepEqual(await zipEntry(result.buffer, "word/media/image1.png", "nodebuffer"),
      media,
    );
    assert.equal(result.stats.format, "word");
    assert.equal(result.stats.segmentsFound, 2);
    assert.equal(result.stats.uniqueSegmentsTranslated, 1);
    assert.equal(result.stats.partsChanged, 2);
    assert.equal(result.stats.skippedFieldParagraphs, 1);
    assert.equal(provider.requests.flatMap((request) => request.items).length, 1);
  });
});
