import {
  TranslationErrorCode,
  TranslationProviderError,
  type TranslationProvider,
} from "@easy-translate/core";
import { createChatCompletionsProvider } from "./chat-completions.js";
import { VENDOR_PRESETS, type VendorPreset } from "./presets.js";
import type {
  RequiredModelProviderOptions,
  VendorProviderOptions,
} from "./types.js";

function createFromPreset(
  preset: VendorPreset,
  options: VendorProviderOptions,
): TranslationProvider {
  const model = options.model ?? preset.defaultModel;
  if (!model) {
    throw new TranslationProviderError(
      TranslationErrorCode.ProviderInvalidRequest,
      preset.title + " requires a model id.",
      { retryable: false, details: { vendor: preset.id } },
    );
  }
  return createChatCompletionsProvider({
    name: preset.id,
    apiKey: options.apiKey,
    baseUrl: preset.baseUrl,
    model,
    timeoutMs: options.timeoutMs,
    extraBody: options.extraBody,
    headers: options.headers,
  });
}

export function createOpenAIProvider(
  options: RequiredModelProviderOptions,
) {
  return createFromPreset(VENDOR_PRESETS.openai, options);
}

export function createDeepSeekProvider(options: VendorProviderOptions) {
  return createFromPreset(VENDOR_PRESETS.deepseek, options);
}

export function createKimiProvider(options: VendorProviderOptions) {
  return createFromPreset(VENDOR_PRESETS.kimi, options);
}

export function createKimiCNProvider(options: VendorProviderOptions) {
  return createFromPreset(VENDOR_PRESETS.kimiCn, options);
}

export function createMinimaxProvider(options: VendorProviderOptions) {
  return createFromPreset(VENDOR_PRESETS.minimax, options);
}

export function createMinimaxCNProvider(options: VendorProviderOptions) {
  return createFromPreset(VENDOR_PRESETS.minimaxCn, options);
}

export function createZhipuProvider(options: VendorProviderOptions) {
  return createFromPreset(VENDOR_PRESETS.zhipu, options);
}

export function createZhipuCNProvider(options: VendorProviderOptions) {
  return createFromPreset(VENDOR_PRESETS.zhipuCn, options);
}

/** Alias of `createZhipuProvider`. */
export function createGlmProvider(options: VendorProviderOptions) {
  return createZhipuProvider(options);
}

/** Alias of `createZhipuCNProvider`. */
export function createGlmCNProvider(options: VendorProviderOptions) {
  return createZhipuCNProvider(options);
}

export function createBailianProvider(options: VendorProviderOptions) {
  return createFromPreset(VENDOR_PRESETS.bailian, options);
}

export function createStepFunProvider(options: VendorProviderOptions) {
  return createFromPreset(VENDOR_PRESETS.stepfun, options);
}

export function createStepFunCNProvider(options: VendorProviderOptions) {
  return createFromPreset(VENDOR_PRESETS.stepfunCn, options);
}

export function createDoubaoProvider(options: RequiredModelProviderOptions) {
  return createFromPreset(VENDOR_PRESETS.doubao, options);
}

export function createQianfanProvider(options: RequiredModelProviderOptions) {
  return createFromPreset(VENDOR_PRESETS.qianfan, options);
}

export function createLongcatProvider(options: VendorProviderOptions) {
  return createFromPreset(VENDOR_PRESETS.longcat, options);
}

export function createMimoProvider(options: VendorProviderOptions) {
  return createFromPreset(VENDOR_PRESETS.mimo, options);
}

export function createBailingProvider(options: VendorProviderOptions) {
  return createFromPreset(VENDOR_PRESETS.bailing, options);
}

export function createSiliconFlowProvider(
  options: RequiredModelProviderOptions,
) {
  return createFromPreset(VENDOR_PRESETS.siliconflow, options);
}

export function createSiliconFlowCNProvider(
  options: RequiredModelProviderOptions,
) {
  return createFromPreset(VENDOR_PRESETS.siliconflowCn, options);
}

export function createOpenRouterProvider(
  options: RequiredModelProviderOptions,
) {
  return createFromPreset(VENDOR_PRESETS.openrouter, options);
}

export function createModelScopeProvider(
  options: RequiredModelProviderOptions,
) {
  return createFromPreset(VENDOR_PRESETS.modelscope, options);
}

export function createNovitaProvider(options: RequiredModelProviderOptions) {
  return createFromPreset(VENDOR_PRESETS.novita, options);
}

export function createNvidiaProvider(options: RequiredModelProviderOptions) {
  return createFromPreset(VENDOR_PRESETS.nvidia, options);
}

export function createPpioProvider(options: RequiredModelProviderOptions) {
  return createFromPreset(VENDOR_PRESETS.ppio, options);
}
