import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { translateOfficeBuffer } from "../src/translator.js";
import { MappingProvider, joinedText, zipBuffer, zipEntry } from "./helpers.js";

describe("Excel translation", () => {
  it("translates shared and inline strings without touching formulas or styles", async () => {
    const styles = Buffer.from(
      '<styleSheet xmlns="spreadsheet"><cellXfs count="1"/></styleSheet>',
    );
    const sharedStrings =
      '<sst xmlns="spreadsheet"><si>' +
      '<r><rPr><b/></rPr><t xml:space="preserve">Sales </t></r>' +
      "<r><rPr><i/></rPr><t>report</t></r></si>" +
      "<si><t>42</t></si><si><t>https://example.com</t></si></sst>";
    const worksheet =
      '<worksheet xmlns="spreadsheet"><sheetData><row r="1">' +
      '<c r="A1" t="inlineStr" s="2"><is><t>Summary</t></is></c>' +
      '<c r="B1"><f>SUM(B2:B3)</f><v>3</v></c>' +
      '<c r="C1" t="str"><v>Customer complaint</v></c>' +
      '<c r="D1" t="str"><f>CONCAT("Formula", " result")</f><v>Formula result</v></c>' +
      "</row></sheetData></worksheet>";
    const input = await zipBuffer({
      "[Content_Types].xml": "<Types/>",
      "xl/workbook.xml": '<workbook xmlns="spreadsheet"/>',
      "xl/sharedStrings.xml": sharedStrings,
      "xl/worksheets/sheet1.xml": worksheet,
      "xl/styles.xml": styles,
    });

    const result = await translateOfficeBuffer(input, "book.xlsx", {
      provider: new MappingProvider(),
      targetLanguage: "zh-CN",
    });
    const translatedStrings = (await zipEntry(
      result.buffer,
      "xl/sharedStrings.xml",
    )) as string;
    const translatedSheet = (await zipEntry(
      result.buffer,
      "xl/worksheets/sheet1.xml",
    )) as string;

    assert.equal(joinedText(translatedStrings, "t"),
      "译:Sales report42https://example.com",
    );
    assert.ok(translatedStrings.includes("<rPr><b/></rPr>"));
    assert.ok(translatedStrings.includes("<rPr><i/></rPr>"));
    assert.equal(joinedText(translatedSheet, "t"), "译:Summary");
    assert.ok(translatedSheet.includes("<v>译:Customer complaint</v>"));
    assert.ok(translatedSheet.includes("<v>Formula result</v>"));
    assert.ok(translatedSheet.includes("<f>SUM(B2:B3)</f><v>3</v>"));
    assert.deepEqual(
      await zipEntry(result.buffer, "xl/styles.xml", "nodebuffer"),
      styles,
    );
    assert.equal(result.stats.format, "excel");
    assert.equal(result.stats.segmentsFound, 3);
    assert.equal(result.stats.uniqueSegmentsTranslated, 3);
    assert.equal(result.stats.partsChanged, 2);
  });
});
