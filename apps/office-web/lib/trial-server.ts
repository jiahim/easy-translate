import type { TranslationBatchRequest } from "./office.js";
import {
  TRIAL_MAX_CONCURRENCY,
  TrialRequestError,
} from "@/lib/trial-contract";

const encoder = new TextEncoder();
const SESSION_VERSION = 1;
const SESSION_TTL_SECONDS = 30 * 60;
const DEFAULT_MINUTE_REQUEST_LIMIT = 20;
const DEFAULT_DAILY_CHARACTER_LIMIT = 30_000;

interface TrialSessionPayload {
  version: number;
  ipHash: string;
  expiresAt: number;
  nonce: string;
}

interface VerifiedTrialSession {
  ipHash: string;
  sessionHash: string;
}

interface QuotaLease {
  release(): Promise<void>;
}

interface LocalQuotaBucket {
  minuteKey: string;
  minuteRequests: number;
  dayKey: string;
  dailyCharacters: number;
  concurrent: number;
}

const localQuota = new Map<string, LocalQuotaBucket>();
const localConcurrency = new Map<string, number>();

const ACQUIRE_QUOTA_SCRIPT = `
local minute = tonumber(redis.call("GET", KEYS[1]) or "0")
local daily = tonumber(redis.call("GET", KEYS[2]) or "0")
local concurrent = tonumber(redis.call("GET", KEYS[3]) or "0")
local minuteLimit = tonumber(ARGV[1])
local dailyLimit = tonumber(ARGV[2])
local concurrentLimit = tonumber(ARGV[3])
local characterCost = tonumber(ARGV[4])

if minute + 1 > minuteLimit then
  return {0, "minute", minute, daily, concurrent}
end
if daily + characterCost > dailyLimit then
  return {0, "daily", minute, daily, concurrent}
end
if concurrent + 1 > concurrentLimit then
  return {0, "concurrent", minute, daily, concurrent}
end

local nextMinute = redis.call("INCR", KEYS[1])
if nextMinute == 1 then redis.call("EXPIRE", KEYS[1], 120) end
local nextDaily = redis.call("INCRBY", KEYS[2], characterCost)
if nextDaily == characterCost then redis.call("EXPIRE", KEYS[2], 172800) end
local nextConcurrent = redis.call("INCR", KEYS[3])
redis.call("EXPIRE", KEYS[3], 150)
return {1, "ok", nextMinute, nextDaily, nextConcurrent}
`;

const RELEASE_QUOTA_SCRIPT = `
local concurrent = tonumber(redis.call("GET", KEYS[1]) or "0")
if concurrent <= 1 then
  redis.call("DEL", KEYS[1])
  return 0
end
return redis.call("DECR", KEYS[1])
`;

function integerEnvironment(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  try {
    return Uint8Array.from(Buffer.from(value, "base64url"));
  } catch {
    throw new TrialRequestError("试用会话格式无效。", 401, "invalid_session");
  }
}

function rateLimitSecret(): string {
  const secret = process.env.RATE_LIMIT_SECRET;
  if (!secret || secret.length < 24) {
    throw new TrialRequestError(
      "免费试用服务尚未完成安全配置。",
      503,
      "trial_not_configured",
    );
  }
  return secret;
}

async function hmacKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(rateLimitSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function hmac(value: string): Promise<Uint8Array> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(),
    encoder.encode(value),
  );
  return new Uint8Array(signature);
}

export function clientIp(request: Request): string {
  const forwarded =
    request.headers.get("x-vercel-forwarded-for") ??
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for") ??
    request.headers.get("x-real-ip");
  const ip = forwarded?.split(",")[0]?.trim();
  if (ip) return ip;
  if (process.env.NODE_ENV !== "production") return "127.0.0.1";
  throw new TrialRequestError("无法识别当前访问来源。", 400, "missing_client_ip");
}

export async function clientIpHash(request: Request): Promise<string> {
  return base64Url(await hmac(`ip:${clientIp(request)}`)).slice(0, 32);
}

