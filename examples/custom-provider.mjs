export function createProvider(options) {
  return {
    name: "my-company-provider",
    async translateBatch(request) {
      const apiKey = process.env[options.apiKeyEnv];
      if (!apiKey) {
        throw new Error("Missing " + options.apiKeyEnv);
      }

      const response = await fetch(options.url, {
        method: "POST",
        headers: {
          authorization: "Bearer " + apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
      });
      if (!response.ok) {
        throw new Error(
          "Translation API returned HTTP " + response.status,
        );
      }

      // Expected result: { translations: [{ id: "...", text: "..." }] }
      const data = await response.json();
      return data.translations;
    },
  };
}
