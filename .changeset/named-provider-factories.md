---
"@easy-translate/providers": minor
"@easy-translate/office": patch
---

Extract HTTP translation providers into `@easy-translate/providers`.

Adds named OpenAI-compatible vendor factories aligned with CC Switch first-party presets, plus `createCustomProvider` for user-supplied URL / protocol / model / API key. Callers pass `apiKey` directly; the package does not read environment variables.

Office keeps `ChatCompletionsProvider`, `GenericHttpProvider` and `createProviderFromConfig` as Node wrappers that still honor `apiKeyEnv` and `OfficeTranslatorError`.