export async function createTrialSession(request: Request): Promise<{
  token: string;
  expiresAt: number;
}> {
  const payload: TrialSessionPayload = {
    version: SESSION_VERSION,
    ipHash: await clientIpHash(request),
    expiresAt: Date.now() + SESSION_TTL_SECONDS * 1_000,
    nonce: crypto.randomUUID(),
  };
  const encoded = base64Url(encoder.encode(JSON.stringify(payload)));
  const signature = base64Url(await hmac(`session:${encoded}`));
  return { token: `${encoded}.${signature}`, expiresAt: payload.expiresAt };
}

export async function verifyTrialSession(
  request: Request,
  token: string | null,
): Promise<VerifiedTrialSession> {
  if (!token || token.length > 4_096) {
    throw new TrialRequestError("请先完成人机验证。", 401, "missing_session");
  }
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra) {
    throw new TrialRequestError("试用会话格式无效。", 401, "invalid_session");
  }
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(),
    decodeBase64Url(signature),
    encoder.encode(`session:${encoded}`),
  );
  if (!valid) {
    throw new TrialRequestError("试用会话签名无效。", 401, "invalid_session");
  }
  let payload: TrialSessionPayload;
  try {
    payload = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(encoded)),
    ) as TrialSessionPayload;
  } catch {
    throw new TrialRequestError("试用会话格式无效。", 401, "invalid_session");
  }
  if (
    payload.version !== SESSION_VERSION ||
    typeof payload.ipHash !== "string" ||
    typeof payload.expiresAt !== "number" ||
    typeof payload.nonce !== "string" ||
    payload.expiresAt <= Date.now()
  ) {
    throw new TrialRequestError("试用会话已过期，请重新验证。", 401, "expired_session");
  }
  const currentIpHash = await clientIpHash(request);
  if (payload.ipHash !== currentIpHash) {
    throw new TrialRequestError("试用会话与当前访问来源不匹配。", 401, "invalid_session");
  }
  return {
    ipHash: currentIpHash,
    sessionHash: base64Url(await hmac(`session-nonce:${payload.nonce}`)).slice(
      0,
      32,
    ),
  };
}

export async function verifyTurnstile(
  request: Request,
  token: unknown,
): Promise<void> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return;
  if (typeof token !== "string" || !token || token.length > 2_048) {
    throw new TrialRequestError("请完成人机验证后再试。", 400, "turnstile_required");
  }
  let response: Response;
  try {
    response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          secret,
          response: token,
          remoteip: clientIp(request),
          idempotency_key: crypto.randomUUID(),
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    throw new TrialRequestError("人机验证服务暂时不可用。", 503, "turnstile_unavailable");
  }
  const result = (await response.json().catch(() => null)) as {
    success?: boolean;
  } | null;
  if (!response.ok || result?.success !== true) {
    throw new TrialRequestError("人机验证未通过，请刷新后重试。", 400, "turnstile_failed");
  }
}

function quotaLimits() {
  return {
    minute: integerEnvironment(
      "TRIAL_REQUESTS_PER_MINUTE",
      DEFAULT_MINUTE_REQUEST_LIMIT,
      1,
      1_000,
    ),
    dailyCharacters: integerEnvironment(
      "TRIAL_DAILY_CHARACTERS",
      DEFAULT_DAILY_CHARACTER_LIMIT,
      1_000,
      10_000_000,
    ),
    concurrent: TRIAL_MAX_CONCURRENCY,
  };
}

async function upstashCommand(command: unknown[]): Promise<unknown> {
  const url = process.env.UPSTASH_REDIS_REST_URL?.replace(/\/+$/u, "");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new TrialRequestError(
      "免费试用额度服务尚未配置。",
      503,
      "quota_not_configured",
    );
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new TrialRequestError("免费试用额度服务暂时不可用。", 503, "quota_unavailable");
  }
  const payload = (await response.json().catch(() => null)) as {
    result?: unknown;
    error?: string;
  } | null;
  if (!response.ok || !payload || payload.error) {
    throw new TrialRequestError("免费试用额度服务暂时不可用。", 503, "quota_unavailable");
  }
  return payload.result;
}

