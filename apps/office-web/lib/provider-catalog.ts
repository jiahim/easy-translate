import { OfficeTranslationError } from "./office.js";

export type ChatProviderPresetId =
  | "siliconflow"
  | "deepseek"
  | "bailian"
  | "openrouter"
  | "gemini"
  | "ollama"
  | "custom";

export type ProviderGroup = "国内服务" | "海外与聚合" | "本地与自定义";

export interface ProviderModel {
  id: string;
  name?: string;
  owner?: string;
  description?: string;
  contextLength?: number;
  promptPricePerMillion?: number;
  completionPricePerMillion?: number;
  isFree?: boolean;
  source: "remote" | "recommended";
}

export interface ChatProviderPreset {
  id: ChatProviderPresetId;
  label: string;
  group: ProviderGroup;
  description: string;
  baseUrl: string;
  chatPath: string;
  requiresApiKey: boolean;
  supportsModelPull: boolean;
  recommendedModels: string[];
  addressHint?: string;
}

export const CHAT_PROVIDER_PRESETS: ChatProviderPreset[] = [
  {
    id: "siliconflow",
    label: "硅基流动 SiliconFlow",
    group: "国内服务",
    description: "模型丰富，支持按文本模型拉取目录。",
    baseUrl: "https://api.siliconflow.cn/v1",
    chatPath: "chat/completions",
    requiresApiKey: true,
    supportsModelPull: true,
    recommendedModels: [],
  },
  {
    id: "deepseek",
    label: "DeepSeek 官方",
    group: "国内服务",
    description: "官方 API，模型目录简洁。",
    baseUrl: "https://api.deepseek.com",
    chatPath: "chat/completions",
    requiresApiKey: true,
    supportsModelPull: true,
    recommendedModels: [],
  },
  {
    id: "bailian",
    label: "阿里云百炼",
    group: "国内服务",
    description: "支持千问及第三方模型，模型 ID 可手动输入。",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    chatPath: "chat/completions",
    requiresApiKey: true,
    supportsModelPull: false,
    recommendedModels: ["qwen3.7-flash", "qwen3.7-plus", "qwen3.7-max"],
    addressHint: "如需使用地域或业务空间专属地址，请选择“自定义兼容接口”。",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    group: "海外与聚合",
    description: "聚合多家模型，可显示价格与上下文长度。",
    baseUrl: "https://openrouter.ai/api/v1",
    chatPath: "chat/completions",
    requiresApiKey: true,
    supportsModelPull: true,
    recommendedModels: [],
  },
  {
    id: "gemini",
    label: "Google Gemini",
    group: "海外与聚合",
    description: "使用 Gemini 的 OpenAI 兼容接口。",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    chatPath: "chat/completions",
    requiresApiKey: true,
    supportsModelPull: true,
    recommendedModels: [],
  },
  {
    id: "ollama",
    label: "Ollama 本地模型",
    group: "本地与自定义",
    description: "读取本机已安装模型，无需 API Key。",
    baseUrl: "http://localhost:11434/v1",
    chatPath: "chat/completions",
    requiresApiKey: false,
    supportsModelPull: true,
    recommendedModels: [],
  },
  {
    id: "custom",
    label: "自定义兼容接口",
    group: "本地与自定义",
    description: "适用于其他 OpenAI 兼容服务、网关或代理。",
    baseUrl: "",
    chatPath: "chat/completions",
    requiresApiKey: false,
    supportsModelPull: true,
    recommendedModels: [],
  },
];

export function providerPreset(
  id: ChatProviderPresetId,
): ChatProviderPreset {
  return (
    CHAT_PROVIDER_PRESETS.find((preset) => preset.id === id) ??
    CHAT_PROVIDER_PRESETS.at(-1)!
  );
}

export function recommendedProviderModels(
  preset: ChatProviderPreset,
): ProviderModel[] {
  return preset.recommendedModels.map((id) => ({
    id,
    name: id,
    source: "recommended",
  }));
}

