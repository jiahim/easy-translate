import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ProviderTimeoutError,
  type TranslationActivity,
  type TranslationBatchRequest,
} from "../lib/office.js";
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
          error instanceof ProviderTimeoutError &&
          /1 秒内没有开始响应/u.test(error.message),
      );
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
});

describe("browser generic provider", () => {
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

  it("includes the request ID from a trial stream error", async () => {
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
        (error) => {
          assert.ok(error instanceof ProviderTimeoutError);
          assert.match(
            error.message,
            /连接免费翻译模型超时.*请求 ID：stream-error-id/u,
          );
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("waits and retries transient concurrency limits", async () => {
    const originalFetch = globalThis.fetch;
    let attempts = 0;
    const activities: TranslationActivity[] = [];
    globalThis.fetch = (async () => {
      attempts += 1;
      if (attempts === 1) {
        return Response.json(
          { error: "当前翻译任务较多，请稍后再试。", code: "concurrency_exceeded" },
          { status: 429, headers: { "retry-after": "0" } },
        );
      }
      return Response.json({ translations: [{ id: "one", text: "你好" }] });
    }) as typeof fetch;

    try {
      const provider = new BrowserGenericProvider({ url: "/api/translate" });
      const output = await provider.translateBatch(
        request,
        undefined,
        (activity) => activities.push(activity),
      );
      assert.equal(attempts, 2);
      assert.equal(activities[0]?.phase, "retry");
      assert.deepEqual(output, [{ id: "one", text: "你好" }]);
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
      await assert.rejects(provider.translateBatch(request), /每日|额度已用完/u);
      assert.equal(attempts, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("includes the server request ID in error messages", async () => {
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
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes("请求 ID：diagnostic-request-id"),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
