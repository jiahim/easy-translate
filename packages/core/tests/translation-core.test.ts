import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  retryOperation,
  translatePlan,
  TranslationProviderError,
  type TranslationBatchRequest,
  type TranslationCheckpoint,
  type TranslationPlan,
  type TranslationProvider,
} from "../src/index.js";

interface TestContext {
  role: string;
}

function plan(
  units: TranslationPlan<TestContext>["units"],
): TranslationPlan<TestContext> {
  return {
    schemaVersion: 1,
    document: { id: "test-document", format: "test" },
    units,
  };
}

describe("translation core", () => {
  it("honors provider Retry-After and skips permanent failures", async () => {
    const waits: number[] = [];
    let calls = 0;
    const value = await retryOperation(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new TranslationProviderError("busy", {
            kind: "rate-limit",
            retryable: true,
            retryAfterMs: 2_500,
            status: 429,
          });
        }
        return "ok";
      },
      {
        baseDelayMs: 10,
        maxDelayMs: 100,
        maxRetries: 1,
        runtime: {
          random: () => 0,
          sleep: async (milliseconds) => {
            waits.push(milliseconds);
          },
        },
      },
    );
    assert.equal(value, "ok");
    assert.deepEqual(waits, [2_500]);

    calls = 0;
    await assert.rejects(
      retryOperation(
        async () => {
          calls += 1;
          throw new TranslationProviderError("unauthorized", {
            kind: "authentication",
            retryable: false,
            status: 401,
          });
        },
        { maxRetries: 3 },
      ),
      /unauthorized/u,
    );
    assert.equal(calls, 1);
  });

  it("deduplicates units, respects batch boundaries and expands every id", async () => {
    const requests: TranslationBatchRequest<TestContext>[] = [];
    const provider: TranslationProvider<TestContext> = {
      async translateBatch(request) {
        requests.push(request);
        return request.items.map((item) => ({
          id: item.id,
          text: "译:" + item.text,
        }));
      },
    };
    const result = await translatePlan(
      plan([
        {
          id: "a",
          text: "Hello",
          context: { role: "body" },
          batchKey: "section-1",
          dedupeKey: "Hello",
        },
        {
          id: "b",
          text: "Hello",
          context: { role: "body" },
          batchKey: "section-1",
          dedupeKey: "Hello",
        },
        {
          id: "c",
          text: "World",
          context: { role: "heading" },
          batchKey: "section-2",
        },
      ]),
      { provider, targetLanguage: "zh-CN" },
    );

    assert.equal(requests.length, 2);
    assert.deepEqual(
      requests.map((request) => request.items.map((item) => item.id)),
      [["a"], ["c"]],
    );
    assert.equal(result.translations.get("a"), "译:Hello");
    assert.equal(result.translations.get("b"), "译:Hello");
    assert.equal(result.translations.get("c"), "译:World");
    assert.equal(result.stats.translatedUnits, 2);
  });

  it("retries incomplete provider output with a format repair instruction", async () => {
    const requests: TranslationBatchRequest<TestContext>[] = [];
    const provider: TranslationProvider<TestContext> = {
      async translateBatch(request) {
        requests.push(structuredClone(request));
        if (requests.length === 1) return [];
        return [{ id: request.items[0]!.id, text: "完成" }];
      },
    };
    const result = await translatePlan(
      plan([
        { id: "one", text: "Translate me", context: { role: "body" } },
      ]),
      {
        provider,
        targetLanguage: "zh-CN",
        retry: { baseDelayMs: 0, maxDelayMs: 0, maxRetries: 1 },
      },
    );

    assert.equal(requests.length, 2);
    assert.match(requests[1]?.instructions ?? "", /RESPONSE FORMAT RETRY/u);
    assert.equal(result.translations.get("one"), "完成");
  });

  it("applies a quality policy and reports quality retries", async () => {
    const retryReasons: string[] = [];
    let calls = 0;
    const result = await translatePlan(
      plan([
        { id: "one", text: "Translate me", context: { role: "body" } },
      ]),
      {
        provider: {
          async translateBatch(request) {
            calls += 1;
            return [{
              id: request.items[0]!.id,
              text: calls === 1 ? "Translate me" : "翻译完成",
            }];
          },
        },
        targetLanguage: "zh-CN",
        retry: { baseDelayMs: 0, maxDelayMs: 0, maxRetries: 1 },
        qualityPolicy({ translatedText }) {
          return translatedText === "Translate me"
            ? {
                message: "The source text was returned unchanged.",
                retryInstruction: "QUALITY RETRY: translate all prose.",
              }
            : undefined;
        },
        onProgress(progress) {
          if (progress.lastRetry) retryReasons.push(progress.lastRetry.reason);
        },
      },
    );

    assert.equal(calls, 2);
    assert.ok(retryReasons.includes("quality"));
    assert.equal(result.translations.get("one"), "翻译完成");
  });

  it("persists completed units and resumes only pending batches", async () => {
    const translationPlan = plan([
      { id: "one", text: "One", context: { role: "body" } },
      { id: "two", text: "Two", context: { role: "body" } },
      { id: "three", text: "Three", context: { role: "body" } },
    ]);
    let checkpoint: TranslationCheckpoint | undefined;
    let calls = 0;
    await assert.rejects(
      translatePlan(translationPlan, {
        provider: {
          async translateBatch(request) {
            calls += 1;
            if (calls === 2) throw new Error("provider stopped");
            return request.items.map((item) => ({
              id: item.id,
              text: "旧:" + item.text,
            }));
          },
        },
        targetLanguage: "zh-CN",
        batchSize: 1,
        concurrency: 1,
        retry: { maxRetries: 0 },
        onCheckpoint(value) {
          checkpoint = structuredClone(value);
        },
      }),
      /provider stopped/u,
    );
    assert.deepEqual(
      checkpoint?.translations.map((item) => item.id),
      ["one"],
    );

    const resumedIds: string[] = [];
    const result = await translatePlan(translationPlan, {
      provider: {
        async translateBatch(request) {
          resumedIds.push(...request.items.map((item) => item.id));
          return request.items.map((item) => ({
            id: item.id,
            text: "新:" + item.text,
          }));
        },
      },
      targetLanguage: "zh-CN",
      batchSize: 1,
      concurrency: 1,
      checkpoint,
    });

    assert.deepEqual(resumedIds, ["two", "three"]);
    assert.equal(result.translations.get("one"), "旧:One");
    assert.equal(result.translations.get("three"), "新:Three");
  });
});
