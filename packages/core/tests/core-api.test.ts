import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createEchoProvider,
  createPlan,
  defineProvider,
  parseBatchOutput,
  RESPONSE_FORMAT_RETRY_INSTRUCTION,
  toTranslationRecord,
  translatePlan,
  translateTexts,
  TranslationErrorCode,
  TranslationResponseError,
  type TranslationBatchRequest,
} from "../src/index.js";

function request(): TranslationBatchRequest {
  return {
    targetLanguage: "zh-CN",
    items: [
      { id: "a", text: "Hello", context: undefined },
      { id: "b", text: "World", context: undefined },
    ],
  };
}

function responseErrorFrom(operation: () => unknown): TranslationResponseError {
  try {
    operation();
  } catch (error) {
    assert.ok(error instanceof TranslationResponseError);
    return error;
  }
  assert.fail("Expected a TranslationResponseError.");
}

describe("createPlan", () => {
  it("fills the envelope for plain strings", () => {
    const plan = createPlan(["Hello", "World"]);

    assert.equal(plan.schemaVersion, 1);
    assert.equal(plan.document.format, "plain");
    assert.match(plan.document.id, /^doc-\d+$/u);
    assert.deepEqual(
      plan.units.map((unit) => unit.id),
      ["u0", "u1"],
    );
    assert.deepEqual(
      plan.units.map((unit) => unit.text),
      ["Hello", "World"],
    );
    assert.equal(plan.units[0]?.context, undefined);
  });

  it("generates a distinct document id per call", () => {
    assert.notEqual(createPlan([]).document.id, createPlan([]).document.id);
  });

  it("keeps explicit ids, hints and document metadata", () => {
    const plan = createPlan<{ role: string }>(
      [
        {
          text: "Hello",
          context: { role: "body" },
          dedupeKey: "greeting",
          batchKey: "section-1",
        },
        { id: "custom", text: "World", context: { role: "heading" } },
      ],
      { id: "guide", format: "markdown", sourceHash: "abc123" },
    );

    assert.deepEqual(plan.document, {
      id: "guide",
      format: "markdown",
      sourceHash: "abc123",
    });
    assert.deepEqual(
      plan.units.map((unit) => unit.id),
      ["u0", "custom"],
    );
    assert.equal(plan.units[0]?.dedupeKey, "greeting");
    assert.equal(plan.units[0]?.batchKey, "section-1");
    assert.deepEqual(plan.units[1]?.context, { role: "heading" });
  });

  it("omits sourceHash when it was not supplied", () => {
    assert.equal("sourceHash" in createPlan([]).document, false);
  });
});

describe("translateTexts", () => {
  it("returns translations in input order", async () => {
    const translated = await translateTexts(["Hello", "World"], {
      provider: createEchoProvider((text) => "译:" + text),
      targetLanguage: "zh-CN",
    });

    assert.deepEqual(translated, ["译:Hello", "译:World"]);
  });

  it("handles an empty input without calling the provider", async () => {
    let calls = 0;
    const translated = await translateTexts([], {
      provider: defineProvider<undefined>({
        async translateBatch(batch) {
          calls += 1;
          return batch.items.map((item) => ({ id: item.id, text: item.text }));
        },
      }),
      targetLanguage: "zh-CN",
    });

    assert.deepEqual(translated, []);
    assert.equal(calls, 0);
  });

  it("translates repeated text separately, since dedupe stays explicit", async () => {
    const seen: string[] = [];
    const translated = await translateTexts(["Hi", "Hi"], {
      provider: defineProvider<undefined>({
        async translateBatch(batch) {
          seen.push(...batch.items.map((item) => item.id));
          return batch.items.map((item) => ({ id: item.id, text: "嗨" }));
        },
      }),
      targetLanguage: "zh-CN",
    });

    assert.deepEqual(seen, ["u0", "u1"]);
    assert.deepEqual(translated, ["嗨", "嗨"]);
  });
});

describe("toTranslationRecord", () => {
  it("converts the translation map into a plain object", async () => {
    const result = await translatePlan(createPlan(["Hello"]), {
      provider: createEchoProvider(() => "你好"),
      targetLanguage: "zh-CN",
    });

    assert.deepEqual(toTranslationRecord(result), { u0: "你好" });
    assert.deepEqual(JSON.parse(JSON.stringify(toTranslationRecord(result))), {
      u0: "你好",
    });
  });
});

