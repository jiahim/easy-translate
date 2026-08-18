import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type TranslationActivity,
  type TranslationBatchRequest,
} from "../lib/office.js";
import {
  TranslationErrorCode,
  TranslationProviderError,
  TranslationResponseError,
} from "@easy-translate/core";
import {
  BrowserChatProvider,
  BrowserGenericProvider,
} from "../lib/providers.js";

const request: TranslationBatchRequest = {
  targetLanguage: "zh-CN",
  items: [
    {
      id: "one",
      text: "Hello",
      context: { format: "word", part: "word/document.xml", kind: "body" },
    },
  ],
};

describe("browser chat provider", () => {
  it("uses fast streaming mode and reports response activity", async () => {
    const originalFetch = globalThis.fetch;
    let sentBody: Record<string, unknown> | undefined;
    const activities: TranslationActivity[] = [];
    const translated =
      '{"translations":[{"id":"one","text":"你好"}]}';
    const chunks = [translated.slice(0, 18), translated.slice(18)];

    globalThis.fetch = (async (_input, init) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(
              new TextEncoder().encode(
                "data: " +
                  JSON.stringify({ choices: [{ delta: { content: chunk } }] }) +
                  "\n\n",
              ),
            );
          }
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    try {
      const provider = new BrowserChatProvider({
        baseUrl: "https://api.siliconflow.cn/v1",
        model: "fast-model",
        fastMode: true,
        requestTimeoutMs: 100,
      });
      const result = await provider.translateBatch(
        request,
        undefined,
        (activity) => activities.push(activity),
      );

      assert.equal(sentBody?.stream, true);
      assert.equal(sentBody?.enable_thinking, false);
      assert.equal(sentBody?.max_tokens, 3_072);
      assert.deepEqual(result, [{ id: "one", text: "你好" }]);
      assert.ok(activities.length >= 2);
      assert.equal(activities.at(-1)?.receivedCharacters, translated.length);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("cancels and releases a chat stream after the DONE event", async () => {
    const originalFetch = globalThis.fetch;
    let cancelled = false;
    globalThis.fetch = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"choices":[{"delta":{"content":"{\\"translations\\":[{\\"id\\":\\"one\\",\\"text\\":\\"你好\\"}]}"}}]}\n\n' +
                "data: [DONE]\n\n",
            ),
          );
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    try {
      const provider = new BrowserChatProvider({
        baseUrl: "https://provider.test/v1",
        model: "streaming-model",
        fastMode: true,
      });
      assert.deepEqual(await provider.translateBatch(request), [
        { id: "one", text: "你好" },
      ]);
      assert.equal(cancelled, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fails clearly when the provider sends no response headers", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener(
          "abort",
          () => reject(signal.reason),
          { once: true },
        );
      })) as typeof fetch;

    try {
      const provider = new BrowserChatProvider({
        baseUrl: "https://provider.test/v1",
        model: "slow-model",
        requestTimeoutMs: 15,
      });
      await assert.rejects(
        provider.translateBatch(request),
        (error: unknown) =>
          error instanceof TranslationProviderError &&
          error.code === TranslationErrorCode.ProviderTimeout &&
          error.retryable,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps caller cancellation linked while reading the response body", async () => {
    const originalFetch = globalThis.fetch;
    const externalController = new AbortController();
    const cancellation = new Error("caller cancelled");
    let requestSignal: AbortSignal | undefined;
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;

    globalThis.fetch = (async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          requestSignal?.addEventListener(
            "abort",
            () => controller.error(requestSignal?.reason),
            { once: true },
          );
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    try {
      const provider = new BrowserChatProvider({
        baseUrl: "https://provider.test/v1",
        model: "streaming-model",
        fastMode: true,
      });
      const pending = provider.translateBatch(
        request,
        externalController.signal,
      );
      await Promise.resolve();
      await Promise.resolve();

      externalController.abort(cancellation);
      const signalStayedLinked = requestSignal?.aborted;
      if (!signalStayedLinked) streamController?.error(cancellation);

      await assert.rejects(pending, (error: unknown) => error === cancellation);
      assert.equal(signalStayedLinked, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("accepts a complete translation JSON object wrapped in a short explanation", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({
        choices: [
          {
            message: {
              content:
                '翻译结果如下：\n{"translations":[{"id":"one","text":"你好"}]}\n请查收。',
            },
          },
        ],
      })) as typeof fetch;

    try {
      const provider = new BrowserChatProvider({
        baseUrl: "https://provider.test/v1",
        model: "wrapped-json-model",
        fastMode: false,
      });
      assert.deepEqual(await provider.translateBatch(request), [
        { id: "one", text: "你好" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("classifies malformed model JSON as a retryable response error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({
        choices: [{ message: { content: "not a translation object" } }],
      })) as typeof fetch;

    try {
      const provider = new BrowserChatProvider({
        baseUrl: "https://provider.test/v1",
        model: "malformed-json-model",
        fastMode: false,
      });
      await assert.rejects(
        provider.translateBatch(request),
        (error: unknown) => {
          assert.ok(error instanceof TranslationResponseError);
          assert.equal(
            error.code,
            TranslationErrorCode.ResponseInvalidContainer,
          );
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("browser generic provider", () => {
  it("accepts a bare relative browser endpoint", async () => {
    const originalFetch = globalThis.fetch;
    let requestedEndpoint: RequestInfo | URL | undefined;
    globalThis.fetch = (async (input) => {
      requestedEndpoint = input;
      return Response.json({
        translations: [{ id: "one", text: "你好" }],
      });
    }) as typeof fetch;

    try {
      const provider = new BrowserGenericProvider({ url: "api/translate" });
      assert.deepEqual(await provider.translateBatch(request), [
        { id: "one", text: "你好" },
      ]);
      assert.equal(requestedEndpoint, "api/translate");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reads activity and validated results from the trial event stream", async () => {
    const originalFetch = globalThis.fetch;
    const activities: TranslationActivity[] = [];
    globalThis.fetch = (async () =>
      new Response(
        [
          ": connected\n\n",
          'event: activity\ndata: {"phase":"response","receivedCharacters":0}\n\n',
          'event: activity\ndata: {"phase":"retry","receivedCharacters":0,"retryAfterMs":0,"attempt":1,"retryReason":"format"}\n\n',
          'event: activity\ndata: {"phase":"stream","receivedCharacters":42}\n\n',
          'event: result\ndata: {"translations":[{"id":"one","text":"你好"}],"requestId":"stream-request-id"}\n\n',
        ].join(""),
        {
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "x-request-id": "stream-request-id",
          },
        },
      )) as typeof fetch;

    try {
      const provider = new BrowserGenericProvider({ url: "/api/translate" });
      const output = await provider.translateBatch(
        request,
        undefined,
        (activity) => activities.push(activity),
      );
      assert.deepEqual(output, [{ id: "one", text: "你好" }]);
      assert.deepEqual(activities, [
        { phase: "response", receivedCharacters: 0 },
        {
          phase: "retry",
          receivedCharacters: 0,
          retryAfterMs: 0,
          attempt: 1,
          retryReason: "format",
        },
        { phase: "stream", receivedCharacters: 42 },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("normalizes a trial stream error without exposing its raw message", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        'event: error\ndata: {"error":"连接免费翻译模型超时，请稍后重试。","code":"upstream_timeout","requestId":"stream-error-id"}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      )) as typeof fetch;

    try {
      const provider = new BrowserGenericProvider({ url: "/api/translate" });
      await assert.rejects(
        provider.translateBatch(request),
        (error: unknown) => {
          assert.ok(error instanceof TranslationProviderError);
          assert.equal(error.code, TranslationErrorCode.ProviderTimeout);
          assert.equal(error.retryable, true);
          assert.equal(error.providerCode, "upstream_timeout");
          assert.equal(error.details.requestId, "stream-error-id");
          assert.doesNotMatch(error.message, /连接免费翻译模型超时/u);
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("cancels and releases a generic stream when event parsing fails", async () => {
    const originalFetch = globalThis.fetch;
    let cancelled = false;
    globalThis.fetch = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode("event: result\ndata: not-json\n\n"),
          );
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    try {
      const provider = new BrowserGenericProvider({ url: "/api/translate" });
      await assert.rejects(
        provider.translateBatch(request),
        (error: unknown) => error instanceof TranslationResponseError,
      );
      assert.equal(cancelled, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("delegates transient HTTP retries to core and preserves metadata", async () => {
    const originalFetch = globalThis.fetch;
    let attempts = 0;
    const activities: TranslationActivity[] = [];
    globalThis.fetch = (async () => {
      attempts += 1;
      return Response.json(
        {
          error: "raw concurrency diagnostic",
          code: "concurrency_exceeded",
          requestId: "busy-request-id",
        },
        { status: 429, headers: { "retry-after": "0.001" } },
      );
    }) as typeof fetch;

    try {
      const provider = new BrowserGenericProvider({ url: "/api/translate" });
      await assert.rejects(
        provider.translateBatch(
          request,
          undefined,
          (activity) => activities.push(activity),
        ),
        (error: unknown) => {
          assert.ok(error instanceof TranslationProviderError);
          assert.equal(error.code, TranslationErrorCode.ProviderRateLimit);
          assert.equal(error.retryable, true);
          assert.equal(error.retryAfterMs, 1);
          assert.equal(error.providerCode, "concurrency_exceeded");
          assert.equal(error.details.requestId, "busy-request-id");
          assert.doesNotMatch(error.message, /raw concurrency diagnostic/u);
          return true;
        },
      );
      assert.equal(attempts, 1);
      assert.ok(activities.every((activity) => activity.phase !== "retry"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not retry an exhausted daily trial quota", async () => {
    const originalFetch = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return Response.json(
        { error: "今天的免费翻译字符额度已用完。", code: "daily_quota_exceeded" },
        { status: 429, headers: { "retry-after": "0" } },
      );
    }) as typeof fetch;

    try {
      const provider = new BrowserGenericProvider({ url: "/api/translate" });
      await assert.rejects(
        provider.translateBatch(request),
        (error: unknown) => {
          assert.ok(error instanceof TranslationProviderError);
          assert.equal(error.code, TranslationErrorCode.ProviderRateLimit);
          assert.equal(error.retryable, false);
          assert.equal(error.providerCode, "daily_quota_exceeded");
          return true;
        },
      );
      assert.equal(attempts, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("preserves a server request ID as safe structured detail", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json(
        {
          error: "连接免费翻译模型超时，请稍后重试。",
          code: "upstream_timeout",
          requestId: "diagnostic-request-id",
        },
        { status: 504 },
      )) as typeof fetch;

    try {
      const provider = new BrowserGenericProvider({ url: "/api/translate" });
      await assert.rejects(
        provider.translateBatch(request),
        (error: unknown) => {
          assert.ok(error instanceof TranslationProviderError);
          assert.equal(error.code, TranslationErrorCode.ProviderTimeout);
          assert.equal(error.details.requestId, "diagnostic-request-id");
          assert.doesNotMatch(error.message, /连接免费翻译模型超时/u);
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("prioritizes an HTTP authentication status over a conflicting provider code", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json(
        {
          error: "raw upstream diagnostic",
          code: "upstream_timeout",
        },
        { status: 401 },
      )) as typeof fetch;

    try {
      const provider = new BrowserGenericProvider({ url: "/api/translate" });
      await assert.rejects(
        provider.translateBatch(request),
        (error: unknown) => {
          assert.ok(error instanceof TranslationProviderError);
          assert.equal(
            error.code,
            TranslationErrorCode.ProviderAuthentication,
          );
          assert.equal(error.retryable, false);
          assert.equal(error.providerCode, "upstream_timeout");
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
