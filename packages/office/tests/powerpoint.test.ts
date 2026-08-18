import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { translateOfficeBuffer } from "../src/translator.js";
import { MappingProvider, joinedText, zipBuffer, zipEntry } from "./helpers.js";

describe("PowerPoint translation", () => {
  it("translates slide, diagram and chart strings but leaves notes and masters opt-in", async () => {
    const slide =
      '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><a:p>' +
      "<a:r><a:rPr b=\"1\"/><a:t>Quarterly </a:t></a:r>" +
      "<a:r><a:rPr i=\"1\"/><a:t>report</a:t></a:r>" +
      "</a:p></p:cSld></p:sld>";
    const chart =
      '<c:chartSpace xmlns:c="c" xmlns:a="a"><c:chart>' +
      "<a:p><a:r><a:t>Revenue</a:t></a:r></a:p>" +
      "<c:strCache><c:pt idx=\"0\"><c:v>North</c:v></c:pt></c:strCache>" +
      "</c:chart></c:chartSpace>";
    const input = await zipBuffer({
      "[Content_Types].xml": "<Types/>",
      "ppt/presentation.xml": '<p:presentation xmlns:p="p"/>',
      "ppt/slides/slide1.xml": slide,
      "ppt/charts/chart1.xml": chart,
      "ppt/diagrams/data1.xml":
        '<dgm:dataModel xmlns:dgm="dgm" xmlns:a="a"><a:p><a:r><a:t>Process</a:t></a:r></a:p></dgm:dataModel>',
      "ppt/notesSlides/notesSlide1.xml":
        '<p:notes xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Private note</a:t></a:r></a:p></p:notes>',
      "ppt/slideMasters/slideMaster1.xml":
        '<p:sldMaster xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Company</a:t></a:r></a:p></p:sldMaster>',
    });
    const provider = new MappingProvider();

    const result = await translateOfficeBuffer(input, "deck.pptx", {
      provider,
      targetLanguage: "zh-CN",
    });
    const translatedSlide = (await zipEntry(
      result.buffer,
      "ppt/slides/slide1.xml",
    )) as string;
    const translatedChart = (await zipEntry(
      result.buffer,
      "ppt/charts/chart1.xml",
    )) as string;

    assert.equal(joinedText(translatedSlide, "a:t"), "译:Quarterly report");
    assert.ok(translatedSlide.includes('<a:rPr b="1"/>'));
    assert.ok(translatedSlide.includes('<a:rPr i="1"/>'));
    assert.equal(joinedText(translatedChart, "a:t"), "译:Revenue");
    assert.equal(joinedText(translatedChart, "c:v"), "译:North");
    assert.equal(
      joinedText(
        (await zipEntry(result.buffer, "ppt/diagrams/data1.xml")) as string,
        "a:t",
      ),
      "译:Process",
    );
    assert.ok(String(await zipEntry(result.buffer, "ppt/notesSlides/notesSlide1.xml")).includes("Private note"));
    assert.ok(String(await zipEntry(result.buffer, "ppt/slideMasters/slideMaster1.xml")).includes("Company"));
    assert.equal(result.stats.partsChanged, 3);
  });
});
