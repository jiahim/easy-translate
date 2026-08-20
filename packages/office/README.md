# @easy-translate/office

用于翻译 DOCX、PPTX 和 XLSX 文件的 Node.js ESM 包，尽量保留 OOXML 结构、文本样式和工作簿布局。

## 安装

```sh
npm install @easy-translate/office
```

## TypeScript API

```ts
import {
  translateOfficeBuffer,
  type TranslationProvider,
} from "@easy-translate/office";

const provider: TranslationProvider = {
  async translateBatch(request) {
    return request.items.map((item) => ({
      id: item.id,
      text: item.text,
    }));
  },
};

const result = await translateOfficeBuffer(input, "report.docx", {
  provider,
  sourceLanguage: "en",
  targetLanguage: "zh-CN",
});
```

底层 adapter 可从 `@easy-translate/office/office-adapter` 导入；OpenAI 兼容与通用 HTTP Provider 由 `@easy-translate/providers` 提供，也可继续从 `@easy-translate/office/providers` 导入 Node 封装（支持 `apiKeyEnv`）。翻译执行能力和通用类型由 `@easy-translate/core` 提供。

Office 根入口同时重导出 core 的结构化错误 API，包括 `TranslationErrorCode`、`TranslationConfigurationError`、`TranslationPlanError`、`TranslationResponseError`、`TranslationProviderError` 和 `isTranslationCoreError`。内置 HTTP Provider 会把状态码、重试能力、`Retry-After`、request ID 和上游原始错误码分别保存为 `status`、`retryable`、`retryAfterMs`、`details.requestId` 和 `providerCode`；上游响应正文不会拼入标准错误消息。

`ProviderResponseError` 保留现有类名、构造方式和 `instanceof OfficeTranslatorError` 兼容，同时属于 `TranslationResponseError`，因此模型 JSON 或结果结构不完整时仍可由 core 执行格式修复重试。Provider 实现不应抛出普通 `Error` 来表示可重试故障；未知异常默认不会重试。

## CLI

```sh
npm install -g @easy-translate/office
office-translate ./input.docx --to zh-CN --config ./office-translator.config.mjs
```

支持 Word 正文、页眉页脚、批注，PowerPoint 文本、备注、母版、图表、图示，以及 Excel 共享字符串、内联字符串和图表等 OOXML 内容。宏文件会保留原有包结构；不执行 Office 宏。
