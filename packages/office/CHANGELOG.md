# @easy-translate/office

## 0.2.2

### Patch Changes

- a40f826: Make the core package usable without learning the plan abstraction first.

  Adds a convenience layer on top of the unchanged engine: `translateTexts` translates plain strings and returns them in input order, `createPlan` fills in `schemaVersion`, the document descriptor, unit ids and context, and `toTranslationRecord` converts the result map into a plain object.

  Opens up the response handling that used to be private to the engine. `parseBatchOutput` and `RESPONSE_FORMAT_RETRY_INSTRUCTION` let provider authors reuse the same id and shape validation instead of reimplementing it, and `defineProvider` plus `createEchoProvider` remove the boilerplate from provider literals, docs and tests.

  Widens every optional option to accept an explicit `undefined`, so wrappers can forward options directly under `exactOptionalPropertyTypes` instead of building objects with conditional spreads. `retry` now also accepts a number as shorthand for `{ maxRetries: n }`.

  Adds `stats.uniqueUnits`, `stats.freshlyTranslatedUnits` and `stats.fromCheckpointUnits` so resumed runs can report the work actually sent to the provider. `stats.translatedUnits` keeps its current value but is deprecated, because it counts deduplicated plan units rather than units translated in this run, and will be removed in 0.4.0.

  Documents the whole public surface with JSDoc including default values, and rewrites the README into quick start, guides and reference sections with a full error code table. The previous quick start example did not compile because it omitted the required `context` field.

- a40f826: Extract HTTP translation providers into `@easy-translate/providers`.

  Adds named OpenAI-compatible vendor factories aligned with CC Switch first-party presets, plus `createCustomProvider` for user-supplied URL / protocol / model / API key. Callers pass `apiKey` directly; the package does not read environment variables.

  Office keeps `ChatCompletionsProvider`, `GenericHttpProvider` and `createProviderFromConfig` as Node wrappers that still honor `apiKeyEnv` and `OfficeTranslatorError`.

- Updated dependencies [a40f826]
- Updated dependencies [a40f826]
  - @easy-translate/core@0.3.0
  - @easy-translate/providers@0.1.0

## 0.2.1

### Patch Changes

- Fix the published package metadata so the `@easy-translate/core` dependency uses a public semver range instead of a pnpm workspace protocol.

## 0.2.0

### Minor Changes

- aea40fa: Add stable, typed translation error codes with structured details, make retries opt-in for provider and unknown failures, and migrate HTTP/response errors to preserve safe retry metadata while distinguishing normalized core codes from raw provider codes.

### Patch Changes

- Updated dependencies [aea40fa]
  - @easy-translate/core@0.2.0
