# Easy Translate monorepo 迁移 Handoff

## 1. 目标

把 `/Users/xiexin/project/office-translator` 中已经完成抽取的通用翻译核心和 Office 能力迁入新的 pnpm monorepo：

- 新仓库：`/Users/xiexin/project/easy-translate`
- Git 远端：`git@github.com:jiahim/easy-translate.git`
- npm organization / scope：`@easy-translate`
- 第一阶段只发布两个公共包：
  - `@easy-translate/core`
  - `@easy-translate/office`
- Office Web 应用作为私有 workspace app，不发布到 npm。

迁移后，新的格式仍遵循统一边界：

```text
源文件
  → format adapter.prepare
  → TranslationPlan
  → translatePlan
  → TranslationResult
  → format adapter.render
  → 目标文件
```

`@easy-translate/core` 负责稳定复用翻译执行能力；每个文件格式只负责 prepare 和 render。

## 2. 当前状态

### easy-translate

- 仓库是空仓库。
- 当前分支为 `main`。
- 还没有首个提交。
- `origin/main` 尚不存在。

### office-translator

- 路径：`/Users/xiexin/project/office-translator`
- 工作区干净。
- 当前分支：`main`
- 当前提交：`f05ce54 refact: 重构核心，提取出翻译内核`
- 本地 `main` 比 `origin/main` 超前 2 个提交：
  - `cfd21cd feat: 提升 Office 翻译可靠性并支持断点续译`
  - `f05ce54 refact: 重构核心，提取出翻译内核`

迁移必须以本地路径和提交 `f05ce54` 为准，不能只从 `office-translator` 的远端 `origin/main` 读取，否则会缺失本次核心抽取。

## 3. 已完成的核心设计

源代码位于：

```text
/Users/xiexin/project/office-translator/src/translation-core/
```

目前包含：

- `types.ts`
  - `TranslationPlan`
  - `TranslationUnit`
  - `TranslationResult`
  - `TranslationProvider`
  - `DocumentAdapter`
  - checkpoint、progress、retry、quality policy 类型
- `engine.ts`
  - 显式去重
  - 分批与字符上限
  - 并发 worker
  - Provider 输出校验
  - 重试和修复指令
  - checkpoint 保存及恢复
  - 进度和 Provider activity
  - 取消信号
  - 可注入质量策略
- `retry.ts`
  - 指数退避
  - jitter
  - Provider `Retry-After`
  - 可注入 runtime，方便测试
- `errors.ts`
  - plan、response、provider 等结构化错误
- `index.ts`
  - 公共导出

重要语义：

- 默认不按照文本自动去重。
- 只有 adapter 明确提供相同的 `dedupeKey`，单元才会共享一次译文。
- `batchKey` 用于阻止相邻但不同语境的翻译单元进入同一批次。
- `formatState` 属于 adapter 私有状态，core 不读取文件 AST、OOXML 或 ZIP 内容。
- core 必须保持浏览器和 Node 都可用，不能引入 `node:*`、JSZip、文件系统或 Office 类型。

现有核心测试：

```text
/Users/xiexin/project/office-translator/tests/translation-core.test.ts
```

覆盖 Retry-After、永久错误、显式去重、batchKey、响应修复、质量重试和 checkpoint 恢复。

## 4. 目标目录结构

建议初始化为：

```text
easy-translate/
├── packages/
│   ├── core/
│   │   ├── src/
│   │   ├── tests/
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── office/
│       ├── src/
│       ├── tests/
│       ├── package.json
│       └── tsconfig.json
├── apps/
│   └── office-web/
├── examples/
├── .changeset/
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── README.md
└── LICENSE
```

根 `package.json` 应为私有：

```json
{
  "name": "easy-translate",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.33.0"
}
```

`pnpm-workspace.yaml`：

```yaml
packages:
  - packages/*
  - apps/*
```

## 5. 包边界

### @easy-translate/core

包名：

```json
{
  "name": "@easy-translate/core",
  "version": "0.1.0",
  "type": "module",
  "sideEffects": false,
  "publishConfig": {
    "access": "public"
  }
}
```

