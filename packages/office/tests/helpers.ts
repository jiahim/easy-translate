import JSZip from "jszip";
import type {
  TranslationBatchRequest,
  TranslationOutputItem,
  TranslationProvider,
} from "../src/types.js";

export class MappingProvider implements TranslationProvider {
  readonly name = "mapping-test-provider";
  readonly requests: TranslationBatchRequest[] = [];

  constructor(
    private readonly translate: (text: string) => string = (text) =>
      "译:" + text,
  ) {}

  async translateBatch(
    request: TranslationBatchRequest,
  ): Promise<TranslationOutputItem[]> {
    this.requests.push(request);
    return request.items.map((item) => ({
      id: item.id,
      text: this.translate(item.text),
    }));
  }
}

export async function zipBuffer(
  files: Record<string, string | Buffer>,
): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, value] of Object.entries(files)) {
    zip.file(name, value, { date: new Date("2020-01-01T00:00:00Z") });
  }
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
}

export async function zipEntry(
  buffer: Buffer,
  name: string,
  type: "string" | "nodebuffer" = "string",
): Promise<string | Buffer> {
  const zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
  const entry = zip.file(name);
  if (!entry) {
    throw new Error("Missing ZIP entry: " + name);
  }
  return entry.async(type);
}

export function joinedText(xml: string, tag: string): string {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(
    "<" +
      escaped +
      "(?=[\\s/>])[^>]*>([\\s\\S]*?)<\\/" +
      escaped +
      "\\s*>",
    "g",
  );
  return Array.from(xml.matchAll(expression), (match) =>
    (match[1] ?? "")
      .replaceAll("&amp;", "&")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">"),
  ).join("");
}