function modelListUrl(
  preset: ChatProviderPreset,
  baseUrl: string,
): string {
  if (preset.id === "ollama") {
    return baseUrl.replace(/\/v1\/?$/u, "") + "/api/tags";
  }
  const suffix =
    preset.id === "siliconflow"
      ? "/models?type=text"
      : preset.id === "openrouter"
        ? "/models?output_modalities=text"
        : "/models";
  return baseUrl.replace(/\/+$/u, "") + suffix;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function pricePerMillion(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const price = Number(value);
  return Number.isFinite(price) ? price * 1_000_000 : undefined;
}

function looksLikeTextGenerationModel(id: string): boolean {
  return !/(?:embedding|rerank|image|stable-diffusion|flux|video|audio|whisper|speech|tts)(?:[-_/.:]|$)/iu.test(
    id,
  );
}

function normalizeOpenAiModels(payload: unknown): ProviderModel[] {
  if (typeof payload !== "object" || payload === null) return [];
  const data = (payload as Record<string, unknown>).data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((entry): ProviderModel[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const id = optionalString(record.id);
    if (!id || !looksLikeTextGenerationModel(id)) return [];
    const pricing =
      typeof record.pricing === "object" && record.pricing !== null
        ? (record.pricing as Record<string, unknown>)
        : undefined;
    const promptPricePerMillion = pricePerMillion(pricing?.prompt);
    const completionPricePerMillion = pricePerMillion(pricing?.completion);
    const name = optionalString(record.name);
    const owner = optionalString(record.owned_by);
    const description = optionalString(record.description);
    const contextLength = optionalNumber(record.context_length);
    return [
      {
        id,
        source: "remote",
        ...(name ? { name } : {}),
        ...(owner ? { owner } : {}),
        ...(description ? { description } : {}),
        ...(contextLength ? { contextLength } : {}),
        ...(promptPricePerMillion !== undefined
          ? { promptPricePerMillion }
          : {}),
        ...(completionPricePerMillion !== undefined
          ? { completionPricePerMillion }
          : {}),
        ...(promptPricePerMillion !== undefined &&
        completionPricePerMillion !== undefined
          ? {
              isFree:
                promptPricePerMillion === 0 && completionPricePerMillion === 0,
            }
          : {}),
      },
    ];
  });
}

function normalizeOllamaModels(payload: unknown): ProviderModel[] {
  if (typeof payload !== "object" || payload === null) return [];
  const models = (payload as Record<string, unknown>).models;
  if (!Array.isArray(models)) return [];
  return models.flatMap((entry): ProviderModel[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const id = optionalString(record.name) ?? optionalString(record.model);
    if (!id) return [];
    const details =
      typeof record.details === "object" && record.details !== null
        ? (record.details as Record<string, unknown>)
        : undefined;
    const parameterSize = optionalString(details?.parameter_size);
    const quantization = optionalString(details?.quantization_level);
    return [
      {
        id,
        name: id,
        source: "remote",
        ...(parameterSize || quantization
          ? {
              description: [parameterSize, quantization]
                .filter(Boolean)
                .join(" · "),
            }
          : {}),
      },
    ];
  });
}

export async function fetchProviderModels(
  preset: ChatProviderPreset,
  baseUrl: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<ProviderModel[]> {
  if (!preset.supportsModelPull) {
    return recommendedProviderModels(preset);
  }
  if (!baseUrl.trim()) {
    throw new OfficeTranslationError("请先填写接口地址。");
  }
  if (preset.requiresApiKey && !apiKey.trim()) {
    throw new OfficeTranslationError("请先填写 API Key。");
  }
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey.trim()) headers.authorization = "Bearer " + apiKey.trim();
  const response = await fetch(modelListUrl(preset, baseUrl.trim()), {
    method: "GET",
    headers,
    ...(signal ? { signal } : {}),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new OfficeTranslationError(
      `模型列表请求返回 HTTP ${response.status}${raw ? "：" + raw.slice(0, 180) : ""}`,
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    throw new OfficeTranslationError("大模型供应商返回的模型列表不是有效 JSON。", {
      cause: error,
    });
  }
  const models =
    preset.id === "ollama"
      ? normalizeOllamaModels(payload)
      : normalizeOpenAiModels(payload);
  const unique = [...new Map(models.map((model) => [model.id, model])).values()];
  if (!unique.length) {
    throw new OfficeTranslationError(
      "没有找到可用的文本生成模型，可继续手动填写模型 ID。",
    );
  }
  return unique.sort((left, right) => left.id.localeCompare(right.id));
}

export function isFastModel(model: ProviderModel): boolean {
  return /(?:flash|lite|mini|turbo|instant|small)(?:[-_/.:]|$)/iu.test(
    model.id,
  );
}
