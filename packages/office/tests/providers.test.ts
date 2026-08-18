import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProviderFromConfig } from "../src/providers/factory.js";
import { GenericHttpProvider } from "../src/providers/generic-http.js";
import { TranslationProviderError } from "@easy-translate/core";

describe("provider factory", () => {
  it("loads a user-supplied provider module relative to config", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const provider = await createProviderFromConfig(
      {
        type: "module",
        module: "./fixtures/custom-provider.mjs",
        options: { prefix: "自定义:" },
      },
      here,
    );
    const output = await provider.translateBatch({
      targetLanguage: "zh-CN",
      items: [
        {
          id: "one",
          text: "Hello",
          context: {
            format: "word",
            part: "word/document.xml",
            kind: "body",
          },
        },
      ],
    });

    assert.deepEqual(output, [{ id: "one", text: "自定义:Hello" }]);
  });

  it("classifies rate limits and preserves Retry-After", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("busy", {
        status: 429,
        headers: { "retry-after": "2.5" },
      })) as typeof fetch;

    try {
      const provider = new GenericHttpProvider({
        type: "generic-http",
        url: "https://provider.test/translate",
      });
      await assert.rejects(
        provider.translateBatch({
          targetLanguage: "zh-CN",
          items: [
            {
              id: "one",
              text: "Hello",
              context: {
                format: "word",
                part: "word/document.xml",
                kind: "body",
              },
            },
          ],
        }),
        (error: unknown) => {
          assert.ok(error instanceof TranslationProviderError);
          assert.equal(error.kind, "rate-limit");
          assert.equal(error.retryable, true);
          assert.equal(error.retryAfterMs, 2_500);
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
