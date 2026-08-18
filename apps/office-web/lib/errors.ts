import {
  isTranslationCoreError,
  TranslationErrorCode,
  type TranslationErrorCode as TranslationErrorCodeValue,
  type TranslationErrorDetails,
} from "@easy-translate/core";

type ErrorRenderer = (details: TranslationErrorDetails) => string;

const zhCNCoreErrorMessages = {
  [TranslationErrorCode.ConfigTargetLanguageRequired]: () =>
    "请选择目标语言。",
  [TranslationErrorCode.ConfigInvalidIntegerOption]: ({ option }) =>
    `${String(option ?? "翻译选项")} 不是有效的整数。`,
  [TranslationErrorCode.PlanUnsupportedSchema]: () =>
    "当前版本无法处理这份翻译计划。",
  [TranslationErrorCode.PlanDocumentIdRequired]: () =>
    "文档缺少必要的内部标识，无法开始翻译。",
  [TranslationErrorCode.PlanDocumentFormatRequired]: () =>
    "无法识别文档格式，不能开始翻译。",
  [TranslationErrorCode.PlanUnitIdRequired]: () =>
    "文档中存在无法识别的翻译单元。",
  [TranslationErrorCode.PlanDuplicateUnitId]: () =>
    "文档包含重复的翻译单元，无法继续处理。",
  [TranslationErrorCode.PlanDedupeTextMismatch]: () =>
    "文档中的重复文本单元不一致，无法继续处理。",
  [TranslationErrorCode.ResponseInvalidContainer]: () =>
    "大模型返回了无法识别的翻译结果。",
  [TranslationErrorCode.ResponseInvalidItem]: () =>
    "大模型返回的部分翻译结果格式不正确。",
  [TranslationErrorCode.ResponseUnexpectedId]: () =>
    "大模型返回了不属于当前请求的翻译结果。",
  [TranslationErrorCode.ResponseDuplicateId]: () =>
    "大模型返回了重复的翻译结果。",
  [TranslationErrorCode.ResponseMissingId]: () =>
    "大模型没有返回完整的翻译结果。",
  [TranslationErrorCode.ResponseQualityRejected]: () =>
    "大模型未完整翻译部分内容。",
  [TranslationErrorCode.ProviderAuthentication]: () =>
    "API Key 无效或没有访问权限。",
  [TranslationErrorCode.ProviderInvalidRequest]: () =>
    "大模型服务无法处理当前请求。",
  [TranslationErrorCode.ProviderNetwork]: () =>
    "无法连接大模型服务，请检查网络和接口地址。",
  [TranslationErrorCode.ProviderRateLimit]: () =>
    "大模型服务当前繁忙，请稍后重试。",
  [TranslationErrorCode.ProviderServer]: () =>
    "大模型服务暂时不可用，请稍后重试。",
  [TranslationErrorCode.ProviderTimeout]: () =>
    "大模型服务响应超时，请稍后重试。",
  [TranslationErrorCode.ProviderUnknown]: () =>
    "大模型服务返回了未知错误。",
} satisfies Record<TranslationErrorCodeValue, ErrorRenderer>;

export function localizedCoreError(error: unknown): string | undefined {
  if (!isTranslationCoreError(error)) return undefined;
  const message = zhCNCoreErrorMessages[error.code](error.details);
  const requestId = error.details.requestId;
  return typeof requestId === "string" && requestId
    ? `${message}（请求 ID：${requestId}）`
    : message;
}
