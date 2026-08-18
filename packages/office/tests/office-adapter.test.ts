import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  prepareOfficeDocument,
  renderOfficeDocument,
} from "../src/office-adapter.js";
import { translatePlan } from "@easy-translate/core";
import { joinedText, zipBuffer, zipEntry } from "./helpers.js";

describe("Office document adapter", () => {
  it("prepares a generic plan and renders translation results", async () => {
    const input = await zipBuffer({
      "[Content_Types].xml": "<Types/>",
      "word/document.xml":
        '<w:document xmlns:w="w"><w:body>' +
        "<w:p><w:r><w:t>Hello</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>Hello</w:t></w:r></w:p>" +
        "</w:body></w:document>",
    });
    const prepared = await prepareOfficeDocument({
      buffer: input,
      fileName: "adapter.docx",
    });

    assert.equal(prepared.plan.schemaVersion, 1);
    assert.equal(prepared.plan.document.format, "word");
    assert.match(prepared.plan.document.id, /^office:word:[a-f\d]{64}$/u);
    assert.equal(prepared.plan.units.length, 2);

    let submittedItems = 0;
    const result = await translatePlan(prepared.plan, {
      provider: {
        async translateBatch(request) {
          submittedItems += request.items.length;
          return request.items.map((item) => ({ id: item.id, text: "你好" }));
        },
      },
      targetLanguage: "zh-CN",
    });
    const rendered = await renderOfficeDocument(prepared.formatState, result);
    const documentXml = (await zipEntry(
      rendered.buffer,
      "word/document.xml",
    )) as string;

    assert.equal(submittedItems, 1);
    assert.equal(joinedText(documentXml, "w:t"), "你好你好");
    assert.equal(rendered.partsChanged, 1);
  });
});
