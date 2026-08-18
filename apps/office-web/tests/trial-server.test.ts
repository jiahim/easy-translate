import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  acquireTrialQuota,
  clientIp,
  createTrialSession,
  verifyTrialSession,
} from "../lib/trial-server.js";
import type { TranslationBatchRequest } from "../lib/office.js";

const translationRequest: TranslationBatchRequest = {
  targetLanguage: "zh-CN",
  items: [
    {
      id: "one",
      text: "Hello",
      context: {
        format: "word" as const,
        part: "word/document.xml",
        kind: "body",
      },
    },
  ],
};

describe("free trial session isolation", () => {
  it("prefers Cloudflare's original visitor address over proxy forwarding", () => {
    const request = new Request("https://example.test/api/trial/session", {
      headers: {
        "cf-connecting-ip": "203.0.113.10",
        "x-forwarded-for": "198.51.100.20",
      },
    });
    assert.equal(clientIp(request), "203.0.113.10");
  });

  it("isolates concurrency leases by signed browser session", async () => {
    const previousSecret = process.env.RATE_LIMIT_SECRET;
    process.env.RATE_LIMIT_SECRET = "test-rate-limit-secret-at-least-24-chars";
    const request = new Request("https://example.test/api/translate", {
      headers: { "cf-connecting-ip": "203.0.113.77" },
    });

    try {
      const firstToken = await createTrialSession(request);
      const secondToken = await createTrialSession(request);
      const first = await verifyTrialSession(request, firstToken.token);
      const second = await verifyTrialSession(request, secondToken.token);

      assert.equal(first.ipHash, second.ipHash);
      assert.notEqual(first.sessionHash, second.sessionHash);

      const firstLeases = [];
      for (let index = 0; index < 3; index += 1) {
        firstLeases.push(
          await acquireTrialQuota(
            first.ipHash,
            first.sessionHash,
            translationRequest,
          ),
        );
      }
      const secondLease = await acquireTrialQuota(
        second.ipHash,
        second.sessionHash,
        translationRequest,
      );
      await assert.rejects(
        acquireTrialQuota(first.ipHash, first.sessionHash, translationRequest),
        /当前翻译任务较多/u,
      );
      await Promise.all(firstLeases.map((lease) => lease.release()));
      await secondLease.release();
    } finally {
      if (previousSecret === undefined) delete process.env.RATE_LIMIT_SECRET;
      else process.env.RATE_LIMIT_SECRET = previousSecret;
    }
  });
});
