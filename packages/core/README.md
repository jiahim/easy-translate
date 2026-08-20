# @easy-translate/core

运行于浏览器和 Node.js 的通用翻译执行核心，运行时零第三方依赖。它负责显式去重、分批、并发、Provider 输出校验、重试、质量策略、进度、取消和断点续译；不包含文件系统、OOXML、ZIP 或任何具体 Provider 实现。

## 安装

```sh
npm install @easy-translate/core
```

## 快速开始

翻译一组纯文本只需要一个 Provider：

```ts
import { createEchoProvider, translateTexts } from "@easy-translate/core";

const translated = await translateTexts(["Hello", "World"], {
  provider: createEchoProvider((text) => "[zh] " + text),
  targetLanguage: "zh-CN",
});

console.log(translated); // ["[zh] Hello", "[zh] World"]
```

`createEchoProvider` 只是把原文回显，用于跑通链路和写测试。接真实模型请用 [`@easy-translate/providers`](../providers/README.md)：

```ts
import { translateTexts } from "@easy-translate/core";
import { createDeepSeekProvider } from "@easy-translate/providers";

const [greeting] = await translateTexts(["Hello"], {
  provider: createDeepSeekProvider({
    apiKey: process.env.DEEPSEEK_API_KEY!,
    model: "deepseek-v4-flash",
  }),
  targetLanguage: "zh-CN",
});
```

Provider 清单、默认模型和自定义网关见 [`@easy-translate/providers`](../providers/README.md)。

## 自定义 Provider

需要自有协议时再实现 `translateBatch`。它接收一批待译文本，必须为每个 `id` 恰好返回一条译文：

```ts
import {
  defineProvider,
  parseBatchOutput,
  TranslationErrorCode,
  TranslationProviderError,
} from "@easy-translate/core";

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
    // 校验 id 完整性；失败时抛出可重试的 TranslationResponseError
    parseBatchOutput(request, data.translations);
    return data.translations;
  },
});
```

`defineProvider` 只做类型收敛，不改变运行时行为。`parseBatchOutput` 是引擎内部使用的同一套校验，导出它是为了让你在 Provider 内部提前拿到一致的错误语义——引擎无论如何都会再校验一次，所以这一步是可选的。

## 使用 TranslationPlan

`translateTexts` 覆盖不了的场景（去重、语境隔离、断点续译、携带上下文）需要显式构造计划。`createPlan` 负责补齐 `schemaVersion`、文档描述符和单元 id：

```ts
import { createPlan, translatePlan } from "@easy-translate/core";

const plan = createPlan(
  [
    { id: "title", text: "Overview", context: { role: "heading" } },
    { id: "p1", text: "Hello", context: { role: "body" }, dedupeKey: "hello" },
    { id: "p2", text: "Hello", context: { role: "body" }, dedupeKey: "hello" },
  ],
  { id: "guide.md", format: "markdown" },
);

const result = await translatePlan(plan, {
  provider,
  targetLanguage: "zh-CN",
  sourceLanguage: "en",
  instructions: "Keep product names untranslated.",
});

result.translations.get("p1"); // 与 p2 共用同一次翻译结果
```

两个字段控制分组：

- `dedupeKey`：相同 key 的单元只翻译一次，结果展开回每个 id。去重永远是显式的，引擎不会因为文本相同就自动合并；相同 key 但文本不同会抛 `plan.dedupe_text_mismatch`。
- `batchKey`：相邻单元的 key 不同则强制切分批次，用于隔离不同语境。

如果不需要计划的其他能力，也可以直接用字符串数组：`createPlan(["Hello", "World"])` 会生成 `u0`、`u1` 两个单元。

## 断点续译

每完成一个批次，引擎会把快照交给 `onCheckpoint`。把快照传回 `checkpoint` 即可跳过已完成的部分：

```ts
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
  resumed.stats.fromCheckpointUnits; // 从快照恢复的单元数
}
```

只有当 `documentId`、`targetLanguage`、`sourceLanguage` 和 `instructions` 全部一致时快照才会被复用，源文本变化的条目也会被丢弃。因此续译必须使用稳定的 `document.id`——`createPlan` 在你不指定时会自动生成，每次调用都不同。

## 质量策略

`qualityPolicy` 逐条检查译文，返回 issue 即拒绝该批次并触发重试，`retryInstruction` 会追加到下一次的 `instructions`：

```ts
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
```

## 进度与取消

```ts
const controller = new AbortController();

await translatePlan(plan, {
  provider,
  targetLanguage: "zh-CN",
  signal: controller.signal,
  onProgress(progress) {
    console.log(progress.completedBatches + "/" + progress.totalBatches);
  },
  onProviderActivity(activity, batchIndex) {
    console.log(batchIndex, activity.phase, activity.receivedCharacters);
  },
});
```

`onProgress` 报告批次和单元进度，`onProviderActivity` 转发 Provider 自己上报的流式与内部重试状态（需要 Provider 调用 `translateBatch` 的第三个参数）。

## 选项参考

`translatePlan(plan, options)` 的完整选项：

