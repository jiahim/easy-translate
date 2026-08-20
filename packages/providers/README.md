# @easy-translate/providers

给 [`@easy-translate/core`](https://www.npmjs.com/package/@easy-translate/core) 用的现成 Provider：选一家厂商、传入 API key，就可以开始翻译。

浏览器和 Node.js 都能用，只依赖 `@easy-translate/core`。API key 要你自己传进来，这个包不会去读环境变量。

内置的都是 OpenAI 兼容接口。有的厂商分国内站和国际站：名字带 `CN` 的走国内，不带的走国际。比如国内用 `createKimiCNProvider`，国际用 `createKimiProvider`。

## 安装

```sh
npm install @easy-translate/core @easy-translate/providers
```

## 快速开始

不指定模型时，会用这家的默认模型：

```ts
import { translateTexts } from "@easy-translate/core";
import { createDeepSeekProvider } from "@easy-translate/providers";

const [greeting] = await translateTexts(["Hello"], {
  provider: createDeepSeekProvider({ apiKey: process.env.DEEPSEEK_API_KEY! }),
  targetLanguage: "zh-CN",
});
```

想换模型，加上 `model` 即可：

```ts
const deepseek = createDeepSeekProvider({
  apiKey: process.env.DEEPSEEK_API_KEY!,
  model: "deepseek-v4-flash",
});
```

国内站用带 `CN` 的函数，key 也要用国内控制台申请的那把：

```ts
import { createKimiCNProvider } from "@easy-translate/providers";

const kimiCn = createKimiCNProvider({
  apiKey: process.env.MOONSHOT_API_KEY!,
});
```

OpenAI、硅基流动、豆包、千帆、OpenRouter 这几家没有默认模型，创建时必须写 `model`。

## Provider 清单

| 函数 | 默认模型 | 说明 |
| --- | --- | --- |
| `createOpenAIProvider` | 必填 `model` | |
| `createDeepSeekProvider` | `deepseek-chat` | |
| `createKimiProvider` | `kimi-k3` | 国际站 |
| `createKimiCNProvider` | `kimi-k3` | 国内站 |
| `createMinimaxProvider` | `MiniMax-M2.7` | 国际站 |
| `createMinimaxCNProvider` | `MiniMax-M2.7` | 国内站 |
| `createZhipuProvider` | `glm-5.1` | 国际站，也可以写成 `createGlmProvider` |
| `createZhipuCNProvider` | `glm-5.1` | 国内站，也可以写成 `createGlmCNProvider` |
| `createBailianProvider` | `qwen-plus` | 阿里云百炼 |
| `createStepFunProvider` | `step-3.5-flash` | 国际站 |
| `createStepFunCNProvider` | `step-3.5-flash` | 国内站 |
| `createDoubaoProvider` | 必填 `model` | 火山方舟，模型名一般是控制台里的接入点 ID |
| `createQianfanProvider` | 必填 `model` | 百度千帆 |
| `createLongcatProvider` | `LongCat-2.0` | |
| `createMimoProvider` | `mimo-v2.5` | 小米 MiMo |
| `createBailingProvider` | `Ling-2.5-1T` | |
| `createSiliconFlowProvider` | 必填 `model` | 国际站 |
| `createSiliconFlowCNProvider` | 必填 `model` | 国内站 |
| `createOpenRouterProvider` | 必填 `model` | |
| `createModelScopeProvider` | 必填 `model` | 魔搭 |
| `createNovitaProvider` | 必填 `model` | |
| `createNvidiaProvider` | 必填 `model` | NVIDIA NIM |
| `createPpioProvider` | 必填 `model` | |

这些函数都要传 `apiKey`。需要的话还可以传 `model`、`timeoutMs`、`headers`、`extraBody`。如果要在自己的界面里列出这些选项，可以用导出的 `VENDOR_PRESETS`。

## 自定义 Provider

清单里没有的服务，用 `createCustomProvider` 自己填地址、协议、模型和 key。

对方提供 OpenAI 兼容接口时，把 API 根地址和模型填进去（填到 `/v1` 这一层即可，不用带 `/chat/completions`）：

```ts
import { createCustomProvider } from "@easy-translate/providers";

const compatible = createCustomProvider({
  apiKey: process.env.API_KEY!,
  baseUrl: "https://your-compatible-endpoint.example/v1",
  model: "your-model-id",
});
```

如果手里已经是完整请求地址，用 `url`：

```ts
const fullUrl = createCustomProvider({
  apiKey: process.env.API_KEY!,
  url: "https://gateway.example/v1/chat/completions",
  model: "your-model-id",
});
```

如果是你们自己的翻译 HTTP 接口，把 `protocol` 设成 `"generic-http"`：

```ts
const privateApi = createCustomProvider({
  protocol: "generic-http",
  url: "https://translate.example/v1/batch",
  headers: { authorization: "Bearer " + process.env.API_KEY! },
});
```

这种接口返回的 JSON 里要有 `translations`。默认读这个字段，也可以用 `responsePath` 改。内容可以是 `{ id, text }[]`、字符串数组，或 `id → text` 对象。

一般不用直接调用 `createChatCompletionsProvider` 和 `createGenericHttpProvider`，它们和上面两种写法是一回事。
