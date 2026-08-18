# Office Translator Web

Office Translator 的交互式 Web UI。文档在浏览器中解包与回写，待翻译文本和用于消歧的必要上下文会发送到用户配置的翻译服务；译文会尽量写回原有文本结构。

## 本地运行

```bash
npm install
pnpm dev
```

打开 `http://localhost:3000`。

## 构建与测试

```bash
pnpm build
npm test
```

## Vercel

从仓库导入时将 Root Directory 设置为 `apps/office-web`，Vercel 会读取 `vercel.json`，使用 Next.js 和 `pnpm build:vercel` 完成部署。该入口与现有的 vinext/Sites 构建相互独立。

免费试用由同源的 `/api/translate` 服务端路由代理到硅基流动，部署前需要设置 `SILICONFLOW_API_KEY`、`SILICONFLOW_MODEL`、`RATE_LIMIT_SECRET`、`UPSTASH_REDIS_REST_URL` 和 `UPSTASH_REDIS_REST_TOKEN`。推荐同时配置 Cloudflare Turnstile 的公开 Site Key 和服务端 Secret Key。变量说明和默认额度见 `.env.example`。

免费翻译默认向硅基流动发送 `enable_thinking: false`，避免思考型模型将时间和 token 消耗在不会写入文档的推理内容上。如需重新开启，可显式设置 `SILICONFLOW_DISABLE_THINKING=false`。路由错误响应和 Vercel 日志都包含可关联的请求 ID。
上游请求默认有 30 秒首包超时，可通过 `SILICONFLOW_TIMEOUT_MS` 在 10,000–110,000 毫秒之间调整。该超时只限制等待响应头；流式输出开始后会立即取消计时，与浏览器的自有 API 通道一致。
`/api/translate` 使用 SSE 立即建立浏览器响应，并流式读取上游模型；浏览器只接收响应活动、累计字符数和校验完成的最终译文，不接收未经验证的模型片段。流内错误保留结构化错误码与请求 ID。
免费试用固定最多 3 个请求并发。请求频率和每日额度按访问来源计算；并发锁按签名浏览器会话隔离，避免共享网络或反向代理出口下的不同用户互相占用。Cloudflare/Sites 部署优先使用 `CF-Connecting-IP` 识别原始访客地址。

页面默认提供受限的免费试用，同时支持用户自行填写供应商配置：

- Chat Completions 兼容接口；
- 自定义 JSON HTTP 批量翻译接口。

大模型供应商接口、模型、请求头与 API Key 会保存在当前浏览器的本地存储中，刷新后自动恢复；页面提供“清除缓存”按钮。配置不会写入站点服务器。

每个成功正文批次的译文会单独保存到浏览器 IndexedDB。模型格式错误或请求失败后，可以重试当前模型或换模型续译；重新选择匹配的文件和翻译选项也能恢复进度。成功生成译文文件后，对应检查点会自动删除。

兼容聊天接口包含硅基流动、DeepSeek、阿里云百炼、OpenRouter、Google Gemini、Ollama 与自定义预设。支持模型目录的服务可在填写 Key 后拉取并按关键词、快速模型或免费模型筛选；各大模型供应商的配置和模型目录独立缓存在当前浏览器。
