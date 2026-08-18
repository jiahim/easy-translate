import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Office translation workspace", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Office Translator/);
  assert.match(html, /兼容 WPS Office 与 Microsoft Office/);
  assert.match(html, /Word 文档、Excel 表格和 PowerPoint（PPT）演示文稿/);
  assert.doesNotMatch(html, /OOXML/);
  assert.match(html, /翻译文件/);
  assert.match(html, /并尽量保留原文格式/);
  assert.match(html, /选择 Office 文件/);
  assert.match(html, /连接大模型服务/);
  assert.match(html, /免费试用/);
  assert.match(html, /兼容聊天接口/);
  assert.match(html, /通用 HTTP/);
  assert.match(html, /站点提供固定翻译模型/);
  assert.match(html, /无需填写 API Key/);
  assert.doesNotMatch(html, /硅基流动 SiliconFlow/);
  assert.doesNotMatch(html, />API Key</);
  assert.doesNotMatch(html, />接口地址</);
  assert.doesNotMatch(html, />接口路径</);
  assert.doesNotMatch(html, /拉取模型/);
  assert.match(html, /待翻译文本会经本站服务发送至模型供应商/);
  assert.match(html, /尽量保留原文档结构/);
  assert.doesNotMatch(html, /文件仅在本机浏览器处理|文件不会上传/);
  assert.match(html, /无需保存 API Key/);
  assert.doesNotMatch(html, /清除缓存/);
  assert.match(html, /开始翻译/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|Skeleton/);
});

test("removes starter-only assets and metadata", async () => {
  const [page, layout, translator, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/translator-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /TranslatorApp/);
  assert.match(layout, /lang="zh-CN"/);
  assert.match(layout, /Office Translator/);
  assert.match(layout, /process\.env\.NEXT_PUBLIC_ANALYTICS_SCRIPT_URL/);
  assert.match(layout, /process\.env\.NEXT_PUBLIC_ANALYTICS_WEBSITE_ID/);
  assert.doesNotMatch(layout, /src="https:\/\//);
  assert.match(translator, /localStorage\.getItem\(PROVIDER_STORAGE_KEY\)/);
  assert.match(translator, /localStorage\.setItem\(/);
  assert.match(translator, /localStorage\.removeItem\(PROVIDER_STORAGE_KEY\)/);
  assert.match(translator, /window\.confirm\(/);
  assert.match(translator, /清除后无法恢复，你需要重新配置并测试连接/);
  assert.match(translator, /当前已选择的 Office 文件不会被删除/);
  assert.match(translator, /submittedBatches/);
  assert.match(translator, /并发上限/);
  assert.match(translator, /每批最大字符数/);
  assert.match(translator, /这是正文翻译前的一次独立请求/);
  assert.match(translator, /返回格式异常，正在自动纠正并重试/);
  assert.match(translator, /本地已保存/);
  assert.match(translator, /切换供应商或模型后继续/);
  assert.match(translator, /saveTranslationCheckpoint/);
  assert.match(
    translator,
    /providerMode === "trial" \? TRIAL_MAX_CONCURRENCY : ownKeyConcurrency/,
  );
  assert.match(translator, /最多 \{TRIAL_MAX_CONCURRENCY\} 个请求并发/);
  assert.doesNotMatch(page + layout, /codex-preview|_sites-preview/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
});

test("keeps free trial model access behind the server API", async () => {
  const [translateRoute, sessionRoute, trialServer, environmentExample] =
    await Promise.all([
      readFile(new URL("../app/api/translate/route.ts", import.meta.url), "utf8"),
      readFile(
        new URL("../app/api/trial/session/route.ts", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../lib/trial-server.ts", import.meta.url), "utf8"),
      readFile(new URL("../.env.example", import.meta.url), "utf8"),
    ]);

  assert.match(translateRoute, /process\.env\.SILICONFLOW_API_KEY/);
  assert.match(translateRoute, /process\.env\.SILICONFLOW_MODEL/);
  assert.match(translateRoute, /process\.env\.SILICONFLOW_TIMEOUT_MS/);
  assert.match(
    translateRoute,
    /process\.env\.SILICONFLOW_TIMEOUT_MS \?\? "30000"/,
  );
  assert.match(translateRoute, /maxDuration = 120/);
  assert.match(translateRoute, /enable_thinking: false/);
  assert.match(translateRoute, /stream: true/);
  assert.match(translateRoute, /text\/event-stream/);
  assert.match(translateRoute, /encodeEvent\("activity"/);
  assert.match(translateRoute, /encodeEvent\("result"/);
  assert.match(translateRoute, /encodeEvent\("error"/);
  assert.doesNotMatch(translateRoute, /stream: false/);
  const clearFirstByteTimer = translateRoute.indexOf(
    "globalThis.clearTimeout(firstByteTimer)",
  );
  const readModelStream = translateRoute.indexOf(
    "const content = await readUpstreamEventStream",
  );
  assert.ok(
    clearFirstByteTimer >= 0 &&
      readModelStream >= 0 &&
      clearFirstByteTimer < readModelStream,
    "the free channel must clear its first-byte timer before reading the model stream",
  );
  assert.match(translateRoute, /"x-request-id"/);
  assert.match(translateRoute, /verifyTrialSession/);
  assert.doesNotMatch(translateRoute, /input\.model|request\.model/);
  assert.match(sessionRoute, /verifyTurnstile/);
  assert.match(trialServer, /UPSTASH_REDIS_REST_URL/);
  assert.match(trialServer, /ACQUIRE_QUOTA_SCRIPT/);
  assert.match(environmentExample, /RATE_LIMIT_SECRET=/);
  assert.doesNotMatch(environmentExample, /NEXT_PUBLIC_SILICONFLOW_API_KEY/);
});
