/**
 * First-party OpenAI-compatible providers, aligned with CC Switch OpenCode
 * presets that use `@ai-sdk/openai-compatible`.
 *
 * When a vendor has both regions, the unprefixed factory is international and
 * the `CN` factory is China. Partner relays and Anthropic / Gemini / Bedrock
 * presets are omitted: this package only speaks Chat Completions (and a
 * generic HTTP fallback).
 *
 * @see https://github.com/farion1231/cc-switch/blob/main/src/config/opencodeProviderPresets.ts
 */
export interface VendorPreset {
  id: string;
  title: string;
  factory: string;
  baseUrl: string;
  /** Used when the caller omits `model`. */
  defaultModel?: string | undefined;
  /** Aggregators and endpoint-specific vendors have no sensible default. */
  modelRequired?: boolean | undefined;
  website?: string | undefined;
}

export const VENDOR_PRESETS = {
  openai: {
    id: "openai",
    title: "OpenAI",
    factory: "createOpenAIProvider",
    baseUrl: "https://api.openai.com/v1",
    modelRequired: true,
    website: "https://platform.openai.com",
  },
  deepseek: {
    id: "deepseek",
    title: "DeepSeek",
    factory: "createDeepSeekProvider",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    website: "https://api-docs.deepseek.com",
  },
  kimi: {
    id: "kimi",
    title: "Kimi",
    factory: "createKimiProvider",
    baseUrl: "https://api.moonshot.ai/v1",
    defaultModel: "kimi-k3",
    website: "https://platform.kimi.ai/docs/api/overview",
  },
  kimiCn: {
    id: "kimi-cn",
    title: "Kimi CN",
    factory: "createKimiCNProvider",
    baseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "kimi-k3",
    website: "https://platform.kimi.ai/docs/api/overview",
  },
  minimax: {
    id: "minimax",
    title: "MiniMax",
    factory: "createMinimaxProvider",
    baseUrl: "https://api.minimax.io/v1",
    defaultModel: "MiniMax-M2.7",
    website: "https://platform.minimax.io/docs/api-reference/text-openai-api",
  },
  minimaxCn: {
    id: "minimax-cn",
    title: "MiniMax CN",
    factory: "createMinimaxCNProvider",
    baseUrl: "https://api.minimaxi.com/v1",
    defaultModel: "MiniMax-M2.7",
    website: "https://platform.minimaxi.com",
  },
  zhipu: {
    id: "zhipu",
    title: "Zhipu GLM",
    factory: "createZhipuProvider",
    baseUrl: "https://api.z.ai/api/paas/v4",
    defaultModel: "glm-5.1",
    website: "https://z.ai",
  },
  zhipuCn: {
    id: "zhipu-cn",
    title: "Zhipu GLM CN",
    factory: "createZhipuCNProvider",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-5.1",
    website: "https://open.bigmodel.cn",
  },
  bailian: {
    id: "bailian",
    title: "Alibaba Bailian",
    factory: "createBailianProvider",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus",
    website: "https://bailian.console.aliyun.com",
  },
  stepfun: {
    id: "stepfun",
    title: "StepFun",
    factory: "createStepFunProvider",
    baseUrl: "https://api.stepfun.ai/v1",
    defaultModel: "step-3.5-flash",
    website: "https://platform.stepfun.ai",
  },
  stepfunCn: {
    id: "stepfun-cn",
    title: "StepFun CN",
    factory: "createStepFunCNProvider",
    baseUrl: "https://api.stepfun.com/v1",
    defaultModel: "step-3.5-flash",
    website: "https://platform.stepfun.com",
  },
  doubao: {
    id: "doubao",
    title: "Volcengine Doubao",
    factory: "createDoubaoProvider",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    modelRequired: true,
    website: "https://www.volcengine.com/product/doubao",
  },
  qianfan: {
    id: "qianfan",
    title: "Baidu Qianfan",
    factory: "createQianfanProvider",
    baseUrl: "https://qianfan.baidubce.com/v2",
    modelRequired: true,
    website: "https://cloud.baidu.com/product/qianfan",
  },
  longcat: {
    id: "longcat",
    title: "Longcat",
    factory: "createLongcatProvider",
    baseUrl: "https://api.longcat.chat/openai/v1",
    defaultModel: "LongCat-2.0",
    website: "https://longcat.chat/platform",
  },
  mimo: {
    id: "mimo",
    title: "Xiaomi MiMo",
    factory: "createMimoProvider",
    baseUrl: "https://api.xiaomimimo.com/v1",
    defaultModel: "mimo-v2.5",
    website: "https://platform.xiaomimimo.com",
  },
  bailing: {
    id: "bailing",
    title: "BaiLing",
    factory: "createBailingProvider",
    baseUrl: "https://api.tbox.cn/v1",
    defaultModel: "Ling-2.5-1T",
    website: "https://alipaytbox.yuque.com/sxs0ba/ling/get_started",
  },
  siliconflow: {
    id: "siliconflow",
    title: "SiliconFlow",
    factory: "createSiliconFlowProvider",
    baseUrl: "https://api.siliconflow.com/v1",
    modelRequired: true,
    website: "https://docs.siliconflow.com",
  },
  siliconflowCn: {
    id: "siliconflow-cn",
    title: "SiliconFlow CN",
    factory: "createSiliconFlowCNProvider",
    baseUrl: "https://api.siliconflow.cn/v1",
    modelRequired: true,
    website: "https://docs.siliconflow.cn",
  },
  openrouter: {
    id: "openrouter",
    title: "OpenRouter",
    factory: "createOpenRouterProvider",
    baseUrl: "https://openrouter.ai/api/v1",
    modelRequired: true,
    website: "https://openrouter.ai",
  },
  modelscope: {
    id: "modelscope",
    title: "ModelScope",
    factory: "createModelScopeProvider",
    baseUrl: "https://api-inference.modelscope.cn/v1",
    modelRequired: true,
    website: "https://modelscope.cn",
  },
  novita: {
    id: "novita",
    title: "Novita AI",
    factory: "createNovitaProvider",
    baseUrl: "https://api.novita.ai/openai",
    modelRequired: true,
    website: "https://novita.ai",
  },
  nvidia: {
    id: "nvidia",
    title: "NVIDIA NIM",
    factory: "createNvidiaProvider",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    modelRequired: true,
    website: "https://build.nvidia.com",
  },
  ppio: {
    id: "ppio",
    title: "PPIO",
    factory: "createPpioProvider",
    baseUrl: "https://api.ppio.com/openai/v1",
    modelRequired: true,
    website: "https://ppio.com",
  },
} as const satisfies Record<string, VendorPreset>;

export type VendorId = keyof typeof VENDOR_PRESETS;
