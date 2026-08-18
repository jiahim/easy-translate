# @easy-translate/office

用于翻译 DOCX、PPTX 和 XLSX 文件的 Node.js ESM 包，尽量保留 OOXML 结构、文本样式和工作簿布局。

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

底层 adapter 可从 `@easy-translate/office/office-adapter` 导入；内置 OpenAI-compatible 与通用 HTTP Provider 可从 `@easy-translate/office/providers` 导入。翻译执行能力和通用类型由 `@easy-translate/core` 提供。

## CLI

```sh
office-translate ./input.docx --to zh-CN --config ./office-translator.config.mjs
```

支持 Word 正文、页眉页脚、批注，PowerPoint 文本、备注、母版、图表、图示，以及 Excel 共享字符串、内联字符串和图表等 OOXML 内容。宏文件会保留原有包结构；不执行 Office 宏。
