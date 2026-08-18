"use client";

import {
  ArrowRight,
  Braces,
  Check,
  CircleAlert,
  Download,
  Eye,
  EyeOff,
  FileSpreadsheet,
  FileText,
  Languages,
  Presentation,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import Link from "next/link";
import Script from "next/script";
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import {
  inspectOfficeFile,
  OfficeTranslationError,
  translateProviderBatchWithRetry,
  translateOfficeFileInBrowser,
  type InspectResult,
  type OfficeScopeOptions,
  type RunDistribution,
  type TranslationCheckpoint,
  type TranslationProgress,
  type TranslationProvider,
} from "../lib/office";
import { localizedCoreError } from "../lib/errors";
import {
  BrowserChatProvider,
  BrowserGenericProvider,
  parseHeaders,
} from "../lib/providers";
import {
  CHAT_PROVIDER_PRESETS,
  fetchProviderModels,
  isFastModel,
  providerPreset,
  recommendedProviderModels,
  type ChatProviderPresetId,
  type ProviderModel,
} from "../lib/provider-catalog";
import {
  deleteTranslationCheckpoint,
  loadTranslationCheckpoint,
  saveTranslationCheckpoint,
  translationCheckpointId,
  type StoredTranslationCheckpoint,
  type TranslationCheckpointIntent,
} from "../lib/translation-checkpoints";
import {
  TRIAL_MAX_CONCURRENCY,
  TRIAL_MAX_DOCUMENT_CHARACTERS,
} from "../lib/trial-contract";

type ProviderMode = "trial" | "chat" | "generic";
type JobState = "idle" | "translating" | "complete";

const PROVIDER_STORAGE_KEY = "office-translator.provider.v1";
const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "";
const DEFAULT_OWN_KEY_CONCURRENCY = 1;
const DEFAULT_OWN_KEY_BATCH_CHARACTERS = 2_000;
const MAX_OWN_KEY_CONCURRENCY = 20;
const MAX_OWN_KEY_BATCH_CHARACTERS = 50_000;

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      theme: "light";
      size: "flexible";
      callback(token: string): void;
      "expired-callback"(): void;
      "error-callback"(): void;
    },
  ): string;
  remove(widgetId: string): void;
  reset(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

interface StoredChatProfile {
  baseUrl: string;
  path: string;
  model: string;
  apiKey: string;
  fastMode: boolean;
  models: ProviderModel[];
  modelsFetchedAt?: number;
}

interface StoredProviderPreferences {
  version: 2;
  providerMode: ProviderMode;
  chatProviderId: ChatProviderPresetId;
  chatProfiles: Partial<Record<ChatProviderPresetId, StoredChatProfile>>;
  genericUrl: string;
  genericResponsePath: string;
  genericHeaders: string;
  genericApiKey: string;
  ownKeyConcurrency: number;
  ownKeyBatchCharacters: number;
}

function storedString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function storedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : fallback;
}

function storedProviderMode(value: unknown, fallback: ProviderMode): ProviderMode {
  return value === "trial" || value === "chat" || value === "generic"
    ? value
    : fallback;
}

function isChatProviderPresetId(value: unknown): value is ChatProviderPresetId {
  return CHAT_PROVIDER_PRESETS.some((preset) => preset.id === value);
}

function storedModels(value: unknown): ProviderModel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ProviderModel[] => {
    if (typeof item !== "object" || item === null) return [];
    const model = item as Record<string, unknown>;
    if (typeof model.id !== "string" || !model.id.trim()) return [];
    return [
      {
        id: model.id,
        source: model.source === "recommended" ? "recommended" : "remote",
        ...(typeof model.name === "string" ? { name: model.name } : {}),
        ...(typeof model.owner === "string" ? { owner: model.owner } : {}),
        ...(typeof model.description === "string"
          ? { description: model.description }
          : {}),
        ...(typeof model.contextLength === "number"
          ? { contextLength: model.contextLength }
          : {}),
        ...(typeof model.promptPricePerMillion === "number"
          ? { promptPricePerMillion: model.promptPricePerMillion }
          : {}),
        ...(typeof model.completionPricePerMillion === "number"
          ? { completionPricePerMillion: model.completionPricePerMillion }
          : {}),
        ...(typeof model.isFree === "boolean" ? { isFree: model.isFree } : {}),
      },
    ];
  });
}

function defaultChatProfile(id: ChatProviderPresetId): StoredChatProfile {
  const preset = providerPreset(id);
  return {
    baseUrl: preset.baseUrl,
    path: preset.chatPath,
    model: preset.recommendedModels[0] ?? "",
    apiKey: "",
    fastMode: true,
    models: recommendedProviderModels(preset),
  };
}

function resolvedChatBaseUrl(
  id: ChatProviderPresetId,
  configuredBaseUrl: string,
): string {
  return id === "custom" ? configuredBaseUrl : providerPreset(id).baseUrl;
}

function resolvedChatPath(
  id: ChatProviderPresetId,
  configuredPath: string,
): string {
  return id === "custom" ? configuredPath : providerPreset(id).chatPath;
}

function inferredProviderId(baseUrl: string): ChatProviderPresetId {
  const value = baseUrl.toLowerCase();
  if (value.includes("siliconflow")) return "siliconflow";
  if (value.includes("deepseek")) return "deepseek";
  if (value.includes("openrouter")) return "openrouter";
  if (value.includes("googleapis.com")) return "gemini";
  if (value.includes("localhost:11434")) return "ollama";
  if (value.includes("aliyuncs.com")) return "bailian";
  return "custom";
}

function parseStoredProviderPreferences(
  serialized: string,
): StoredProviderPreferences | null {
  try {
    const value = JSON.parse(serialized) as Record<string, unknown>;
    if (!value || typeof value !== "object") {
      return null;
    }
    if (value.version === 1) {
      const baseUrl = storedString(value.chatBaseUrl);
      const chatProviderId = inferredProviderId(baseUrl);
      const preset = providerPreset(chatProviderId);
      return {
        version: 2,
        providerMode: storedProviderMode(value.providerMode, "chat"),
        chatProviderId,
        chatProfiles: {
          [chatProviderId]: {
            baseUrl:
              chatProviderId === "custom" ? baseUrl : preset.baseUrl,
            path:
              chatProviderId === "custom"
                ? storedString(value.chatPath, "chat/completions")
                : preset.chatPath,
            model: storedString(value.chatModel),
            apiKey: storedString(value.chatApiKey),
            fastMode: value.chatFastMode !== false,
            models: [],
          },
        },
        genericUrl: storedString(value.genericUrl),
        genericResponsePath: storedString(
          value.genericResponsePath,
          "translations",
        ),
        genericHeaders: storedString(
          value.genericHeaders,
          '{\n  "Authorization": "Bearer {{API_KEY}}"\n}',
        ),
        genericApiKey: storedString(value.genericApiKey),
        ownKeyConcurrency: DEFAULT_OWN_KEY_CONCURRENCY,
        ownKeyBatchCharacters: DEFAULT_OWN_KEY_BATCH_CHARACTERS,
      };
    }
    if (value.version !== 2) return null;
    const chatProviderId = isChatProviderPresetId(value.chatProviderId)
      ? value.chatProviderId
      : "custom";
    const rawProfiles =
      typeof value.chatProfiles === "object" && value.chatProfiles !== null
        ? (value.chatProfiles as Record<string, unknown>)
        : {};
    const chatProfiles: Partial<
      Record<ChatProviderPresetId, StoredChatProfile>
    > = {};
    for (const preset of CHAT_PROVIDER_PRESETS) {
      const raw = rawProfiles[preset.id];
      if (typeof raw !== "object" || raw === null) continue;
      const profile = raw as Record<string, unknown>;
      chatProfiles[preset.id] = {
        baseUrl:
          preset.id === "custom"
            ? storedString(profile.baseUrl, preset.baseUrl)
            : preset.baseUrl,
        path:
          preset.id === "custom"
            ? storedString(profile.path, preset.chatPath)
            : preset.chatPath,
        model: storedString(profile.model),
        apiKey: storedString(profile.apiKey),
        fastMode: profile.fastMode !== false,
        models: storedModels(profile.models),
        ...(typeof profile.modelsFetchedAt === "number"
          ? { modelsFetchedAt: profile.modelsFetchedAt }
          : {}),
      };
    }
    return {
      version: 2,
      providerMode: storedProviderMode(value.providerMode, "trial"),
      chatProviderId,
      chatProfiles,
      genericUrl: storedString(value.genericUrl),
      genericResponsePath: storedString(
        value.genericResponsePath,
        "translations",
      ),
      genericHeaders: storedString(
        value.genericHeaders,
        '{\n  "Authorization": "Bearer {{API_KEY}}"\n}',
      ),
      genericApiKey: storedString(value.genericApiKey),
      ownKeyConcurrency: storedInteger(
        value.ownKeyConcurrency,
        DEFAULT_OWN_KEY_CONCURRENCY,
        1,
        MAX_OWN_KEY_CONCURRENCY,
      ),
      ownKeyBatchCharacters: storedInteger(
        value.ownKeyBatchCharacters,
        DEFAULT_OWN_KEY_BATCH_CHARACTERS,
        100,
        MAX_OWN_KEY_BATCH_CHARACTERS,
      ),
    };
  } catch {
    return null;
  }
}

