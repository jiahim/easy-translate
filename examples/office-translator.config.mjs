export default {
  sourceLanguage: "en",
  targetLanguage: "zh-CN",
  provider: {
    type: "module",
    module: "./custom-provider.mjs",
    options: {
      url: "https://your-provider.example/v1/translate",
      apiKeyEnv: "TRANSLATION_API_KEY",
    },
  },
  batchSize: 40,
  concurrency: 2,
  scope: {
    includeComments: true,
    includeHeadersAndFooters: true,
    includeNotes: false,
    includeMasters: false,
    includeCharts: true,
    includeDiagrams: true,
  },
};
