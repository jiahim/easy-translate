# @easy-translate/providers

## 0.1.0

### Minor Changes

- a40f826: Extract HTTP translation providers into `@easy-translate/providers`.

  Adds named OpenAI-compatible vendor factories aligned with CC Switch first-party presets, plus `createCustomProvider` for user-supplied URL / protocol / model / API key. Callers pass `apiKey` directly; the package does not read environment variables.

  Office keeps `ChatCompletionsProvider`, `GenericHttpProvider` and `createProviderFromConfig` as Node wrappers that still honor `apiKeyEnv` and `OfficeTranslatorError`.

### Patch Changes

- Updated dependencies [a40f826]
  - @easy-translate/core@0.3.0