迁入：

```text
office-translator/src/translation-core/*
office-translator/tests/translation-core.test.ts
```

约束：

- 运行时零第三方依赖优先。
- 不依赖 `@easy-translate/office` 或任何 Provider 实现。
- TypeScript 配置要包含浏览器需要的 DOM 类型。
- 先保持 ESM-only；没有真实 CJS 消费者前不增加双构建。
- package exports 只暴露正式入口，不允许消费者引用 `dist/engine.js` 等内部文件。

### @easy-translate/office

包名：

```json
{
  "name": "@easy-translate/office",
  "version": "0.1.0",
  "type": "module",
  "publishConfig": {
    "access": "public"
  },
  "dependencies": {
    "@easy-translate/core": "workspace:^",
    "jszip": "^3.10.1"
  }
}
```

第一阶段迁入：

```text
office-translator/src/errors.ts
office-translator/src/formats.ts
office-translator/src/xml.ts
office-translator/src/package.ts
office-translator/src/office-adapter.ts
office-translator/src/translator.ts
office-translator/src/types.ts
office-translator/src/config.ts
office-translator/src/cli.ts
office-translator/src/providers/*
office-translator/src/index.ts
office-translator/tests/helpers.ts
office-translator/tests/xml.test.ts
office-translator/tests/word.test.ts
office-translator/tests/powerpoint.test.ts
office-translator/tests/excel.test.ts
office-translator/tests/office-adapter.test.ts
office-translator/tests/providers.test.ts
office-translator/tests/fixtures/*
```

需要把所有 `./translation-core/...` 导入替换为 `@easy-translate/core`。

第一阶段允许 HTTP/OpenAI-compatible Provider 暂时留在 Office 包中，以避免迁移同时制造过多公共包。等 `OpenAI-API-Chinese` 或第二个格式产生真实复用需求后，再拆：

- `@easy-translate/provider-openai`
- `@easy-translate/provider-http`

Office 包的 CLI 二进制名称可以继续使用：

```json
{
  "bin": {
    "office-translate": "./dist/cli.js"
  }
}
```

## 6. Office Web 应用

把：

```text
/Users/xiexin/project/office-translator/web
```

迁到：

```text
/Users/xiexin/project/easy-translate/apps/office-web
```

其 `package.json` 保持：

```json
{
  "private": true,
  "dependencies": {
    "@easy-translate/core": "workspace:^"
  }
}
```

当前浏览器实现通过下面的相对路径直接引用旧仓库核心：

```ts
from "../../src/translation-core/index.js"
```

必须替换为：

```ts
from "@easy-translate/core"
```

注意：当前 Web 的 `web/lib/office.ts` 仍包含一套浏览器版 Office OOXML prepare/render 实现；Node Office 包使用 `Buffer`、`node:path`、`node:crypto` 和 `node:fs`。初次迁移不要顺手重写整个 Office 包来消除这部分差异，应先保持行为一致并完成 workspace 拆包。

后续可以单独设计第二阶段：

- 把 Office adapter 的输入统一为 `Uint8Array`。
- 把文件扩展名解析移除 `node:path` 依赖。
- 把 source hash 改为可注入或 Web Crypto。
- 将 Node 文件 IO 下沉到 `@easy-translate/office/node`。
- 最终让 Web 和 Node 共用同一套 `@easy-translate/office` prepare/render。

这不是第一阶段迁移的阻塞项。

## 7. Provider 和类型兼容注意事项

### 不要保留两套 core 类型

旧 `office-translator/src/types.ts` 仍定义了 Office 版本的：

- `TranslationProvider`
- `TranslationBatchRequest`
- `TranslationInputItem`
- `TranslationOutputItem`

迁移时应优先从 `@easy-translate/core` 导入或 re-export，避免公共包中出现结构相同但来源不同的类型。

Office 专属类型只保留：

- `OfficeFormat`
- `TextKind`
- `TranslationContext`
- `OfficeScopeOptions`
- `RunDistribution`
- `TranslateOfficeOptions`
- Office 统计和文件输入输出类型

