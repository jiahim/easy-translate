import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHAT_PROVIDER_PRESETS,
  fetchProviderModels,
  providerPreset,
  recommendedProviderModels,
} from "../lib/provider-catalog.js";

describe("browser provider catalog", () => {
  it("loads and normalizes OpenAI-compatible model metadata", async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    let authorization = "";
    globalThis.fetch = (async (input, init) => {
      requestedUrl = String(input);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return Response.json({
        data: [
          {
            id: "vendor/flash-model",
            name: "Flash Model",
            owned_by: "vendor",
            context_length: 128_000,
            pricing: { prompt: "0.000001", completion: "0.000002" },
          },
          { id: "vendor/text-embedding-model" },
        ],
      });
    }) as typeof fetch;

    try {
      const models = await fetchProviderModels(
        providerPreset("openrouter"),
        "https://openrouter.ai/api/v1",
        "secret-key",
      );
      assert.equal(
        requestedUrl,
        "https://openrouter.ai/api/v1/models?output_modalities=text",
      );
      assert.equal(authorization, "Bearer secret-key");
      assert.deepEqual(models, [
        {
          id: "vendor/flash-model",
          name: "Flash Model",
          owner: "vendor",
          contextLength: 128_000,
          promptPricePerMillion: 1,
          completionPricePerMillion: 2,
          isFree: false,
          source: "remote",
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("loads installed Ollama models without sending an API key", async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    let authorization: string | null = null;
    globalThis.fetch = (async (input, init) => {
      requestedUrl = String(input);
      authorization = new Headers(init?.headers).get("authorization");
      return Response.json({
        models: [
          {
            name: "qwen3:8b",
            details: { parameter_size: "8B", quantization_level: "Q4_K_M" },
          },
        ],
      });
    }) as typeof fetch;

    try {
      const models = await fetchProviderModels(
        providerPreset("ollama"),
        "http://localhost:11434/v1",
        "",
      );
      assert.equal(requestedUrl, "http://localhost:11434/api/tags");
      assert.equal(authorization, null);
      assert.equal(models[0]?.id, "qwen3:8b");
      assert.equal(models[0]?.description, "8B · Q4_K_M");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("includes all approved presets and Bailian recommendations", () => {
    assert.deepEqual(
      CHAT_PROVIDER_PRESETS.map((preset) => preset.id),
      [
        "siliconflow",
        "deepseek",
        "bailian",
        "openrouter",
        "gemini",
        "ollama",
        "custom",
      ],
    );
    assert.deepEqual(
      recommendedProviderModels(providerPreset("bailian")).map(
        (model) => model.id,
      ),
      ["qwen3.7-flash", "qwen3.7-plus", "qwen3.7-max"],
    );
  });
});
