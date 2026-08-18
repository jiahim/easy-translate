import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyXmlTranslations,
  createXmlPartPlan,
} from "../src/xml.js";

describe("OOXML text replacement", () => {
  it("keeps a same-style translation intact instead of splitting words across runs", () => {
    const xml =
      '<w:p xmlns:w="w">' +
      '<w:r><w:rPr><w:color w:val="222222"/></w:rPr><w:t>2013年</w:t></w:r>' +
      '<w:r><w:rPr><w:color w:val="222222"/></w:rPr><w:t>09月 - 2017年06月</w:t></w:r>' +
      "</w:p>";
    const plan = createXmlPartPlan(xml, "word/document.xml", "word", [
      { unitTag: "w:p", textTag: "w:t", kind: "body" },
    ]);

    const output = applyXmlTranslations(
      plan,
      new Map([[plan.segments[0]!.id, "September 2013 - June 2017"]]),
      "style-aware",
    ).xml;
    const textNodes = Array.from(
      output.matchAll(/<w:t[^>]*>(.*?)<\/w:t>/gu),
      (match) => match[1],
    );

    assert.deepEqual(textNodes, ["September 2013 - June 2017", ""]);
  });

  it("keeps a translated label and body in their original styles", () => {
    const xml =
      '<w:p xmlns:w="w">' +
      "<w:r><w:rPr><w:b/></w:rPr><w:t>项目背景：</w:t></w:r>" +
      "<w:r><w:t>初期接手维护旧系统。</w:t></w:r>" +
      "</w:p>";
    const plan = createXmlPartPlan(xml, "word/document.xml", "word", [
      { unitTag: "w:p", textTag: "w:t", kind: "body" },
    ]);

    const output = applyXmlTranslations(
      plan,
      new Map([
        [
          plan.segments[0]!.id,
          "Project Background: Initially took over maintenance of the legacy system.",
        ],
      ]),
      "style-aware",
    ).xml;
    const textNodes = Array.from(
      output.matchAll(/<w:t[^>]*>(.*?)<\/w:t>/gu),
      (match) => match[1],
    );

    assert.deepEqual(textNodes, [
      "Project Background:",
      " Initially took over maintenance of the legacy system.",
    ]);
    assert.match(
      output,
      /<w:rPr><w:b\/><\/w:rPr><w:t>Project Background:<\/w:t>/u,
    );
  });

  it("translates a whole paragraph while retaining run properties", () => {
    const xml =
      '<w:document xmlns:w="w"><w:body><w:p>' +
      "<w:r><w:rPr><w:b/></w:rPr><w:t>Hello </w:t></w:r>" +
      "<w:r><w:rPr><w:i/></w:rPr><w:t>world</w:t></w:r>" +
      "</w:p></w:body></w:document>";
    const plan = createXmlPartPlan(xml, "word/document.xml", "word", [
      {
        unitTag: "w:p",
        textTag: "w:t",
        kind: "body",
      },
    ]);

    assert.deepEqual(plan.segments.map((item) => item.text), ["Hello world"]);
    const output = applyXmlTranslations(
      plan,
      new Map([[plan.segments[0]!.id, "你好世界"]]),
      "proportional",
    ).xml;

    assert.ok(output.includes("<w:rPr><w:b/></w:rPr>"));
    assert.ok(output.includes("<w:rPr><w:i/></w:rPr>"));
    assert.deepEqual(output.match(/<w:t[^>]*>(.*?)<\/w:t>/gu), [
      "<w:t>你好</w:t>",
      "<w:t>世界</w:t>",
    ]);
  });

  it("preserves outer whitespace and XML-escapes provider output", () => {
    const xml =
      '<w:p xmlns:w="w"><w:r><w:t xml:space="preserve"> Hello </w:t></w:r></w:p>';
    const plan = createXmlPartPlan(xml, "word/document.xml", "word", [
      { unitTag: "w:p", textTag: "w:t", kind: "body" },
    ]);
    const output = applyXmlTranslations(
      plan,
      new Map([[plan.segments[0]!.id, "A < B & C"]]),
      "proportional",
    ).xml;

    assert.ok(output.includes(
      '<w:t xml:space="preserve"> A &lt; B &amp; C </w:t>',
    ));
  });

  it("splits translation units at explicit line breaks", () => {
    const xml =
      '<a:p xmlns:a="a"><a:r><a:t>First line</a:t></a:r>' +
      "<a:br/><a:r><a:t>Second line</a:t></a:r></a:p>";
    const plan = createXmlPartPlan(xml, "ppt/slides/slide1.xml", "powerpoint", [
      {
        unitTag: "a:p",
        textTag: "a:t",
        kind: "body",
        hardBreakTags: ["a:br"],
      },
    ]);

    assert.deepEqual(plan.segments.map((item) => item.text), [
      "First line",
      "Second line",
    ]);
  });
});
