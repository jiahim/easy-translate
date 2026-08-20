// 仓库内运行：pnpm --filter @easy-translate/core build && node examples/core-quickstart.mjs
// 在你自己的项目里，把下面的相对路径换成 "@easy-translate/core"。
import {
  createPlan,
  isTranslationCoreError,
  parseBatchOutput,
  toTranslationRecord,
  translatePlan,
  translateTexts,
  TranslationErrorCode,
  TranslationProviderError,
} from "../packages/core/dist/index.js";

// 一个假 Provider，替代真实的翻译服务调用。
const dictionary = new Map([
  ["Hello", "你好"],
  ["World", "世界"],
  ["Overview", "概览"],
]);

let calls = 0;

const provider = {
  name: "demo-provider",
  async translateBatch(request) {
    calls += 1;

    // 第一次调用故意返回不完整结果，用来演示自动重试。
    if (calls === 1) {
      return request.items.slice(1).map((item) => ({
        id: item.id,
        text: dictionary.get(item.text) ?? item.text,
      }));
    }

    const translations = request.items.map((item) => ({
      id: item.id,
      text: dictionary.get(item.text) ?? "[" + request.targetLanguage + "] " + item.text,
    }));

    // 可选：提前用引擎同款校验确认 id 完整，失败时抛出可重试的错误。
    parseBatchOutput(request, translations);
    return translations;
  },
};

// 1. 最简单的用法：翻译一组字符串。
const simple = await translateTexts(["Hello", "World"], {
  provider,
  targetLanguage: "zh-CN",
  retry: 1,
});
console.log("translateTexts:", simple);

// 2. 需要去重、语境隔离或上下文时，构造一个计划。
const plan = createPlan(
  [
    { id: "title", text: "Overview", context: { role: "heading" }, batchKey: "head" },
    { id: "p1", text: "Hello", context: { role: "body" }, dedupeKey: "hello" },
    { id: "p2", text: "Hello", context: { role: "body" }, dedupeKey: "hello" },
  ],
  { id: "guide.md", format: "markdown" },
);

const result = await translatePlan(plan, {
  provider,
  targetLanguage: "zh-CN",
  sourceLanguage: "en",
  onProgress(progress) {
    console.log("progress:", progress.completedBatches + "/" + progress.totalBatches);
  },
});

console.log("translations:", toTranslationRecord(result));
console.log("stats:", result.stats);

// 3. 续译：把上一轮的 checkpoint 传回去，已完成的单元不会再发给 Provider。
calls = 0;
const resumed = await translatePlan(plan, {
  provider,
  targetLanguage: "zh-CN",
  sourceLanguage: "en",
  checkpoint: result.checkpoint,
});
console.log("resumed provider calls:", calls);
console.log("resumed from checkpoint:", resumed.stats.fromCheckpointUnits);

// 4. 错误处理：按稳定错误码分支，不要匹配 message。
try {
  await translatePlan(plan, {
    provider: {
      async translateBatch() {
        throw new TranslationProviderError(
          TranslationErrorCode.ProviderRateLimit,
          "Provider rate limit reached.",
          { retryable: false, status: 429 },
        );
      },
    },
    targetLanguage: "zh-CN",
  });
} catch (error) {
  if (isTranslationCoreError(error)) {
    console.log("error:", error.code, error.name);
  } else {
    throw error;
  }
}
