// Compile-only transcription of the snippets in README.md.
import {
  createEchoProvider,
  createPlan,
  defineProvider,
  isTranslationCoreError,
  parseBatchOutput,
  toTranslationRecord,
  translatePlan,
  translateTexts,
  TranslationErrorCode,
  TranslationProviderError,
} from "../src/index.js";

export async function quickStart(): Promise<void> {
  const translated = await translateTexts(["Hello", "World"], {
    provider: createEchoProvider((text) => "[zh] " + text),
    targetLanguage: "zh-CN",
  });

  console.log(translated);
}

const provider = defineProvider({
  name: "my-provider",
  async translateBatch(request, signal) {
    const response = await fetch("https://api.example.com/translate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: signal ?? null,
    });

    if (response.status === 429) {
      throw new TranslationProviderError(
        TranslationErrorCode.ProviderRateLimit,
        "Provider rate limit reached.",
        { retryable: true, retryAfterMs: 2_500, status: 429 },
      );
    }

    const data = await response.json();
    parseBatchOutput(request, data.translations);
    return data.translations;
  },
});

const plan = createPlan(
  [
    { id: "title", text: "Overview", context: { role: "heading" } },
    { id: "p1", text: "Hello", context: { role: "body" }, dedupeKey: "hello" },
    { id: "p2", text: "Hello", context: { role: "body" }, dedupeKey: "hello" },
  ],
  { id: "guide.md", format: "markdown" },
);

export async function withPlan(): Promise<void> {
  const result = await translatePlan(plan, {
    provider,
    targetLanguage: "zh-CN",
    sourceLanguage: "en",
    instructions: "Keep product names untranslated.",
  });

  console.log(result.translations.get("p1"), toTranslationRecord(result));
}

export async function resume(): Promise<void> {
  let saved;
  try {
    await translatePlan(plan, {
      provider,
      targetLanguage: "zh-CN",
      onCheckpoint(checkpoint) {
        saved = structuredClone(checkpoint);
      },
    });
  } catch {
    const resumed = await translatePlan(plan, {
      provider,
      targetLanguage: "zh-CN",
      checkpoint: saved,
    });
    console.log(resumed.stats.fromCheckpointUnits);
  }
}

export async function quality(): Promise<void> {
  await translatePlan(plan, {
    provider,
    targetLanguage: "zh-CN",
    qualityPolicy({ item, translatedText }) {
      if (translatedText === item.text) {
        return {
          message: "The source text was returned unchanged.",
          issueCode: "untranslated",
          retryInstruction: "QUALITY RETRY: translate all prose.",
        };
      }
      return undefined;
    },
  });
}

export async function progress(): Promise<void> {
  const controller = new AbortController();

  await translatePlan(plan, {
    provider,
    targetLanguage: "zh-CN",
    signal: controller.signal,
    onProgress(value) {
      console.log(value.completedBatches + "/" + value.totalBatches);
    },
    onProviderActivity(activity, batchIndex) {
      console.log(batchIndex, activity.phase, activity.receivedCharacters);
    },
  });
}

export async function errors(): Promise<void> {
  try {
    await translatePlan(plan, { provider, targetLanguage: "zh-CN" });
  } catch (error) {
    if (isTranslationCoreError(error)) {
      console.error(error.code, error.details);
    }
  }
}