| 选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `provider` | `TranslationProvider` | 必填 | 翻译实现 |
| `targetLanguage` | `string` | 必填 | 目标语言，不能为空白 |
| `sourceLanguage` | `string` | 无 | 源语言，透传给 Provider |
| `instructions` | `string` | 无 | 附加指令，透传给 Provider |
| `batchSize` | `number` | `40` | 每批最多多少个单元 |
| `maxBatchCharacters` | `number` | `8000` | 每批最多多少个源字符 |
| `concurrency` | `number` | `2` | 并行批次数 |
| `retry` | `number \| TranslationRetryPolicy` | `{ maxRetries: 2 }` | 数字是 `{ maxRetries: n }` 的简写 |
| `signal` | `AbortSignal` | 无 | 取消整轮翻译 |
| `checkpoint` | `TranslationCheckpoint` | 无 | 续译起点 |
| `qualityPolicy` | `TranslationQualityPolicy` | 无 | 逐条译文校验 |
| `onProgress` | `(progress) => void` | 无 | 进度回调 |
| `onProviderActivity` | `(activity, batchIndex) => void` | 无 | Provider 活动回调 |
| `onCheckpoint` | `(checkpoint) => Promise<void> \| void` | 无 | 快照回调，串行等待 |

`retry` 展开后的重试策略默认值：`maxRetries: 2`、`baseDelayMs: 400`、`maxDelayMs: 4000`、`jitterMs: 0`。

## 结果

```ts
interface TranslationResult {
  translations: ReadonlyMap<string, string>;
  checkpoint: TranslationCheckpoint;
  stats: {
    batches: number;
    characters: number;
    uniqueUnits: number;
    freshlyTranslatedUnits: number;
    fromCheckpointUnits: number;
    /** @deprecated 等价于 uniqueUnits，将在 0.4.0 移除 */
    translatedUnits: number;
  };
}
```

`translations` 以单元 id 为键，去重的单元会展开到每个原始 id。需要普通对象时用 `toTranslationRecord(result)`。

## 错误处理

core 抛出带稳定错误码和结构化 `details` 的错误，不包含 locale 或语言资源。调用方应在 Web、CLI 等展示边界根据 `error.code` 完成本地化；英文 `message` 用于日志和未知错误的开发调试回退。

```ts
import { isTranslationCoreError, TranslationErrorCode } from "@easy-translate/core";

try {
  await translatePlan(plan, { provider, targetLanguage: "zh-CN" });
} catch (error) {
  if (isTranslationCoreError(error)) {
    console.error(error.code, error.details);
  }
}
```

源码应从 `TranslationErrorCode` 选择错误码，不应手写 `"provider.timeout"` 等协议字符串。

| 错误码 | 错误类 | 触发场景 | 默认重试 |
| --- | --- | --- | --- |
| `config.target_language_required` | `TranslationConfigurationError` | `targetLanguage` 为空白 | 否 |
| `config.invalid_integer_option` | `TranslationConfigurationError` | 批次、并发或重试参数不是合法整数 | 否 |
| `plan.unsupported_schema` | `TranslationPlanError` | `schemaVersion` 不是 `1` | 否 |
| `plan.document_id_required` | `TranslationPlanError` | `document.id` 为空白 | 否 |
| `plan.document_format_required` | `TranslationPlanError` | `document.format` 为空白 | 否 |
| `plan.unit_id_required` | `TranslationPlanError` | 单元 `id` 为空白 | 否 |
| `plan.duplicate_unit_id` | `TranslationPlanError` | 计划内出现重复 `id` | 否 |
| `plan.dedupe_text_mismatch` | `TranslationPlanError` | 相同 `dedupeKey` 的单元文本不一致 | 否 |
| `response.invalid_container` | `TranslationResponseError` | Provider 返回的不是数组 | 是 |
| `response.invalid_item` | `TranslationResponseError` | 条目不是 `{ id, text }` 结构 | 是 |
| `response.unexpected_id` | `TranslationResponseError` | 返回了未请求的 `id` | 是 |
| `response.duplicate_id` | `TranslationResponseError` | 同一个 `id` 返回多次 | 是 |
| `response.missing_id` | `TranslationResponseError` | 漏掉 `id`，或原文非空而译文为空 | 是 |
| `response.quality_rejected` | `TranslationResponseError` | `qualityPolicy` 拒绝了译文 | 是 |
| `provider.authentication` | `TranslationProviderError` | 鉴权失败 | 仅当 `retryable` |
| `provider.invalid_request` | `TranslationProviderError` | 上游拒绝了请求 | 仅当 `retryable` |
| `provider.network` | `TranslationProviderError` | 网络故障 | 仅当 `retryable` |
| `provider.rate_limit` | `TranslationProviderError` | 触发限流 | 仅当 `retryable` |
| `provider.server` | `TranslationProviderError` | 上游 5xx | 仅当 `retryable` |
| `provider.timeout` | `TranslationProviderError` | 请求超时 | 仅当 `retryable` |
| `provider.unknown` | `TranslationProviderError` | 无法归类的上游失败 | 仅当 `retryable` |

默认重试策略只重试 `TranslationResponseError` 和明确设置了 `retryable: true` 的 `TranslationProviderError`；配置错误、计划错误和未知异常不会自动重试。确有自定义错误协议时，可以通过 `retry.shouldRetry` 显式覆盖。

`TranslationProviderError` 额外提供 `kind` 字段，是 `provider.*` 错误码的 kebab-case 形式（`provider.rate_limit` 对应 `"rate-limit"`）。跨 Provider 的控制流请一律基于 `error.code` 判断；`error.providerCode` 只保存上游返回的原始错误码，不具备跨 Provider 的稳定语义。

取消时抛出的是 `signal.reason`，未提供时为 `DOMException("AbortError")`，它不属于 core 的错误层次。

## 扩展格式

格式包实现 `DocumentAdapter`，把源文件变成计划、再把结果合并回去：

```text
源文件 → adapter.prepare → TranslationPlan → translatePlan
      → TranslationResult → adapter.render → 目标文件
```

`@easy-translate/office` 是这个接口的参考实现，支持 DOCX、PPTX 和 XLSX。
