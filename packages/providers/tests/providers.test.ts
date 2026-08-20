import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  TranslationErrorCode,
  TranslationProviderError,
  TranslationResponseError,
  type TranslationBatchRequest,
} from "@easy-translate/core";
import {
  createBailingProvider,
  createChatCompletionsProvider,
  createCustomProvider,
  createDeepSeekProvider,
  createDoubaoProvider,
  createGenericHttpProvider,
  createGlmCNProvider,
  createGlmProvider,
  createKimiCNProvider,
  createKimiProvider,
  createMinimaxCNProvider,
  createMinimaxProvider,
  createOpenAIProvider,
  createSiliconFlowCNProvider,
  createSiliconFlowProvider,
  createZhipuCNProvider,
  createZhipuProvider,
  VENDOR_PRESETS,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));

function batch(): TranslationBatchRequest {
  return {
    targetLanguage: "zh-CN",
    items: [{ id: "one", text: "Hello", context: undefined }],
  };
}

async function withFetch<T>(
  impl: typeof fetch,
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

describe("createGenericHttpProvider", () => {
  it("classifies rate limits and preserves Retry-After", async () => {
    await withFetch(
      (async () =>
        new Response("busy", {
          status: 429,
          headers: { "retry-after": "2.5" },
        })) as typeof fetch,
      async () => {
        const provider = createGenericHttpProvider({
          url: "https://provider.test/translate",
        });
        await assert.rejects(
          provider.translateBatch(batch()),
          (error: unknown) => {
            assert.ok(error instanceof TranslationProviderError);
            assert.equal(error.code, TranslationErrorCode.ProviderRateLimit);
            assert.equal(error.retryable, true);
            assert.equal(error.retryAfterMs, 2_500);
            return true;
          },
        );
      },
    );
  });

  it("rejects malformed URLs without making a request", async () => {
    let calls = 0;
    await withFetch(
      (async () => {
        calls += 1;
        return Response.json({ translations: [{ id: "one", text: "你好" }] });
      }) as typeof fetch,
      async () => {
        const provider = createGenericHttpProvider({
          url: "://not-a-provider-url",
        });
        await assert.rejects(
          provider.translateBatch(batch()),
          (error: unknown) => {
            assert.ok(error instanceof TranslationProviderError);
            assert.equal(
              error.code,
              TranslationErrorCode.ProviderInvalidRequest,
            );
            return true;
          },
        );
        assert.equal(calls, 0);
      },
    );
  });

  it("classifies malformed JSON as a retryable response error", async () => {
    await withFetch(
      (async () =>
        new Response("not valid JSON", {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
      async () => {
        const provider = createGenericHttpProvider({
          url: "https://provider.test/translate",
        });
        await assert.rejects(
          provider.translateBatch(batch()),
          (error: unknown) => {
            assert.ok(error instanceof TranslationResponseError);
            assert.equal(
              error.code,
              TranslationErrorCode.ResponseInvalidContainer,
            );
            return true;
          },
        );
      },
    );
  });
});

describe("createChatCompletionsProvider", () => {
  it("parses fenced JSON translations", async () => {
    const provider = createChatCompletionsProvider({
      apiKey: "sk-test",
      baseUrl: "https://api.example.com/v1",
      model: "demo-model",
    });

    const output = await withFetch(
      (async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as {
          model: string;
          messages: { role: string; content: string }[];
        };
        assert.equal(body.model, "demo-model");
        assert.equal(body.messages[0]?.role, "system");
        return Response.json({
          choices: [
            {
              message: {
                content:
                  '```json\n{"translations":[{"id":"one","text":"你好"}]}\n```',
              },
            },
          ],
        });
      }) as typeof fetch,
      () => provider.translateBatch(batch()),
    );

    assert.deepEqual(output, [{ id: "one", text: "你好" }]);
  });
});

describe("vendor factories", () => {
  async function capturedRequest(
    create: () => ReturnType<typeof createDeepSeekProvider>,
  ): Promise<{ url: string; model: string; authorization: string | null }> {
    let url = "";
    let model = "";
    let authorization: string | null = null;
    await withFetch(
      (async (input, init) => {
        url = String(input);
        authorization = new Headers(init?.headers).get("authorization");
        model = (JSON.parse(String(init?.body)) as { model: string }).model;
        return Response.json({
          choices: [
            {
              message: {
                content: '{"translations":[{"id":"one","text":"你好"}]}',
              },
            },
          ],
        });
      }) as typeof fetch,
      () => create().translateBatch(batch()),
    );
    return { url, model, authorization };
  }

  it("uses DeepSeek defaults", async () => {
    const request = await capturedRequest(() =>
      createDeepSeekProvider({ apiKey: "sk-deepseek" }),
    );
    assert.equal(
      request.url,
      "https://api.deepseek.com/v1/chat/completions",
    );
    assert.equal(request.model, "deepseek-chat");
    assert.equal(request.authorization, "Bearer sk-deepseek");
  });

  it("uses OpenAI defaults", async () => {
    const request = await capturedRequest(() =>
      createOpenAIProvider({ apiKey: "sk-openai", model: "gpt-4o-mini" }),
    );
    assert.equal(request.url, "https://api.openai.com/v1/chat/completions");
    assert.equal(request.model, "gpt-4o-mini");
  });

  it("uses Kimi international defaults", async () => {
    const request = await capturedRequest(() =>
      createKimiProvider({ apiKey: "sk-kimi" }),
    );
    assert.equal(request.url, "https://api.moonshot.ai/v1/chat/completions");
    assert.equal(request.model, "kimi-k3");
  });

  it("uses Kimi China factory", async () => {
    const request = await capturedRequest(() =>
      createKimiCNProvider({ apiKey: "sk-kimi" }),
    );
    assert.equal(request.url, "https://api.moonshot.cn/v1/chat/completions");
    assert.equal(request.model, "kimi-k3");
  });

  it("uses MiniMax international defaults", async () => {
    const request = await capturedRequest(() =>
      createMinimaxProvider({ apiKey: "sk-minimax" }),
    );
    assert.equal(request.url, "https://api.minimax.io/v1/chat/completions");
    assert.equal(request.model, "MiniMax-M2.7");
  });

  it("uses MiniMax China factory", async () => {
    const request = await capturedRequest(() =>
      createMinimaxCNProvider({ apiKey: "sk-minimax" }),
    );
    assert.equal(request.url, "https://api.minimaxi.com/v1/chat/completions");
  });

  it("uses Zhipu international defaults", async () => {
    const request = await capturedRequest(() =>
      createZhipuProvider({ apiKey: "sk-glm" }),
    );
    assert.equal(request.url, "https://api.z.ai/api/paas/v4/chat/completions");
    assert.equal(request.model, "glm-5.1");
  });

  it("uses Zhipu China factory", async () => {
    const request = await capturedRequest(() =>
      createZhipuCNProvider({ apiKey: "sk-glm" }),
    );
    assert.equal(
      request.url,
      "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    );
  });

  it("aliases createGlmProvider to international Zhipu", async () => {
    const request = await capturedRequest(() =>
      createGlmProvider({ apiKey: "sk-glm", model: "glm-4.5" }),
    );
    assert.equal(request.url, "https://api.z.ai/api/paas/v4/chat/completions");
    assert.equal(request.model, "glm-4.5");
  });

  it("aliases createGlmCNProvider to China Zhipu", async () => {
    const request = await capturedRequest(() =>
      createGlmCNProvider({ apiKey: "sk-glm" }),
    );
    assert.equal(
      request.url,
      "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    );
  });

  it("uses BaiLing defaults", async () => {
    const request = await capturedRequest(() =>
      createBailingProvider({ apiKey: "sk-ling" }),
    );
    assert.equal(request.url, "https://api.tbox.cn/v1/chat/completions");
    assert.equal(request.model, "Ling-2.5-1T");
  });

  it("requires a SiliconFlow model", async () => {
    const request = await capturedRequest(() =>
      createSiliconFlowProvider({
        apiKey: "sk-sf",
        model: "moonshotai/Kimi-K3",
      }),
    );
    assert.equal(request.url, "https://api.siliconflow.com/v1/chat/completions");
    assert.equal(request.model, "moonshotai/Kimi-K3");
  });

  it("uses SiliconFlow China factory", async () => {
    const request = await capturedRequest(() =>
      createSiliconFlowCNProvider({
        apiKey: "sk-sf",
        model: "moonshotai/Kimi-K3",
      }),
    );
    assert.equal(request.url, "https://api.siliconflow.cn/v1/chat/completions");
  });

  it("rejects a required-model vendor without a model id", () => {
    assert.throws(
      () => createDoubaoProvider({ apiKey: "sk-ark", model: "" }),
      (error: unknown) => {
        assert.ok(error instanceof TranslationProviderError);
        assert.equal(error.code, TranslationErrorCode.ProviderInvalidRequest);
        return true;
      },
    );
  });

  it("lets a named factory override the default model", async () => {
    const request = await capturedRequest(() =>
      createKimiCNProvider({
        apiKey: "sk-kimi",
        model: "kimi-k2.7-code",
      }),
    );
    assert.equal(request.url, "https://api.moonshot.cn/v1/chat/completions");
    assert.equal(request.model, "kimi-k2.7-code");
  });
});

describe("createCustomProvider", () => {
  async function capturedRequest(
    create: () => ReturnType<typeof createCustomProvider>,
  ): Promise<{ url: string; model: string }> {
    let url = "";
    let model = "";
    await withFetch(
      (async (input, init) => {
        url = String(input);
        model = (JSON.parse(String(init?.body)) as { model: string }).model;
        return Response.json({
          choices: [
            {
              message: {
                content: '{"translations":[{"id":"one","text":"你好"}]}',
              },
            },
          ],
        });
      }) as typeof fetch,
      () => create().translateBatch(batch()),
    );
    return { url, model };
  }

  it("sends OpenAI-compatible Chat Completions by default", async () => {
    const request = await capturedRequest(() =>
      createCustomProvider({
        apiKey: "sk-custom",
        baseUrl: "https://llm.internal.example/v1",
        model: "internal-translate",
      }),
    );
    assert.equal(
      request.url,
      "https://llm.internal.example/v1/chat/completions",
    );
    assert.equal(request.model, "internal-translate");
  });

  it("uses a full url without appending chat/completions", async () => {
    const request = await capturedRequest(() =>
      createCustomProvider({
        apiKey: "sk-custom",
        url: "https://gateway.example/v1/chat/completions",
        model: "routed-model",
      }),
    );
    assert.equal(request.url, "https://gateway.example/v1/chat/completions");
    assert.equal(request.model, "routed-model");
  });

  it("requires baseUrl or url for Chat Completions", () => {
    assert.throws(
      () =>
        createCustomProvider({
          apiKey: "sk-custom",
          model: "demo",
        }),
      (error: unknown) => {
        assert.ok(error instanceof TranslationProviderError);
        assert.equal(error.code, TranslationErrorCode.ProviderInvalidRequest);
        return true;
      },
    );
  });

  it("requires a model for Chat Completions", () => {
    assert.throws(
      () =>
        createCustomProvider({
          apiKey: "sk-custom",
          baseUrl: "https://llm.internal.example/v1",
          model: "",
        }),
      (error: unknown) => {
        assert.ok(error instanceof TranslationProviderError);
        assert.equal(error.code, TranslationErrorCode.ProviderInvalidRequest);
        return true;
      },
    );
  });

  it("forwards generic-http protocol to the HTTP provider", async () => {
    const output = await withFetch(
      (async (input) => {
        assert.equal(String(input), "https://provider.test/translate");
        return Response.json({ translations: [{ id: "one", text: "你好" }] });
      }) as typeof fetch,
      () =>
        createCustomProvider({
          protocol: "generic-http",
          url: "https://provider.test/translate",
        }).translateBatch(batch()),
    );
    assert.deepEqual(output, [{ id: "one", text: "你好" }]);
  });
});

describe("vendor catalog", () => {
  it("exports a factory for every preset", async () => {
    const exported = (await import("../src/index.js")) as Record<
      string,
      unknown
    >;
    for (const preset of Object.values(VENDOR_PRESETS)) {
      assert.equal(
        typeof exported[preset.factory],
        "function",
        "missing export " + preset.factory,
      );
    }
    assert.equal(typeof exported.createGlmProvider, "function");
    assert.equal(typeof exported.createGlmCNProvider, "function");
    assert.equal(typeof exported.createCustomProvider, "function");
  });

  it("lists every preset factory in README", () => {
    const readme = readFileSync(join(here, "../README.md"), "utf8");
    for (const preset of Object.values(VENDOR_PRESETS)) {
      assert.ok(
        readme.includes("`" + preset.factory + "`"),
        "README missing factory " + preset.factory,
      );
    }
    assert.match(readme, /createCustomProvider/u);
    assert.match(readme, /model: "deepseek-v4-flash"/u);
    assert.match(readme, /createKimiCNProvider/u);
  });
});

describe("export surface", () => {
  it("re-exports named factories without export *", () => {
    const source = readFileSync(join(here, "../src/index.ts"), "utf8");
    assert.equal(source.includes("export *"), false);
    assert.match(
      source,
      /export \{ createCustomProvider \} from "\.\/custom\.js";/u,
    );
    assert.match(source, /createDeepSeekProvider,/u);
    assert.match(source, /from "\.\/vendors\.js";/u);
  });
});
