import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { POST } from "../app/api/translate/route.js";
import { createTrialSession } from "../lib/trial-server.js";

describe("free trial streaming route", () => {
  it("responds immediately and relays only activity before the validated result", async () => {
    const originalFetch = globalThis.fetch;
    const previousEnvironment = {
      key: process.env.SILICONFLOW_API_KEY,
      model: process.env.SILICONFLOW_MODEL,
      secret: process.env.RATE_LIMIT_SECRET,
    };
    process.env.SILICONFLOW_API_KEY = "test-upstream-key";
    process.env.SILICONFLOW_MODEL = "test-model";
    process.env.RATE_LIMIT_SECRET = "test-stream-secret-at-least-24-characters";

    let resolveUpstream!: (response: Response) => void;
    const upstream = new Promise<Response>((resolve) => {
      resolveUpstream = resolve;
    });
    let sentBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input, init) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return upstream;
    }) as typeof fetch;

    try {
      const source = new Request("http://localhost/api/trial/session", {
        headers: { "cf-connecting-ip": "203.0.113.99" },
      });
      const session = await createTrialSession(source);
      const response = await POST(
        new Request("http://localhost/api/translate", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "cf-connecting-ip": "203.0.113.99",
            "x-trial-session": session.token,
          },
          body: JSON.stringify({
            targetLanguage: "zh-CN",
            items: [
              {
                id: "one",
                text: "Hello",
                context: {
                  format: "word",
                  part: "word/document.xml",
                  kind: "body",
                },
              },
            ],
          }),
        }),
      );

      assert.match(
        response.headers.get("content-type") ?? "",
        /^text\/event-stream/u,
      );
      const reader = response.body!.getReader();
      const first = await reader.read();
      assert.match(new TextDecoder().decode(first.value), /^: connected/u);
      assert.equal(sentBody?.stream, true);

      const modelContent =
        '{"translations":[{"id":"one","text":"你好"}]}';
      const midpoint = Math.floor(modelContent.length / 2);
      const eventStream = [
        modelContent.slice(0, midpoint),
        modelContent.slice(midpoint),
      ]
        .map(
          (content) =>
            `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
        )
        .join("") + "data: [DONE]\n\n";
      resolveUpstream(
        new Response(eventStream, {
          headers: { "content-type": "text/event-stream" },
        }),
      );

      const decoder = new TextDecoder();
      let events = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        events += decoder.decode(value, { stream: true });
      }
      events += decoder.decode();
      assert.match(events, /event: activity/u);
      assert.match(events, /"phase":"response"/u);
      assert.match(events, /"phase":"stream"/u);
      assert.match(events, /event: result/u);
      assert.match(events, /"text":"你好"/u);
      assert.doesNotMatch(events, /test-upstream-key/u);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousEnvironment.key === undefined) {
        delete process.env.SILICONFLOW_API_KEY;
      } else {
        process.env.SILICONFLOW_API_KEY = previousEnvironment.key;
      }
      if (previousEnvironment.model === undefined) {
        delete process.env.SILICONFLOW_MODEL;
      } else {
        process.env.SILICONFLOW_MODEL = previousEnvironment.model;
      }
      if (previousEnvironment.secret === undefined) {
        delete process.env.RATE_LIMIT_SECRET;
      } else {
        process.env.RATE_LIMIT_SECRET = previousEnvironment.secret;
      }
    }
  });

  it("automatically retries once when the model does not return JSON", async () => {
    const originalFetch = globalThis.fetch;
    const previousEnvironment = {
      key: process.env.SILICONFLOW_API_KEY,
      model: process.env.SILICONFLOW_MODEL,
      secret: process.env.RATE_LIMIT_SECRET,
    };
    process.env.SILICONFLOW_API_KEY = "test-upstream-key";
    process.env.SILICONFLOW_MODEL = "test-model";
    process.env.RATE_LIMIT_SECRET = "test-stream-secret-at-least-24-characters";

    const modelResponses = [
      "Sorry, I cannot return JSON.",
      '{"translations":[{"id":"one","text":"你好"}]}',
    ];
    const sentBodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_input, init) => {
      sentBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const content = modelResponses.shift()!;
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch;

    try {
      const source = new Request("http://localhost/api/trial/session", {
        headers: { "cf-connecting-ip": "203.0.113.100" },
      });
      const session = await createTrialSession(source);
      const response = await POST(
        new Request("http://localhost/api/translate", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "cf-connecting-ip": "203.0.113.100",
            "x-trial-session": session.token,
          },
          body: JSON.stringify({
            targetLanguage: "zh-CN",
            items: [
              {
                id: "one",
                text: "Hello",
                context: {
                  format: "word",
                  part: "word/document.xml",
                  kind: "body",
                },
              },
            ],
          }),
        }),
      );

      const events = await response.text();
      assert.equal(sentBodies.length, 2);
      assert.match(events, /"phase":"retry"/u);
      assert.match(events, /"retryReason":"format"/u);
      assert.match(events, /event: result/u);
      assert.match(events, /"text":"你好"/u);
      const retryMessages = sentBodies[1]?.messages as Array<{
        role: string;
        content: string;
      }>;
      assert.match(retryMessages[0]!.content, /exactly one JSON object/u);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousEnvironment.key === undefined) {
        delete process.env.SILICONFLOW_API_KEY;
      } else {
        process.env.SILICONFLOW_API_KEY = previousEnvironment.key;
      }
      if (previousEnvironment.model === undefined) {
        delete process.env.SILICONFLOW_MODEL;
      } else {
        process.env.SILICONFLOW_MODEL = previousEnvironment.model;
      }
      if (previousEnvironment.secret === undefined) {
        delete process.env.RATE_LIMIT_SECRET;
      } else {
        process.env.RATE_LIMIT_SECRET = previousEnvironment.secret;
      }
    }
  });
});