const languages = [
  { value: "auto", label: "自动检测" },
  { value: "zh-CN", label: "简体中文" },
  { value: "zh-TW", label: "繁体中文" },
  { value: "en", label: "英语" },
  { value: "ja", label: "日语" },
  { value: "ko", label: "韩语" },
  { value: "fr", label: "法语" },
  { value: "de", label: "德语" },
  { value: "es", label: "西班牙语" },
  { value: "pt", label: "葡萄牙语" },
  { value: "ru", label: "俄语" },
  { value: "ar", label: "阿拉伯语" },
];

const defaultScope: Required<OfficeScopeOptions> = {
  includeComments: true,
  includeHeadersAndFooters: true,
  includeNotes: false,
  includeMasters: false,
  includeCharts: true,
  includeDiagrams: true,
};

function checkpointIntent(
  sourceLanguage: string,
  targetLanguage: string,
  instructions: string,
  scope: Required<OfficeScopeOptions>,
): TranslationCheckpointIntent {
  return {
    sourceLanguage,
    targetLanguage,
    instructions: instructions.trim(),
    scope,
  };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function formatModelContext(tokens: number): string {
  return tokens >= 1_000_000
    ? (tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1) + "M"
    : Math.round(tokens / 1_000) + "K";
}

function formatModelPrice(value: number): string {
  if (value === 0) return "免费";
  return "$" + value.toFixed(value < 1 ? 2 : value < 10 ? 1 : 0) + "/M";
}

function filePresentation(name: string) {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  if (["xlsx", "xlsm", "xltx", "xltm"].includes(extension)) {
    return {
      label: "Excel",
      className: "file-icon excel",
      Icon: FileSpreadsheet,
    };
  }
  if (
    ["pptx", "pptm", "potx", "potm", "ppsx", "ppsm"].includes(extension)
  ) {
    return {
      label: "PowerPoint",
      className: "file-icon powerpoint",
      Icon: Presentation,
    };
  }
  return { label: "Word", className: "file-icon word", Icon: FileText };
}

function friendlyError(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "翻译已取消，原文件没有发生变化。";
  }
  const coreMessage = localizedCoreError(error);
  if (coreMessage) return coreMessage;
  if (error instanceof TypeError && /fetch|network|failed/iu.test(error.message)) {
    return "无法连接大模型服务。请检查接口地址、网络以及服务是否允许浏览器跨域访问（CORS）。";
  }
  if (error instanceof OfficeTranslationError || error instanceof Error) {
    return error.message;
  }
  return "处理文件时遇到未知错误，请重试。";
}

