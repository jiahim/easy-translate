export function createProvider(options) {
  return {
    name: "custom-fixture",
    async translateBatch(request) {
      return request.items.map((item) => ({
        id: item.id,
        text: String(options.prefix) + item.text,
      }));
    },
  };
}
