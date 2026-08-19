# @easy-translate/core

运行于浏览器和 Node.js 的通用翻译执行核心。它接收 `TranslationPlan`，统一处理显式去重、分批、并发、Provider 输出校验、重试、质量策略、进度、取消和 checkpoint，并返回以单元 ID 为键的 `TranslationResult`。

## 安装

```sh
npm install @easy-translate/core
```

## 快速开始

```ts
import { translatePlan, type TranslationProvider } from "@easy-translate/core";

const provider: TranslationProvider = {
  async translateBatch(request) {
    return request.items.map((item) => ({
      id: item.id,
      text: item.text === "Hello" ? "你好" : item.text,
    }));
  },
};

const result = await translatePlan(
  {
    schemaVersion: 1,
    document: { id: "doc-1", format: "plain" },
    units: [{ id: "u1", text: "Hello" }],
  },
  {
    provider,
    targetLanguage: "zh-CN",
  },
);

console.log(result.translations.get("u1"));
```

只有 adapter 明确提供相同 `dedupeKey` 的单元才会共用一次译文；`batchKey` 可隔离不同语境的批次。包内不包含文件系统、OOXML、ZIP 或具体 Provider 实现。

## 错误处理

core 返回带稳定错误码和结构化详情的错误，不包含 locale 或语言资源。调用方应在 Web、CLI 等展示边界根据 `error.code` 完成本地化；英文 `message` 用于日志和未知错误的开发调试回退。

```ts
import {
  TranslationErrorCode,
  TranslationProviderError,
} from "@easy-translate/core";

throw new TranslationProviderError(
  TranslationErrorCode.ProviderRateLimit,
  "Provider rate limit reached.",
  {
    providerCode: "vendor_busy",
    retryable: true,
    retryAfterMs: 2_500,
    status: 429,
    details: { requestId: "request-123" },
  },
);
```

源码应从 `TranslationErrorCode` 选择错误码，不应手写 `"provider.timeout"` 等协议字符串。`TranslationConfigurationError`、`TranslationPlanError`、`TranslationResponseError` 和 `TranslationProviderError` 分别限制了可接受的错误码类别。

`error.code` 是供所有消费者判断的标准 core 错误码；`error.providerCode` 仅保存上游服务返回的原始错误码，不能用于跨 Provider 的控制流。默认重试策略只重试 `TranslationResponseError` 和明确设置了 `retryable: true` 的 `TranslationProviderError`；配置错误、计划错误和未知异常不会自动重试。确有自定义错误协议时，可以通过 `retry.shouldRetry` 显式覆盖。