### Provider 错误

现有 Provider 已经把 HTTP 错误映射为 core 的 `TranslationProviderError`，并支持：

- authentication / invalid-request / network / rate-limit / server / timeout
- retryable
- status
- retryAfterMs
- 外部 AbortSignal 与请求超时组合

迁移后不能退回到按照错误消息字符串判断是否重试。

### checkpoint

checkpoint 是否可恢复由下列值共同决定：

- documentId
- targetLanguage
- sourceLanguage
- instructions
- 单元 id 和 sourceText

不要在拆包时降低这些校验。

## 8. 推荐实施顺序

1. 在 `easy-translate` 创建根 workspace、基础 TypeScript 配置、README 和 LICENSE。
2. 创建 `packages/core`，迁入 core 源码和测试。
3. 独立验证 core 的 typecheck、test、build 和 pack。
4. 创建 `packages/office`，依赖 `@easy-translate/core: workspace:^`。
5. 迁入 Office 源码和测试，消除旧的 core 相对导入及重复类型。
6. 迁入 `apps/office-web`，改用正式 workspace 包导入。
7. 运行全 workspace 类型检查、测试、构建和 lint。
8. 使用 `pnpm pack --dry-run` 检查两个公共包实际发布内容。
9. 初始化 Changesets，采用独立版本。
10. 创建 monorepo 首个提交；不要在未检查 tarball 前执行 npm publish。

不要同时进行以下第二阶段工作：

- 拆分 Provider 包。
- 新增 Markdown adapter。
- 修改 OpenAI-API-Chinese。
- 大规模统一 Node/Web Office adapter。
- 发布正式 npm 版本。

先完成无行为回归的仓库和包边界迁移。

## 9. 根脚本建议

```json
{
  "scripts": {
    "build": "pnpm -r --if-present build",
    "typecheck": "pnpm -r --if-present typecheck",
    "test": "pnpm -r --if-present test",
    "lint": "pnpm -r --if-present lint",
    "check": "pnpm typecheck && pnpm test && pnpm build"
  }
}
```

各包的 `build` 必须先清晰地产生自己的 `dist`，不能依赖另一个包的源码相对路径。

## 10. 验收标准

完成第一阶段时应满足：

- `easy-translate` 成为有效的 pnpm workspace。
- `@easy-translate/core` 可独立安装和导入。
- `@easy-translate/office` 只通过包名依赖 core。
- Web 应用不再跨目录引用 `office-translator/src/translation-core`。
- core 构建产物不包含 Node、Office 或 JSZip 依赖。
- Office 的 DOCX、PPTX、XLSX 测试全部通过。
- Retry-After、永久错误、质量策略、checkpoint 和取消语义保持。
- 浏览器进度、断点续译和质量重试测试全部通过。
- Web 生产构建与 lint 通过。
- 两个公共包的 tarball 只包含必要的 dist、README、LICENSE 和 package metadata。
- `/Users/xiexin/project/office-translator` 保持不被修改。
- 不执行真实 npm publish，除非用户单独明确授权。

迁移前旧仓库已通过的基线：

- TypeScript 类型检查通过。
- 46 项核心和浏览器行为测试通过。
- 3 项 Web 渲染测试通过。
- Node 库构建通过。
- Web 生产构建通过。
- Web lint 通过。
- npm pack dry-run 通过。

## 11. 新对话建议开场指令

可以直接把下面这段交给新的 Codex 对话：

```text
请阅读 /Users/xiexin/project/easy-translate/HANDOFF.md，并按照文档完成第一阶段 monorepo 迁移。

源仓库是 /Users/xiexin/project/office-translator，必须以本地提交 f05ce54 为准。目标仓库是 /Users/xiexin/project/easy-translate。

先迁移 @easy-translate/core 和 @easy-translate/office，再迁移私有 apps/office-web。保持现有行为和测试，不发布 npm 包，不修改源 office-translator 仓库。默认使用 TypeScript。
```
