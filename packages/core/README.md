# @easy-translate/core

运行于浏览器和 Node.js 的通用翻译执行核心。它接收 `TranslationPlan`，统一处理显式去重、分批、并发、Provider 输出校验、重试、质量策略、进度、取消和 checkpoint，并返回以单元 ID 为键的 `TranslationResult`。

```ts
import { translatePlan, type TranslationProvider } from "@easy-translate/core";
```

只有 adapter 明确提供相同 `dedupeKey` 的单元才会共用一次译文；`batchKey` 可隔离不同语境的批次。包内不包含文件系统、OOXML、ZIP 或具体 Provider 实现。