function quotaError(reason: unknown): TrialRequestError {
  if (reason === "daily") {
    return new TrialRequestError(
      "今天的免费翻译字符额度已用完，请明天再试或使用自己的 API Key。",
      429,
      "daily_quota_exceeded",
    );
  }
  if (reason === "concurrent") {
    return new TrialRequestError(
      "当前翻译任务较多，请稍后再试。",
      429,
      "concurrency_exceeded",
    );
  }
  return new TrialRequestError(
    "请求过于频繁，请稍后再试。",
    429,
    "rate_limit_exceeded",
  );
}

function localQuotaLease(
  ipHash: string,
  sessionHash: string,
  characters: number,
  now: Date,
): QuotaLease {
  const limits = quotaLimits();
  const minuteKey = now.toISOString().slice(0, 16);
  const dayKey = now.toISOString().slice(0, 10);
  const current = localQuota.get(ipHash) ?? {
    minuteKey,
    minuteRequests: 0,
    dayKey,
    dailyCharacters: 0,
    concurrent: 0,
  };
  if (current.minuteKey !== minuteKey) {
    current.minuteKey = minuteKey;
    current.minuteRequests = 0;
  }
  if (current.dayKey !== dayKey) {
    current.dayKey = dayKey;
    current.dailyCharacters = 0;
  }
  if (current.minuteRequests + 1 > limits.minute) throw quotaError("minute");
  if (current.dailyCharacters + characters > limits.dailyCharacters) {
    throw quotaError("daily");
  }
  const concurrent = localConcurrency.get(sessionHash) ?? 0;
  if (concurrent + 1 > limits.concurrent) throw quotaError("concurrent");
  current.minuteRequests += 1;
  current.dailyCharacters += characters;
  current.concurrent = concurrent + 1;
  localConcurrency.set(sessionHash, concurrent + 1);
  localQuota.set(ipHash, current);
  return {
    async release() {
      const remaining = Math.max(0, (localConcurrency.get(sessionHash) ?? 1) - 1);
      current.concurrent = remaining;
      if (remaining) localConcurrency.set(sessionHash, remaining);
      else localConcurrency.delete(sessionHash);
    },
  };
}

export async function acquireTrialQuota(
  ipHash: string,
  sessionHash: string,
  request: TranslationBatchRequest,
): Promise<QuotaLease> {
  const characters = request.items.reduce((total, item) => total + item.text.length, 0);
  const now = new Date();
  if (process.env.NODE_ENV !== "production") {
    return localQuotaLease(ipHash, sessionHash, characters, now);
  }
  const limits = quotaLimits();
  const minuteBucket = Math.floor(now.getTime() / 60_000);
  const dayBucket = now.toISOString().slice(0, 10);
  const minuteKey = `office-translator:trial:minute:${ipHash}:${minuteBucket}`;
  const dayKey = `office-translator:trial:day:${ipHash}:${dayBucket}`;
  const concurrentKey = `office-translator:trial:concurrent:${sessionHash}`;
  const result = await upstashCommand([
    "EVAL",
    ACQUIRE_QUOTA_SCRIPT,
    3,
    minuteKey,
    dayKey,
    concurrentKey,
    limits.minute,
    limits.dailyCharacters,
    limits.concurrent,
    characters,
  ]);
  if (!Array.isArray(result) || Number(result[0]) !== 1) {
    throw quotaError(Array.isArray(result) ? result[1] : "minute");
  }
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      try {
        await upstashCommand(["EVAL", RELEASE_QUOTA_SCRIPT, 1, concurrentKey]);
      } catch {
        // The concurrency key has a short TTL, so release failures self-heal.
      }
    },
  };
}
