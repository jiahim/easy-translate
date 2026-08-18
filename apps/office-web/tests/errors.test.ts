import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  TranslationErrorCode,
  TranslationProviderError,
} from "@easy-translate/core";
import { localizedCoreError } from "../lib/errors.js";

describe("localized core errors", () => {
  it("renders known core error codes without exposing debug messages", () => {
    const error = new TranslationProviderError(
      TranslationErrorCode.ProviderTimeout,
      "debug-only provider timeout",
      { details: { requestId: "safe-request-id" } },
    );

    assert.equal(
      localizedCoreError(error),
      "大模型服务响应超时，请稍后重试。（请求 ID：safe-request-id）",
    );
    assert.equal(localizedCoreError(new Error("unknown")), undefined);
  });
});
