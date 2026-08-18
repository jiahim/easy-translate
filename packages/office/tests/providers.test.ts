import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProviderFromConfig } from "../src/providers/factory.js";
import { GenericHttpProvider } from "../src/providers/generic-http.js";
import {
  OfficeTranslatorError,
  ProviderResponseError,
} from "../src/errors.js";
import {
  TranslationErrorCode,
  TranslationProviderError,
  TranslationResponseError,
} from "@easy-translate/core";

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
          assert.equal(error.code, TranslationErrorCode.ProviderRateLimit);
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

  it("rejects malformed provider URLs without making a request", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return Response.json({ translations: [{ id: "one", text: "你好" }] });
    }) as typeof fetch;

    try {
      const provider = new GenericHttpProvider({
        type: "generic-http",
        url: "://not-a-provider-url",
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
          assert.equal(
            error.code,
            TranslationErrorCode.ProviderInvalidRequest,
          );
          assert.equal(error.retryable, false);
          return true;
        },
      );
      assert.equal(calls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("normalizes response-body transport failures", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error("socket reset while reading"));
          },
        }),
      )) as typeof fetch;

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
          assert.equal(error.code, TranslationErrorCode.ProviderNetwork);
          assert.equal(error.retryable, true);
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("preserves safe HTTP metadata without exposing the response body", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json(
        {
          error: "sensitive upstream diagnostic",
          code: "vendor_busy",
          requestId: "request-safe-123",
        },
        {
          status: 429,
          headers: {
            "retry-after": "2.5",
            "x-request-id": "request-header-fallback",
          },
        },
      )) as typeof fetch;

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
          assert.equal(error.code, TranslationErrorCode.ProviderRateLimit);
          assert.equal(error.providerCode, "vendor_busy");
          assert.equal(error.retryAfterMs, 2_500);
          assert.equal(error.details.requestId, "request-safe-123");
          assert.doesNotMatch(error.message, /sensitive upstream diagnostic/u);
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("classifies HTTP gateway timeouts as provider timeouts", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("gateway timeout", { status: 504 })) as typeof fetch;

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
          assert.equal(error.code, TranslationErrorCode.ProviderTimeout);
          assert.equal(error.retryable, true);
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("classifies malformed provider output as a retryable response error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("not valid JSON", {
        status: 200,
        headers: { "content-type": "application/json" },
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
          assert.ok(error instanceof ProviderResponseError);
          assert.ok(error instanceof OfficeTranslatorError);
          assert.ok(error instanceof TranslationResponseError);
          assert.equal(error.code, TranslationErrorCode.ResponseInvalidContainer);
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