describe("parseBatchOutput", () => {
  it("returns translations keyed by unit id", () => {
    const translations = parseBatchOutput(request(), [
      { id: "b", text: "世界" },
      { id: "a", text: "你好" },
    ]);

    assert.equal(translations.get("a"), "你好");
    assert.equal(translations.get("b"), "世界");
  });

  it("allows an empty translation when the source is blank", () => {
    const translations = parseBatchOutput(
      { targetLanguage: "zh-CN", items: [{ id: "a", text: "  ", context: undefined }] },
      [{ id: "a", text: "" }],
    );

    assert.equal(translations.get("a"), "");
  });

  it("rejects a payload that is not an array", () => {
    const error = responseErrorFrom(() =>
      parseBatchOutput(request(), { a: "你好" }),
    );

    assert.equal(error.code, TranslationErrorCode.ResponseInvalidContainer);
    assert.equal(error.retryInstruction, RESPONSE_FORMAT_RETRY_INSTRUCTION);
  });

  it("rejects malformed, unexpected, duplicated and missing items", () => {
    const cases: [unknown, string, string | undefined][] = [
      [[{ id: "a" }], TranslationErrorCode.ResponseInvalidItem, undefined],
      [
        [{ id: "a", text: "你好" }, { id: "zz", text: "?" }],
        TranslationErrorCode.ResponseUnexpectedId,
        "zz",
      ],
      [
        [{ id: "a", text: "你好" }, { id: "a", text: "再来" }],
        TranslationErrorCode.ResponseDuplicateId,
        "a",
      ],
      [[{ id: "a", text: "你好" }], TranslationErrorCode.ResponseMissingId, "b"],
      [
        [{ id: "a", text: "你好" }, { id: "b", text: "   " }],
        TranslationErrorCode.ResponseMissingId,
        "b",
      ],
    ];

    for (const [raw, code, unitId] of cases) {
      const error = responseErrorFrom(() => parseBatchOutput(request(), raw));
      assert.equal(error.code, code);
      assert.equal(error.reason, "response");
      assert.equal(error.retryInstruction, RESPONSE_FORMAT_RETRY_INSTRUCTION);
      if (unitId !== undefined) assert.equal(error.details.unitId, unitId);
    }
  });

  it("reports the index of a malformed item", () => {
    const error = responseErrorFrom(() =>
      parseBatchOutput(request(), [{ id: "a", text: "你好" }, 42]),
    );

    assert.equal(error.code, TranslationErrorCode.ResponseInvalidItem);
    assert.equal(error.details.outputIndex, 1);
  });
});

describe("retry shorthand", () => {
  it("treats a number as maxRetries", async () => {
    let calls = 0;
    const provider = defineProvider<undefined>({
      async translateBatch() {
        calls += 1;
        return [];
      },
    });

    await assert.rejects(
      translatePlan(createPlan(["Hello"]), {
        provider,
        targetLanguage: "zh-CN",
        retry: 0,
      }),
    );
    assert.equal(calls, 1);

    calls = 0;
    await assert.rejects(
      translatePlan(createPlan(["Hello"]), {
        provider,
        targetLanguage: "zh-CN",
        retry: 1,
      }),
    );
    assert.equal(calls, 2);
  });

  it("still accepts a full policy object", async () => {
    let calls = 0;
    await assert.rejects(
      translatePlan(createPlan(["Hello"]), {
        provider: defineProvider<undefined>({
          async translateBatch() {
            calls += 1;
            return [];
          },
        }),
        targetLanguage: "zh-CN",
        retry: { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0 },
      }),
    );
    assert.equal(calls, 2);
  });
});

describe("result stats", () => {
  it("separates fresh work from checkpoint hits", async () => {
    const plan = createPlan(["One", "Two"], { id: "stats-doc" });
    const provider = createEchoProvider<undefined>((text) => "译:" + text);

    const first = await translatePlan(plan, {
      provider,
      targetLanguage: "zh-CN",
    });

    assert.equal(first.stats.uniqueUnits, 2);
    assert.equal(first.stats.freshlyTranslatedUnits, 2);
    assert.equal(first.stats.fromCheckpointUnits, 0);
    assert.equal(first.stats.characters, 6);

    let calls = 0;
    const resumed = await translatePlan(plan, {
      provider: defineProvider<undefined>({
        async translateBatch(batch) {
          calls += 1;
          return batch.items.map((item) => ({ id: item.id, text: item.text }));
        },
      }),
      targetLanguage: "zh-CN",
      checkpoint: first.checkpoint,
    });

    assert.equal(calls, 0);
    assert.equal(resumed.stats.uniqueUnits, 2);
    assert.equal(resumed.stats.freshlyTranslatedUnits, 0);
    assert.equal(resumed.stats.fromCheckpointUnits, 2);
    assert.equal(resumed.translations.get("u0"), "译:One");
  });

  it("counts deduplicated units once", async () => {
    const result = await translatePlan(
      createPlan([
        { id: "a", text: "Hello", dedupeKey: "greeting" },
        { id: "b", text: "Hello", dedupeKey: "greeting" },
      ]),
      {
        provider: createEchoProvider<undefined>(() => "你好"),
        targetLanguage: "zh-CN",
      },
    );

    assert.equal(result.stats.uniqueUnits, 1);
    assert.equal(result.stats.freshlyTranslatedUnits, 1);
    assert.equal(result.translations.get("b"), "你好");
  });
});
