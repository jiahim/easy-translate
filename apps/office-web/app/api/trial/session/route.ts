import {
  createTrialSession,
  verifyTurnstile,
} from "@/lib/trial-server";
import { TrialRequestError } from "@/lib/trial-contract";

export const runtime = "nodejs";

function responseHeaders(): HeadersInit {
  return {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  };
}

function errorResponse(error: unknown): Response {
  const known =
    error instanceof TrialRequestError
      ? error
      : new TrialRequestError(
          "无法创建免费试用会话，请稍后重试。",
          500,
          "internal_error",
        );
  return Response.json(
    { error: known.message, code: known.code },
    { status: known.status, headers: responseHeaders() },
  );
}

export async function POST(request: Request): Promise<Response> {
  try {
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (contentLength > 8 * 1024) {
      throw new TrialRequestError("验证请求过大。", 413, "request_too_large");
    }
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 8 * 1024) {
      throw new TrialRequestError("验证请求过大。", 413, "request_too_large");
    }
    let body: unknown = {};
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        throw new TrialRequestError("验证请求不是有效 JSON。");
      }
    }
    const token =
      typeof body === "object" && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>).turnstileToken
        : undefined;
    await verifyTurnstile(request, token);
    const session = await createTrialSession(request);
    return Response.json(session, { headers: responseHeaders() });
  } catch (error) {
    return errorResponse(error);
  }
}