export function TranslatorApp() {
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const modelFetchRef = useRef<AbortController | null>(null);
  const turnstileContainerRef = useRef<HTMLDivElement | null>(null);
  const turnstileWidgetRef = useRef<string | null>(null);
  const skipNextProviderSaveRef = useRef(false);
  const checkpointLoadRef = useRef(0);
  const [file, setFile] = useState<File | null>(null);
  const [inspection, setInspection] = useState<InspectResult | null>(null);
  const [isInspecting, setIsInspecting] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [fileError, setFileError] = useState("");

  const [sourceLanguage, setSourceLanguage] = useState("auto");
  const [targetLanguage, setTargetLanguage] = useState("zh-CN");
  const [instructions, setInstructions] = useState("");
  const [runDistribution, setRunDistribution] =
    useState<RunDistribution>("style-aware");
  const [scope, setScope] =
    useState<Required<OfficeScopeOptions>>(defaultScope);

  const [providerMode, setProviderMode] = useState<ProviderMode>("trial");
  const initialChatProfile = defaultChatProfile("siliconflow");
  const [chatProviderId, setChatProviderId] =
    useState<ChatProviderPresetId>("siliconflow");
  const [chatProfiles, setChatProfiles] = useState<
    Partial<Record<ChatProviderPresetId, StoredChatProfile>>
  >({});
  const [chatBaseUrl, setChatBaseUrl] = useState(initialChatProfile.baseUrl);
  const [chatPath, setChatPath] = useState(initialChatProfile.path);
  const [chatModel, setChatModel] = useState(initialChatProfile.model);
  const [chatApiKey, setChatApiKey] = useState(initialChatProfile.apiKey);
  const [chatFastMode, setChatFastMode] = useState(
    initialChatProfile.fastMode,
  );
  const [chatModels, setChatModels] = useState<ProviderModel[]>(
    initialChatProfile.models,
  );
  const [modelsFetchedAt, setModelsFetchedAt] = useState<number | undefined>();
  const [modelSearch, setModelSearch] = useState("");
  const [modelFilter, setModelFilter] = useState<"all" | "fast" | "free">(
    "all",
  );
  const [modelStatus, setModelStatus] = useState<
    "idle" | "loading" | "success" | "error"
  >("idle");
  const [modelMessage, setModelMessage] = useState("");
  const [genericUrl, setGenericUrl] = useState("");
  const [genericResponsePath, setGenericResponsePath] =
    useState("translations");
  const [genericHeaders, setGenericHeaders] = useState(
    '{\n  "Authorization": "Bearer {{API_KEY}}"\n}',
  );
  const [genericApiKey, setGenericApiKey] = useState("");
  const [ownKeyConcurrency, setOwnKeyConcurrency] = useState(
    DEFAULT_OWN_KEY_CONCURRENCY,
  );
  const [ownKeyBatchCharacters, setOwnKeyBatchCharacters] = useState(
    DEFAULT_OWN_KEY_BATCH_CHARACTERS,
  );
  const [showSecret, setShowSecret] = useState(false);
  const [providerStatus, setProviderStatus] = useState<
    "idle" | "testing" | "success" | "error"
  >("idle");
  const [providerMessage, setProviderMessage] = useState("");
  const [turnstileReady, setTurnstileReady] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [trialSession, setTrialSession] = useState("");
  const [trialSessionExpiresAt, setTrialSessionExpiresAt] = useState(0);
  const [providerStorageReady, setProviderStorageReady] = useState(false);
  const [providerStorageAvailable, setProviderStorageAvailable] =
    useState(true);

  const [jobState, setJobState] = useState<JobState>("idle");
  const [progress, setProgress] = useState<TranslationProgress | null>(null);
  const [jobError, setJobError] = useState("");
  const [downloadUrl, setDownloadUrl] = useState("");
  const [downloadName, setDownloadName] = useState("");
  const [outputSize, setOutputSize] = useState(0);
  const [savedCheckpoint, setSavedCheckpoint] =
    useState<StoredTranslationCheckpoint | null>(null);
  const [savedCheckpointId, setSavedCheckpointId] = useState("");
  const [checkpointStorageAvailable, setCheckpointStorageAvailable] =
    useState(true);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      try {
        const serialized = window.localStorage.getItem(PROVIDER_STORAGE_KEY);
        const stored = serialized
          ? parseStoredProviderPreferences(serialized)
          : null;
        if (stored) {
          setProviderMode(stored.providerMode);
          setChatProviderId(stored.chatProviderId);
          setChatProfiles(stored.chatProfiles);
          const profile =
            stored.chatProfiles[stored.chatProviderId] ??
            defaultChatProfile(stored.chatProviderId);
          setChatBaseUrl(profile.baseUrl);
          setChatPath(profile.path);
          setChatModel(profile.model);
          setChatApiKey(profile.apiKey);
          setChatFastMode(profile.fastMode);
          setChatModels(
            profile.models.length
              ? profile.models
              : recommendedProviderModels(
                  providerPreset(stored.chatProviderId),
                ),
          );
          setModelsFetchedAt(profile.modelsFetchedAt);
          setGenericUrl(stored.genericUrl);
          setGenericResponsePath(stored.genericResponsePath);
          setGenericHeaders(stored.genericHeaders);
          setGenericApiKey(stored.genericApiKey);
          setOwnKeyConcurrency(stored.ownKeyConcurrency);
          setOwnKeyBatchCharacters(stored.ownKeyBatchCharacters);
        }
      } catch {
        setProviderStorageAvailable(false);
      } finally {
        setProviderStorageReady(true);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!providerStorageReady || !providerStorageAvailable) return;
    if (skipNextProviderSaveRef.current) {
      skipNextProviderSaveRef.current = false;
      return;
    }
    const activeProfile: StoredChatProfile = {
      baseUrl: chatBaseUrl,
      path: chatPath,
      model: chatModel,
      apiKey: chatApiKey,
      fastMode: chatFastMode,
      models: chatModels,
      ...(modelsFetchedAt !== undefined ? { modelsFetchedAt } : {}),
    };
    const preferences: StoredProviderPreferences = {
      version: 2,
      providerMode,
      chatProviderId,
      chatProfiles: { ...chatProfiles, [chatProviderId]: activeProfile },
      genericUrl,
      genericResponsePath,
      genericHeaders,
      genericApiKey,
      ownKeyConcurrency,
      ownKeyBatchCharacters,
    };
    try {
      window.localStorage.setItem(
        PROVIDER_STORAGE_KEY,
        JSON.stringify(preferences),
      );
    } catch {
      queueMicrotask(() => setProviderStorageAvailable(false));
    }
  }, [
    chatApiKey,
    chatBaseUrl,
    chatFastMode,
    chatModel,
    chatModels,
    chatPath,
    chatProfiles,
    chatProviderId,
    genericApiKey,
    genericHeaders,
    genericResponsePath,
    genericUrl,
    ownKeyBatchCharacters,
    ownKeyConcurrency,
    providerMode,
    providerStorageAvailable,
    providerStorageReady,
    modelsFetchedAt,
  ]);

  useEffect(() => {
    if (!file) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setIsInspecting(true);
      setFileError("");
    });
    inspectOfficeFile(file, scope)
      .then((result) => {
        if (active) setInspection(result);
      })
      .catch((error: unknown) => {
        if (active) {
          setInspection(null);
          setFileError(friendlyError(error));
        }
      })
      .finally(() => {
        if (active) setIsInspecting(false);
      });
    return () => {
      active = false;
    };
  }, [file, scope]);

  useEffect(() => {
    const sequence = checkpointLoadRef.current + 1;
    checkpointLoadRef.current = sequence;
    if (!file || !inspection) {
      queueMicrotask(() => {
        if (checkpointLoadRef.current !== sequence) return;
        setSavedCheckpoint(null);
        setSavedCheckpointId("");
      });
      return;
    }

    queueMicrotask(() => {
      if (checkpointLoadRef.current !== sequence) return;
      setSavedCheckpoint(null);
      setSavedCheckpointId("");
    });

    const intent = checkpointIntent(
      sourceLanguage,
      targetLanguage,
      instructions,
      scope,
    );
    void translationCheckpointId(file, intent)
      .then(async (id) => {
        if (checkpointLoadRef.current !== sequence) return;
        setSavedCheckpointId(id);
        const stored = await loadTranslationCheckpoint(id);
        if (checkpointLoadRef.current === sequence) {
          setSavedCheckpoint(stored);
        }
      })
      .catch(() => {
        if (checkpointLoadRef.current !== sequence) return;
        setSavedCheckpoint(null);
        setSavedCheckpointId("");
        setCheckpointStorageAvailable(false);
      });
  }, [file, inspection, sourceLanguage, targetLanguage, instructions, scope]);

  useEffect(() => {
    return () => {
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    };
  }, [downloadUrl]);

  useEffect(() => {
    return () => modelFetchRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!trialSession || !trialSessionExpiresAt) return;
    const timer = window.setTimeout(() => {
      setTrialSession("");
      setTrialSessionExpiresAt(0);
      setTurnstileToken("");
    }, Math.max(0, trialSessionExpiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [trialSession, trialSessionExpiresAt]);

  useEffect(() => {
    if (
      !TURNSTILE_SITE_KEY ||
      !turnstileReady ||
      providerMode !== "trial" ||
      trialSession ||
      !turnstileContainerRef.current ||
      !window.turnstile
    ) {
      return;
    }
    const widgetId = window.turnstile.render(turnstileContainerRef.current, {
      sitekey: TURNSTILE_SITE_KEY,
      theme: "light",
      size: "flexible",
      callback(token) {
        setTurnstileToken(token);
        setProviderStatus("idle");
        setProviderMessage("人机验证已完成");
      },
      "expired-callback"() {
        setTurnstileToken("");
        setProviderStatus("idle");
        setProviderMessage("人机验证已过期，请重新验证");
      },
      "error-callback"() {
        setTurnstileToken("");
        setProviderStatus("error");
        setProviderMessage("人机验证加载失败，请刷新页面重试");
      },
    });
    turnstileWidgetRef.current = widgetId;
    return () => {
      window.turnstile?.remove(widgetId);
      if (turnstileWidgetRef.current === widgetId) {
        turnstileWidgetRef.current = null;
      }
    };
  }, [providerMode, trialSession, trialSessionExpiresAt, turnstileReady]);

  const selectedPreset = providerPreset(chatProviderId);
  const providerReady =
    providerMode === "trial"
      ? true
      : providerMode === "chat"
      ? Boolean(
          resolvedChatBaseUrl(chatProviderId, chatBaseUrl).trim() &&
            chatModel.trim() &&
            (!selectedPreset.requiresApiKey || chatApiKey.trim()),
        )
      : Boolean(genericUrl.trim());
  const trialFileTooLarge = Boolean(
    providerMode === "trial" &&
      inspection &&
      inspection.characters > TRIAL_MAX_DOCUMENT_CHARACTERS,
  );
  const canTranslate = Boolean(
    file &&
      inspection?.segmentsFound &&
      providerReady &&
      !trialFileTooLarge &&
      targetLanguage &&
      jobState !== "translating",
  );
  const resumableSegments = savedCheckpoint?.checkpoint.completedSegments ?? 0;
  const resumableTotalSegments =
    savedCheckpoint?.checkpoint.totalSegments ?? inspection?.uniqueSegments ?? 0;

  function acceptFile(nextFile: File | undefined) {
    if (!nextFile) return;
    if (nextFile.size > 120 * 1024 * 1024) {
      setFileError("文件超过 120 MB。为避免浏览器内存不足，请先压缩或拆分文件。");
      return;
    }
    setFile(nextFile);
    setInspection(null);
    setJobError("");
    setJobState("idle");
    setProgress(null);
    setSavedCheckpoint(null);
    setSavedCheckpointId("");
    if (downloadUrl) {
      URL.revokeObjectURL(downloadUrl);
      setDownloadUrl("");
    }
  }

  function onFileInput(event: ChangeEvent<HTMLInputElement>) {
    acceptFile(event.target.files?.[0]);
    event.target.value = "";
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    acceptFile(event.dataTransfer.files?.[0]);
  }

  function updateScope(
    key: keyof Required<OfficeScopeOptions>,
    value: boolean,
  ) {
    setScope((current) => ({ ...current, [key]: value }));
  }

  function activeChatProfile(): StoredChatProfile {
    return {
      baseUrl: resolvedChatBaseUrl(chatProviderId, chatBaseUrl),
      path: resolvedChatPath(chatProviderId, chatPath),
      model: chatModel,
      apiKey: chatApiKey,
      fastMode: chatFastMode,
      models: chatModels,
      ...(modelsFetchedAt !== undefined ? { modelsFetchedAt } : {}),
    };
  }

  function selectChatProvider(nextId: ChatProviderPresetId) {
    if (nextId === chatProviderId) return;
    modelFetchRef.current?.abort();
    modelFetchRef.current = null;
    setChatProfiles((current) => ({
      ...current,
      [chatProviderId]: activeChatProfile(),
    }));
    const nextPreset = providerPreset(nextId);
    const next = chatProfiles[nextId] ?? defaultChatProfile(nextId);
    setChatProviderId(nextId);
    setChatBaseUrl(nextId === "custom" ? next.baseUrl : nextPreset.baseUrl);
    setChatPath(nextId === "custom" ? next.path : nextPreset.chatPath);
    setChatModel(next.model);
    setChatApiKey(next.apiKey);
    setChatFastMode(next.fastMode);
    setChatModels(
      next.models.length
        ? next.models
        : recommendedProviderModels(providerPreset(nextId)),
    );
    setModelsFetchedAt(next.modelsFetchedAt);
    setModelSearch("");
    setModelFilter("all");
    setModelStatus("idle");
    setModelMessage("");
    setProviderStatus("idle");
    setProviderMessage("");
  }

  async function loadProviderModels() {
    const preset = providerPreset(chatProviderId);
    setModelStatus("loading");
    setModelMessage("");
    modelFetchRef.current?.abort();
    const controller = new AbortController();
    modelFetchRef.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 20_000);
    try {
      const models = await fetchProviderModels(
        preset,
        resolvedChatBaseUrl(chatProviderId, chatBaseUrl),
        chatApiKey,
        controller.signal,
      );
      const fetchedAt = Date.now();
      setChatModels(models);
      setModelsFetchedAt(fetchedAt);
      setChatProfiles((current) => ({
        ...current,
        [chatProviderId]: {
          ...activeChatProfile(),
          models,
          modelsFetchedAt: fetchedAt,
        },
      }));
      setModelStatus("success");
      setModelMessage(`已载入 ${models.length} 个文本模型`);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        if (modelFetchRef.current === controller) {
          setModelStatus("error");
          setModelMessage(
            chatProviderId === "custom"
              ? "拉取模型超时，请检查地址、网络或 CORS 设置。"
              : "拉取模型超时，请检查网络、API Key 或 CORS 设置。",
          );
        }
        return;
      }
      setModelStatus("error");
      setModelMessage(friendlyError(error));
    } finally {
      window.clearTimeout(timer);
      if (modelFetchRef.current === controller) modelFetchRef.current = null;
    }
  }

  function clearProviderPreferences() {
    const confirmed = window.confirm(
      [
        "确认清除当前浏览器中保存的大模型供应商信息吗？",
        "",
        "将清除：大模型供应商选择、接口地址、模型、API Key、请求限制、自定义请求头和已缓存的模型列表。",
        "",
        "清除后无法恢复，你需要重新配置并测试连接。当前已选择的 Office 文件不会被删除。",
      ].join("\n"),
    );
    if (!confirmed) return;

    skipNextProviderSaveRef.current = true;
    try {
      window.localStorage.removeItem(PROVIDER_STORAGE_KEY);
      setProviderStorageAvailable(true);
    } catch {
      setProviderStorageAvailable(false);
    }
    setProviderMode("trial");
    const initial = defaultChatProfile("siliconflow");
    setChatProviderId("siliconflow");
    setChatProfiles({});
    setChatBaseUrl(initial.baseUrl);
    setChatPath(initial.path);
    setChatModel(initial.model);
    setChatApiKey(initial.apiKey);
    setChatFastMode(initial.fastMode);
    setChatModels(initial.models);
    setModelsFetchedAt(undefined);
    setModelSearch("");
    setModelFilter("all");
    setModelStatus("idle");
    setModelMessage("");
    setGenericUrl("");
    setGenericResponsePath("translations");
    setGenericHeaders('{\n  "Authorization": "Bearer {{API_KEY}}"\n}');
    setGenericApiKey("");
    setOwnKeyConcurrency(DEFAULT_OWN_KEY_CONCURRENCY);
    setOwnKeyBatchCharacters(DEFAULT_OWN_KEY_BATCH_CHARACTERS);
    setProviderStatus("idle");
    setProviderMessage("当前浏览器中的大模型供应商设置已清除");
    setShowSecret(false);
    setTrialSession("");
    setTrialSessionExpiresAt(0);
    setTurnstileToken("");
  }

  async function ensureTrialSession(): Promise<string> {
    if (trialSession && trialSessionExpiresAt > Date.now() + 30_000) {
      return trialSession;
    }
    if (TURNSTILE_SITE_KEY && !turnstileToken) {
      throw new OfficeTranslationError("请先完成人机验证。");
    }
    const response = await fetch("/api/trial/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnstileToken }),
    });
    const payload = (await response.json().catch(() => null)) as {
      token?: string;
      expiresAt?: number;
      error?: string;
    } | null;
    if (
      !response.ok ||
      !payload ||
      typeof payload.token !== "string" ||
      typeof payload.expiresAt !== "number"
    ) {
      setTurnstileToken("");
      if (turnstileWidgetRef.current) {
        window.turnstile?.reset(turnstileWidgetRef.current);
      }
      throw new OfficeTranslationError(
        payload?.error ?? "无法创建免费试用会话，请稍后重试。",
      );
    }
    setTrialSession(payload.token);
    setTrialSessionExpiresAt(payload.expiresAt);
    return payload.token;
  }

  async function createProvider(): Promise<TranslationProvider> {
    if (providerMode === "trial") {
      const session = await ensureTrialSession();
      return new BrowserGenericProvider({
        url: "/api/translate",
        headers: { "x-trial-session": session },
        responsePath: "translations",
        requestTimeoutMs: 105_000,
      });
    }
    if (providerMode === "chat") {
      const preset = providerPreset(chatProviderId);
      const baseUrl = resolvedChatBaseUrl(chatProviderId, chatBaseUrl).trim();
      const path = resolvedChatPath(chatProviderId, chatPath).trim();
      if (!baseUrl || !chatModel.trim()) {
        throw new OfficeTranslationError(
          chatProviderId === "custom"
            ? "请填写接口地址和模型 ID。"
            : "请选择或填写模型 ID。",
        );
      }
      if (preset.requiresApiKey && !chatApiKey.trim()) {
        throw new OfficeTranslationError("请填写 API Key。");
      }
      return new BrowserChatProvider({
        baseUrl,
        path: path || undefined,
        model: chatModel.trim(),
        apiKey: chatApiKey,
        fastMode: chatFastMode,
      });
    }
    if (!genericUrl.trim()) {
      throw new OfficeTranslationError("请填写翻译接口地址。");
    }
    return new BrowserGenericProvider({
      url: genericUrl.trim(),
      apiKey: genericApiKey,
      headers: parseHeaders(genericHeaders),
      responsePath: genericResponsePath.trim(),
    });
  }

  async function testProvider() {
    if (jobState === "translating") return;
    setProviderStatus("testing");
    setProviderMessage("");
    try {
      const activeProvider = await createProvider();
      const result = await translateProviderBatchWithRetry(activeProvider, {
        sourceLanguage:
          sourceLanguage === "auto" ? undefined : sourceLanguage,
        targetLanguage,
        items: [
          {
            id: "connection-test",
            text: "Connection test",
            context: {
              format: "word",
              part: "browser/connection-test",
              kind: "body",
            },
          },
        ],
      });
      if (!result[0]?.text) {
        throw new OfficeTranslationError("服务没有返回测试译文。");
      }
      setProviderStatus("success");
      setProviderMessage("连接正常 · " + result[0].text.slice(0, 40));
    } catch (error) {
      setProviderStatus("error");
      setProviderMessage(friendlyError(error));
    }
  }

  async function startTranslation() {
    if (providerStatus === "testing") {
      setJobError("请等待连接测试完成后再开始翻译。");
      return;
    }
    if (!file) {
      setJobError("请先选择一个 Office 文件。");
      return;
    }
    if (
      providerMode === "trial" &&
      inspection &&
      inspection.characters > TRIAL_MAX_DOCUMENT_CHARACTERS
    ) {
      setJobError(
        `免费试用单个文档最多翻译 ${TRIAL_MAX_DOCUMENT_CHARACTERS.toLocaleString()} 个字符；当前文档有 ${inspection.characters.toLocaleString()} 个字符。你可以改用自己的 API Key。`,
      );
      return;
    }
    setJobError("");
    setProviderMessage("");
    setJobState("translating");
    const controller = new AbortController();
    abortRef.current = controller;
    let activeCheckpointId = "";
    let latestCheckpoint: TranslationCheckpoint | undefined;
    let canPersistCheckpoint = checkpointStorageAvailable;
    try {
      try {
        activeCheckpointId = await translationCheckpointId(
          file,
          checkpointIntent(
            sourceLanguage,
            targetLanguage,
            instructions,
            scope,
          ),
        );
        let stored =
          savedCheckpointId === activeCheckpointId ? savedCheckpoint : null;
        if (!stored && canPersistCheckpoint) {
          stored = await loadTranslationCheckpoint(activeCheckpointId);
        }
        if (stored) {
          latestCheckpoint = stored.checkpoint;
          setSavedCheckpoint(stored);
          setSavedCheckpointId(activeCheckpointId);
        }
      } catch {
        canPersistCheckpoint = false;
        setCheckpointStorageAvailable(false);
      }

      const resumedSegments = latestCheckpoint?.completedSegments ?? 0;
      const totalSegments =
        latestCheckpoint?.totalSegments ?? inspection?.uniqueSegments ?? 0;
      setProgress({
        stage: "translation",
        completedBatches: latestCheckpoint?.completedBatches ?? 0,
        submittedBatches: latestCheckpoint?.completedBatches ?? 0,
        respondingBatches: 0,
        totalBatches: latestCheckpoint?.totalBatches ?? 1,
        translatedSegments: resumedSegments,
        totalSegments,
        percentage: totalSegments
          ? Math.round((resumedSegments / totalSegments) * 100)
          : 0,
      });

      const provider = await createProvider();
      const result = await translateOfficeFileInBrowser(file, {
        provider,
        sourceLanguage,
        targetLanguage,
        instructions: instructions.trim() || undefined,
        scope,
        runDistribution,
        concurrency:
          providerMode === "trial" ? TRIAL_MAX_CONCURRENCY : ownKeyConcurrency,
        maxBatchCharacters:
          providerMode === "trial"
            ? DEFAULT_OWN_KEY_BATCH_CHARACTERS
            : ownKeyBatchCharacters,
        signal: controller.signal,
        onProgress: setProgress,
        ...(latestCheckpoint ? { checkpoint: latestCheckpoint } : {}),
        onCheckpoint: async (checkpoint) => {
          latestCheckpoint = checkpoint;
          const stored: StoredTranslationCheckpoint = {
            id: activeCheckpointId,
            fileName: file.name,
            fileSize: file.size,
            fileLastModified: file.lastModified,
            targetLanguage,
            updatedAt: Date.now(),
            checkpoint,
          };
          setSavedCheckpoint(stored);
          setSavedCheckpointId(activeCheckpointId);
          if (!activeCheckpointId || !canPersistCheckpoint) return;
          try {
            await saveTranslationCheckpoint(stored);
          } catch {
            canPersistCheckpoint = false;
            setCheckpointStorageAvailable(false);
          }
        },
      });
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
      setDownloadUrl(URL.createObjectURL(result.blob));
      setDownloadName(result.fileName);
      setOutputSize(result.stats.outputBytes);
      setProgress((current) =>
        current ? { ...current, percentage: 100 } : null,
      );
      setSavedCheckpoint(null);
      setSavedCheckpointId("");
      if (activeCheckpointId && canPersistCheckpoint) {
        try {
          await deleteTranslationCheckpoint(activeCheckpointId);
        } catch {
          setCheckpointStorageAvailable(false);
        }
      }
      setJobState("complete");
    } catch (error) {
      setJobState("idle");
      setJobError(friendlyError(error));
    } finally {
      abortRef.current = null;
    }
  }

  function resetFile() {
    setFile(null);
    setInspection(null);
    setFileError("");
    setJobError("");
    setJobState("idle");
    setProgress(null);
    setSavedCheckpoint(null);
    setSavedCheckpointId("");
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    setDownloadUrl("");
    setDownloadName("");
  }

  const activePreset = providerPreset(chatProviderId);
  const isCustomChatProvider = chatProviderId === "custom";
  const normalizedModelSearch = modelSearch.trim().toLocaleLowerCase();
  const filteredModels = chatModels
    .filter((model) => {
      if (
        normalizedModelSearch &&
        ![model.id, model.name, model.owner, model.description]
          .filter(Boolean)
          .some((value) =>
            value!.toLocaleLowerCase().includes(normalizedModelSearch),
          )
      ) {
        return false;
      }
      if (modelFilter === "fast") return isFastModel(model);
      if (modelFilter === "free") return model.isFree === true;
      return true;
    })
    .slice(0, 80);
  const fileMeta = file ? filePresentation(file.name) : null;
  const SelectedFileIcon = fileMeta?.Icon;

  return (
    <main className="app-shell">
      {TURNSTILE_SITE_KEY && (
        <Script
          src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
          strategy="afterInteractive"
          onReady={() => setTurnstileReady(true)}
        />
      )}
      <header className="topbar">
        <Link className="brand" href="/" aria-label="Office Translator 首页">
          <span className="brand-mark">译</span>
          <span>
            <strong>Office Translator</strong>
            <small>Office 文档翻译</small>
          </span>
        </Link>
        <div className="local-badge">
          <ShieldCheck size={16} />
          尽量保留原文档结构
        </div>
      </header>

      <section className="intro">
        <div>
          <p className="eyebrow">
            <Sparkles size={15} />
            兼容 WPS Office 与 Microsoft Office
          </p>
          <h1>翻译文件，<span>并尽量保留原文格式</span></h1>
          <p className="intro-copy">
            支持 Word 文档、Excel 表格和 PowerPoint（PPT）演示文稿。
            连接你选择的大模型服务，将译文写回原有文本节点，尽量保留结构与格式。
          </p>
        </div>
        <div className="flow-note" aria-label="处理流程">
          <span>选择文件</span>
          <ArrowRight size={16} />
              <span>配置大模型</span>
          <ArrowRight size={16} />
          <span>下载译文</span>
        </div>
      </section>

      <section className="workspace" aria-label="Office 翻译工作台">
        <div className="file-panel">
          <div className="section-heading">
            <div>
              <span className="step-number">01</span>
              <h2>选择 Office 文件</h2>
            </div>
            <span className="section-hint">最大 120 MB</span>
          </div>

          {!file ? (
            <div
              className={"dropzone" + (isDragging ? " dragging" : "")}
              onDragEnter={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setIsDragging(false)}
              onDrop={onDrop}
            >
              <input
                ref={inputRef}
                type="file"
                accept=".docx,.docm,.dotx,.dotm,.pptx,.pptm,.potx,.potm,.ppsx,.ppsm,.xlsx,.xlsm,.xltx,.xltm"
                onChange={onFileInput}
                aria-label="选择 Office 文件"
              />
              <div className="upload-symbol">
                <UploadCloud size={28} />
              </div>
              <h3>拖拽文件到这里</h3>
              <p>支持 WPS Office / Microsoft Office 生成的 DOCX、XLSX、PPTX 及对应宏文件</p>
              <button
                type="button"
                className="secondary-button"
                onClick={() => inputRef.current?.click()}
              >
                浏览文件
              </button>
            </div>
          ) : (
            <div className="selected-file">
              <div className="file-summary">
                <div className={fileMeta!.className}>
                  {SelectedFileIcon && <SelectedFileIcon size={25} />}
                </div>
                <div className="file-details">
                  <strong title={file.name}>{file.name}</strong>
                  <span>
                    {fileMeta!.label} · {formatSize(file.size)}
                  </span>
                </div>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="移除文件"
                  onClick={resetFile}
                  disabled={jobState === "translating"}
                >
                  <X size={18} />
                </button>
              </div>

              <div className="scan-result" aria-live="polite">
                {isInspecting ? (
                  <>
                    <span className="spinner" />
                    正在分析文件结构…
                  </>
                ) : inspection ? (
                  <>
                    <span className="scan-check"><Check size={14} /></span>
                    <span>
                      检测到 <strong>{inspection.segmentsFound}</strong> 个文本段，
                      约 <strong>{inspection.characters.toLocaleString()}</strong> 字符
                    </span>
                  </>
                ) : (
                  <>
                    <CircleAlert size={17} />
                    未检测到文本
                  </>
                )}
              </div>
            </div>
          )}

          {fileError && (
            <div className="inline-error" role="alert">
              <CircleAlert size={17} />
              {fileError}
            </div>
          )}

          <div className="language-block">
            <div className="field-label">
              <Languages size={17} />
              翻译语言
            </div>
            <div className="language-row">
              <label>
                <span>源语言</span>
                <select
                  value={sourceLanguage}
                  onChange={(event) => setSourceLanguage(event.target.value)}
                >
                  {languages.map((language) => (
                    <option key={language.value} value={language.value}>
                      {language.label}
                    </option>
                  ))}
                </select>
              </label>
              <ArrowRight className="language-arrow" size={18} />
              <label>
                <span>目标语言</span>
                <select
                  value={targetLanguage}
                  onChange={(event) => setTargetLanguage(event.target.value)}
                >
                  {languages
                    .filter((language) => language.value !== "auto")
                    .map((language) => (
                      <option key={language.value} value={language.value}>
                        {language.label}
                      </option>
                    ))}
                </select>
              </label>
            </div>
          </div>

          <details className="advanced-settings">
            <summary>
              <span><Settings2 size={17} />翻译范围与高级设置</span>
              <span className="summary-action">展开</span>
            </summary>
            <div className="advanced-content">
              <div className="scope-grid">
                {[
                  ["includeComments", "批注"],
                  ["includeHeadersAndFooters", "页眉与页脚"],
                  ["includeCharts", "图表文字"],
                  ["includeDiagrams", "图示与 SmartArt"],
                  ["includeNotes", "PPT 讲者备注"],
                  ["includeMasters", "PPT 母版与版式"],
                ].map(([key, label]) => (
                  <label className="check-row" key={key}>
                    <input
                      type="checkbox"
                      checked={scope[key as keyof typeof scope]}
                      onChange={(event) =>
                        updateScope(
                          key as keyof typeof scope,
                          event.target.checked,
                        )
                      }
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
              <label className="full-field">
                <span>术语、语气或其他要求（可选）</span>
                <textarea
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                  placeholder="例如：产品名保持英文，使用正式商务语气"
                  rows={3}
                  maxLength={2_000}
                />
              </label>
              <label className="full-field">
                <span>混合样式回填方式</span>
                <select
                  value={runDistribution}
                  onChange={(event) =>
                    setRunDistribution(
                      event.target.value as RunDistribution,
                    )
                  }
                >
                  <option value="style-aware">按样式边界智能回填（推荐）</option>
                  <option value="proportional">按原文字长度分配（兼容旧版）</option>
                  <option value="first">全部放入第一个文本样式</option>
                </select>
              </label>
            </div>
          </details>
        </div>

        <div className="provider-panel">
          <div className="section-heading">
            <div>
              <span className="step-number">02</span>
              <h2>连接大模型服务</h2>
            </div>
            <span className="section-hint">免费试用，或使用自己的 API Key</span>
          </div>

          <div className="provider-tabs" role="tablist" aria-label="大模型供应商接口类型">
            <button
              type="button"
              role="tab"
              aria-selected={providerMode === "trial"}
              className={providerMode === "trial" ? "active" : ""}
              onClick={() => {
                setProviderMode("trial");
                setProviderStatus("idle");
              }}
            >
              <ShieldCheck size={16} />
              免费试用
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={providerMode === "chat"}
              className={providerMode === "chat" ? "active" : ""}
              onClick={() => {
                setProviderMode("chat");
                setProviderStatus("idle");
              }}
            >
              <Sparkles size={16} />
              兼容聊天接口
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={providerMode === "generic"}
              className={providerMode === "generic" ? "active" : ""}
              onClick={() => {
                setProviderMode("generic");
                setProviderStatus("idle");
              }}
            >
              <Braces size={16} />
              通用 HTTP
            </button>
          </div>

          {providerMode === "trial" ? (
            <div className="provider-form trial-provider" role="tabpanel">
              <div className="trial-card">
                <span className="trial-card-icon">
                  <Sparkles size={20} />
                </span>
                <div>
                  <strong>站点提供固定翻译模型</strong>
                  <p>
                    无需填写 API Key。模型和服务密钥只保存在服务端，浏览器仅发送待翻译文本与必要上下文。
                  </p>
                </div>
              </div>
              <div className="trial-limits">
                <span>单文档最多 {TRIAL_MAX_DOCUMENT_CHARACTERS.toLocaleString()} 字符</span>
                <span>最多 {TRIAL_MAX_CONCURRENCY} 个请求并发</span>
                <span>每日额度按访问来源计算</span>
              </div>
              {trialFileTooLarge && inspection && (
                <div className="inline-error trial-error" role="alert">
                  <CircleAlert size={16} />
                  当前文档有 {inspection.characters.toLocaleString()} 个字符，超过免费试用上限。请拆分文档或使用自己的 API Key。
                </div>
              )}
              {trialSession ? (
                <div className="trial-session-ready">
                  <Check size={16} />
                  免费试用会话已就绪
                </div>
              ) : TURNSTILE_SITE_KEY ? (
                <div className="turnstile-area">
                  <span>完成验证后即可开始免费翻译</span>
                  <div ref={turnstileContainerRef} />
                </div>
              ) : (
                <p className="form-note">
                  点击“测试连接”或“开始翻译”时会自动建立受限的试用会话。
                </p>
              )}
            </div>
          ) : providerMode === "chat" ? (
            <div className="provider-form" role="tabpanel">
              <label className="full-field">
                <span>大模型供应商</span>
                <select
                  value={chatProviderId}
                  onChange={(event) =>
                    selectChatProvider(
                      event.target.value as ChatProviderPresetId,
                    )
                  }
                >
                  {(["国内服务", "海外与聚合", "本地与自定义"] as const).map(
                    (group) => (
                      <optgroup key={group} label={group}>
                        {CHAT_PROVIDER_PRESETS.filter(
                          (preset) => preset.group === group,
                        ).map((preset) => (
                          <option key={preset.id} value={preset.id}>
                            {preset.label}
                          </option>
                        ))}
                      </optgroup>
                    ),
                  )}
                </select>
              </label>
              <div className="provider-preset-note">
                <Server size={15} />
                <span>
                  <strong>{activePreset.label}</strong>
                  {activePreset.description}
                  {activePreset.addressHint && (
                    <small>{activePreset.addressHint}</small>
                  )}
                </span>
              </div>
              {isCustomChatProvider && (
                <label className="full-field">
                  <span>接口地址</span>
                  <input
                    type="url"
                    value={chatBaseUrl}
                    onChange={(event) => setChatBaseUrl(event.target.value)}
                    placeholder="https://your-provider.example/v1"
                    autoComplete="url"
                  />
                </label>
              )}
              {(activePreset.requiresApiKey || isCustomChatProvider) && (
                <label className="full-field">
                  <span>
                    API Key{activePreset.requiresApiKey ? "" : "（可选）"}
                  </span>
                  <div className="secret-field">
                    <input
                      type={showSecret ? "text" : "password"}
                      value={chatApiKey}
                      onChange={(event) => setChatApiKey(event.target.value)}
                      placeholder={
                        activePreset.requiresApiKey
                          ? "填写后可拉取模型"
                          : "如接口需要认证，请填写"
                      }
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      aria-label={showSecret ? "隐藏 API Key" : "显示 API Key"}
                      onClick={() => setShowSecret((current) => !current)}
                    >
                      {showSecret ? <EyeOff size={17} /> : <Eye size={17} />}
                    </button>
                  </div>
                </label>
              )}
              <div className={isCustomChatProvider ? "two-fields" : undefined}>
                <div className="full-field">
                  <span>模型 ID</span>
                  <input
                    value={chatModel}
                    onChange={(event) => setChatModel(event.target.value)}
                    placeholder={
                      activePreset.supportsModelPull
                        ? "拉取后选择，或手动输入"
                        : "选择推荐模型，或手动输入"
                    }
                    autoComplete="off"
                  />
                </div>
                {isCustomChatProvider && (
                  <label className="full-field">
                    <span>接口路径</span>
                    <input
                      value={chatPath}
                      onChange={(event) => setChatPath(event.target.value)}
                      placeholder="chat/completions"
                      autoComplete="off"
                    />
                  </label>
                )}
              </div>
              <div className="model-catalog-actions">
                {activePreset.supportsModelPull ? (
                  <button
                    type="button"
                    className="text-button"
                    onClick={loadProviderModels}
                    disabled={
                      modelStatus === "loading" ||
                      !resolvedChatBaseUrl(chatProviderId, chatBaseUrl).trim() ||
                      (activePreset.requiresApiKey && !chatApiKey.trim())
                    }
                  >
                    {modelStatus === "loading" ? (
                      <span className="spinner small" />
                    ) : (
                      <RefreshCw size={14} />
                    )}
                    {chatModels.length ? "刷新模型" : "拉取模型"}
                  </button>
                ) : (
                  <span className="model-static-note">内置常用模型，可继续手动输入</span>
                )}
                {modelMessage && (
                  <span
                    className={
                      "model-message " +
                      (modelStatus === "error" ? "error" : "success")
                    }
                    role="status"
                  >
                    {modelMessage}
                  </span>
                )}
                {modelsFetchedAt && !modelMessage && (
                  <span className="model-static-note">
                    已缓存 {chatModels.length} 个模型
                  </span>
                )}
              </div>
              {chatModels.length > 0 && (
                <div className="model-catalog">
                  <div className="model-catalog-toolbar">
                    <label className="model-search">
                      <Search size={14} />
                      <input
                        value={modelSearch}
                        onChange={(event) => setModelSearch(event.target.value)}
                        placeholder="筛选模型 ID、名称或厂商"
                        aria-label="筛选模型"
                      />
                    </label>
                    <div className="model-filters" aria-label="模型筛选">
                      {([
                        ["all", "全部"],
                        ["fast", "快速"],
                        ["free", "免费"],
                      ] as const).map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          className={modelFilter === value ? "active" : ""}
                          aria-pressed={modelFilter === value}
                          onClick={() => setModelFilter(value)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="model-list" role="listbox" aria-label="可用模型">
                    {filteredModels.length ? (
                      filteredModels.map((model) => (
                        <button
                          key={model.id}
                          type="button"
                          role="option"
                          aria-selected={chatModel === model.id}
                          className={chatModel === model.id ? "selected" : ""}
                          title={model.description}
                          onClick={() => setChatModel(model.id)}
                        >
                          <span>
                            <strong>{model.name ?? model.id}</strong>
                            {model.name && model.name !== model.id && (
                              <small>{model.id}</small>
                            )}
                          </span>
                          <span className="model-meta">
                            {model.owner && <em>{model.owner}</em>}
                            {model.contextLength && (
                              <em>{formatModelContext(model.contextLength)}</em>
                            )}
                            {(model.promptPricePerMillion !== undefined ||
                              model.completionPricePerMillion !== undefined) && (
                              <em>
                                {model.promptPricePerMillion !== undefined &&
                                  `入 ${formatModelPrice(model.promptPricePerMillion)}`}
                                {model.promptPricePerMillion !== undefined &&
                                  model.completionPricePerMillion !== undefined &&
                                  " · "}
                                {model.completionPricePerMillion !== undefined &&
                                  `出 ${formatModelPrice(model.completionPricePerMillion)}`}
                              </em>
                            )}
                            {model.isFree && <em className="free">免费</em>}
                          </span>
                        </button>
                      ))
                    ) : (
                      <p>没有符合当前筛选条件的模型。</p>
                    )}
                  </div>
                  {filteredModels.length === 80 && (
                    <p className="model-limit-note">结果较多，请输入关键词继续筛选。</p>
                  )}
                </div>
              )}
              <label className="fast-mode-row">
                <input
                  type="checkbox"
                  checked={chatFastMode}
                  onChange={(event) => setChatFastMode(event.target.checked)}
                />
                <span>
                  <strong>快速翻译模式</strong>
                  <small>流式接收并关闭深度思考，翻译任务推荐开启</small>
                </span>
              </label>
              <p className="form-note">
                适用于实现 Chat Completions 协议的任意云服务、网关或本地模型。
              </p>
            </div>
          ) : (
            <div className="provider-form" role="tabpanel">
              <label className="full-field">
                <span>批量翻译接口地址</span>
                <input
                  type="url"
                  value={genericUrl}
                  onChange={(event) => setGenericUrl(event.target.value)}
                  placeholder="https://your-provider.example/translate"
                  autoComplete="url"
                />
              </label>
              <label className="full-field">
                <span>响应数据路径</span>
                <input
                  value={genericResponsePath}
                  onChange={(event) =>
                    setGenericResponsePath(event.target.value)
                  }
                  placeholder="translations"
                  autoComplete="off"
                />
              </label>
              <label className="full-field">
                <span>请求头 JSON</span>
                <textarea
                  className="code-input"
                  value={genericHeaders}
                  onChange={(event) => setGenericHeaders(event.target.value)}
                  rows={3}
                  spellCheck={false}
                />
              </label>
              <label className="full-field">
                <span>API Key（替换 {"{{API_KEY}}" }）</span>
                <div className="secret-field">
                  <input
                    type={showSecret ? "text" : "password"}
                    value={genericApiKey}
                    onChange={(event) => setGenericApiKey(event.target.value)}
                    placeholder="保存在当前浏览器"
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    aria-label={showSecret ? "隐藏 API Key" : "显示 API Key"}
                    onClick={() => setShowSecret((current) => !current)}
                  >
                    {showSecret ? <EyeOff size={17} /> : <Eye size={17} />}
                  </button>
                </div>
              </label>
            </div>
          )}

          {providerMode !== "trial" && (
            <div className="request-limit-settings" aria-label="请求限制">
              <div className="request-limit-heading">
                <strong>请求限制</strong>
                <span>根据你的模型服务额度调整</span>
              </div>
              <div className="two-fields">
                <label className="full-field">
                  <span>并发上限</span>
                  <input
                    type="number"
                    min={1}
                    max={MAX_OWN_KEY_CONCURRENCY}
                    step={1}
                    value={ownKeyConcurrency}
                    onChange={(event) =>
                      setOwnKeyConcurrency(
                        Math.max(
                          1,
                          Math.min(
                            MAX_OWN_KEY_CONCURRENCY,
                            Number.parseInt(event.target.value, 10) || 1,
                          ),
                        ),
                      )
                    }
                  />
                  <small>同时发送的请求数，范围 1–{MAX_OWN_KEY_CONCURRENCY}</small>
                </label>
                <label className="full-field">
                  <span>每批最大字符数</span>
                  <input
                    type="number"
                    min={100}
                    max={MAX_OWN_KEY_BATCH_CHARACTERS}
                    step={100}
                    value={ownKeyBatchCharacters}
                    onChange={(event) =>
                      setOwnKeyBatchCharacters(
                        Math.max(
                          100,
                          Math.min(
                            MAX_OWN_KEY_BATCH_CHARACTERS,
                            Number.parseInt(event.target.value, 10) || 100,
                          ),
                        ),
                      )
                    }
                  />
                  <small>按原文计数；单个超长文本段不会拆分</small>
                </label>
              </div>
            </div>
          )}

          <div className="provider-actions">
            <button
              type="button"
              className="text-button"
              onClick={testProvider}
              disabled={
                !providerReady ||
                providerStatus === "testing" ||
                jobState === "translating"
              }
            >
              {providerStatus === "testing" ? (
                <span className="spinner small" />
              ) : (
                <ShieldCheck size={16} />
              )}
              测试连接
            </button>
            {providerMode !== "trial" && (
              <button
                type="button"
                className="text-button quiet"
                onClick={clearProviderPreferences}
              >
                <Trash2 size={15} />
                清除缓存
              </button>
            )}
            {providerMessage && (
              <span
                className={
                  "provider-message " +
                  (providerStatus === "error" ? "error" : "success")
                }
                role="status"
              >
                {providerMessage}
              </span>
            )}
            {providerMode === "trial" ? (
              <span className="cache-status saved">无需保存 API Key</span>
            ) : (
              <span
                className={
                  "cache-status " +
                  (providerStorageAvailable ? "saved" : "unavailable")
                }
              >
                {providerStorageAvailable
                  ? "大模型供应商信息已保存在当前浏览器"
                  : "当前浏览器无法保存大模型供应商信息"}
              </span>
            )}
          </div>

          <div className="privacy-note">
            <FileText size={19} />
            <div>
              <strong>
                {providerMode === "trial"
                  ? "待翻译文本会经本站服务发送至模型供应商"
                  : "内容会发送至所选大模型服务"}
              </strong>
              <p>
                {providerMode === "trial"
                  ? "文档的解包与回写仍在浏览器完成；Office 文件本身不会上传，站点服务仅处理待翻译文本、语言选项与必要上下文。已完成译文会作为续译进度保存在当前浏览器。"
                  : "文档的解包与回写在浏览器完成；待翻译文本与必要上下文会发送到上方配置的接口。大模型供应商设置、API Key 与已完成译文会保存在当前浏览器。"}
              </p>
            </div>
          </div>

          <div className={"run-area " + jobState}>
            {jobState === "complete" ? (
              <div className="complete-state">
                <div className="complete-icon"><Check size={23} /></div>
                <div>
                  <strong>翻译完成</strong>
                  <span>{downloadName} · {formatSize(outputSize)}</span>
                </div>
                <a
                  className="download-button"
                  href={downloadUrl}
                  download={downloadName}
                >
                  <Download size={17} />
                  下载译文
                </a>
              </div>
            ) : jobState === "translating" ? (
              <div className="progress-state" aria-live="polite">
                <div className="progress-copy">
                  <div>
                    <strong>
                      {progress?.stage === "glossary"
                        ? progress.completedBatches
                          ? "文档术语表已建立"
                          : progress.respondingBatches
                            ? "正在生成文档术语表"
                            : "正在建立文档术语表"
                        : progress?.retryingBatches
                          ? progress.retryReason === "format"
                            ? "返回格式异常，正在自动纠正并重试"
                            : progress.retryReason === "busy"
                              ? `服务繁忙，${progress.retryAfterSeconds ?? 1} 秒后自动重试`
                              : "请求未完成，正在自动重试"
                        : progress?.completedBatches
                        ? "正在翻译并回写文本"
                        : progress?.respondingBatches
                          ? "大模型服务已响应，正在生成"
                          : "等待大模型服务响应（最长 30 秒）"}
                    </strong>
                    <span>
                      {progress?.stage === "glossary" ? "术语分析" : "正文翻译"} · 已完成 {progress?.completedBatches ?? 0} /{" "}
                      {progress?.totalBatches ?? 1} 批 · 大模型服务已响应 {progress?.respondingBatches ?? 0} 批
                      · 等待重试 {progress?.retryingBatches ?? 0} 批
                      · 已提交 {progress?.submittedBatches ?? 0} 批 · {progress?.translatedSegments ?? 0} /{" "}
                      {progress?.totalSegments ?? inspection?.uniqueSegments ?? 0} 个文本段
                    </span>
                  </div>
                  <b>{progress?.percentage ?? 0}%</b>
                </div>
                {progress?.stage === "glossary" && (
                  <p className="progress-note">
                    这是正文翻译前的一次独立请求：系统会从表头和高频短语中选取最多 16 个术语，先确定统一译法，再自动开始正文翻译；不会向文档中插入术语表。
                  </p>
                )}
                <div
                  className={
                    "progress-track " +
                    ((progress?.percentage ?? 0) === 0 ? "waiting" : "")
                  }
                >
                  <span style={{ width: (progress?.percentage ?? 0) + "%" }} />
                </div>
                <button
                  type="button"
                  className="cancel-button"
                  onClick={() => abortRef.current?.abort()}
                >
                  取消
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="primary-button"
                disabled={!canTranslate}
                onClick={startTranslation}
              >
                <span>
                  {resumableSegments ? (
                    <RefreshCw size={18} />
                  ) : (
                    <Sparkles size={18} />
                  )}
                  {resumableSegments
                    ? `继续翻译（已保存 ${resumableSegments}/${resumableTotalSegments}）`
                    : "开始翻译"}
                </span>
                <ArrowRight size={19} />
              </button>
            )}
          </div>

          {jobState !== "complete" && resumableSegments > 0 && (
            <div className="resume-notice" role="status">
              <ShieldCheck size={17} />
              <div>
                <strong>
                  本地已保存 {resumableSegments} / {resumableTotalSegments} 个文本段
                </strong>
                <span>
                  可直接用当前模型重试，也可切换供应商或模型后继续；已完成内容不会重复提交。
                </span>
              </div>
            </div>
          )}

          {!checkpointStorageAvailable && jobState !== "complete" && (
            <div className="checkpoint-warning" role="status">
              当前浏览器无法持久保存翻译进度；本页未刷新时仍可继续。
            </div>
          )}

          {jobError && (
            <div className="inline-error bottom-error" role="alert">
              <CircleAlert size={17} />
              {jobError}
            </div>
          )}

          {jobState === "complete" && (
            <button type="button" className="reset-button" onClick={resetFile}>
              <RotateCcw size={15} />
              翻译另一个文件
            </button>
          )}
        </div>
      </section>

      <footer>
        <span>译文写回原有文本位置</span>
        <span>·</span>
        <span>公式与字段代码不参与翻译</span>
        <span>·</span>
        <span>
          {providerMode === "trial"
            ? "免费试用密钥仅保存在服务端"
            : "大模型供应商设置保存在当前浏览器"}
        </span>
      </footer>
    </main>
  );
}
