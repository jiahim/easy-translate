export default {
  targetLanguage: "zh-CN",
  provider: {
    type: "generic-http",
    url: "https://your-provider.example/v1/translate-batch",
    headers: {
      authorization: "Bearer ${TRANSLATION_API_KEY}",
    },
    responsePath: "data.translations",
  },
};
