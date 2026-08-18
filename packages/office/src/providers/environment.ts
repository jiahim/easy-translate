import { OfficeTranslatorError } from "../errors.js";

export function expandEnvironment(value: string): string {
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/giu, (_match, name: string) => {
    const resolved = process.env[name];
    if (resolved === undefined) {
      throw new OfficeTranslatorError(
        "Missing environment variable required by provider config: " + name,
      );
    }
    return resolved;
  });
}

export function resolveHeaders(
  input: Record<string, string> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input ?? {}).map(([name, value]) => [
      name,
      expandEnvironment(value),
    ]),
  );
}
