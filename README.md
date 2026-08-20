# Easy Translate

Easy Translate 是一个以 `TranslationPlan` 为统一边界的 TypeScript 翻译工具集。格式 adapter 负责从源文件生成翻译计划并渲染结果，核心包负责分批、并发、重试、质量校验、进度和断点续译。

## 快速开始

需要 Node.js 20+、pnpm 10.33.0。

```sh
pnpm install
pnpm office-web
```

`pnpm office-web` 会先构建 `@easy-translate/core` 和 `@easy-translate/office`，再启动 Office Web 的本地开发服务。

如果要直接使用公共包：

```sh
npm install @easy-translate/core @easy-translate/providers @easy-translate/office
```

## Workspace

- `@easy-translate/core`：浏览器与 Node.js 通用的翻译执行核心，运行时零第三方依赖。
- `@easy-translate/providers`：OpenAI 兼容 Provider 工厂与 `createCustomProvider`。完整清单见 [`packages/providers/README.md`](./packages/providers/README.md)。
- `@easy-translate/office`：DOCX、PPTX、XLSX 的 OOXML adapter 与 Node.js CLI。
- `apps/office-web`：私有浏览器应用，不发布到 npm。

```text
源文件 → adapter.prepare → TranslationPlan → translatePlan
      → TranslationResult → adapter.render → 目标文件
```

更详细的包说明见：

- [`@easy-translate/core`](./packages/core/README.md)
- [`@easy-translate/providers`](./packages/providers/README.md)
- [`@easy-translate/office`](./packages/office/README.md)
- [`Office Web`](./apps/office-web/README.md)

## 开发

```sh
pnpm check
pnpm lint
pnpm pack:check
```

## 示例

[`examples/`](./examples) 目录包含一个可直接运行的 core 快速开始脚本，以及 Chat Completions、通用 HTTP 和自定义 Provider 的配置示例。

```sh
pnpm --filter @easy-translate/core build
node examples/core-quickstart.mjs
```

公共包采用 ESM-only，并通过 package exports 暴露正式入口。
