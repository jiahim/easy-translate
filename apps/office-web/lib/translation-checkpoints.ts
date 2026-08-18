import type {
  OfficeScopeOptions,
  TranslationCheckpoint,
} from "./office.js";

const DATABASE_NAME = "office-translator";
const DATABASE_VERSION = 1;
const STORE_NAME = "translation-checkpoints";

export interface TranslationCheckpointIntent {
  sourceLanguage: string;
  targetLanguage: string;
  instructions: string;
  scope: Required<OfficeScopeOptions>;
}

export interface StoredTranslationCheckpoint {
  id: string;
  fileName: string;
  fileSize: number;
  fileLastModified: number;
  targetLanguage: string;
  updatedAt: number;
  checkpoint: TranslationCheckpoint;
}

const fileDigestCache = new WeakMap<File, Promise<string>>();

async function digest(value: BufferSource): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest("SHA-256", value);
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function fileDigest(file: File): Promise<string> {
  const cached = fileDigestCache.get(file);
  if (cached) return cached;
  const pending = file.arrayBuffer().then(digest);
  fileDigestCache.set(file, pending);
  return pending;
}

export async function translationCheckpointId(
  file: File,
  intent: TranslationCheckpointIntent,
): Promise<string> {
  const [documentDigest, intentDigest] = await Promise.all([
    fileDigest(file),
    digest(
      new TextEncoder().encode(
        JSON.stringify({
          version: 1,
          sourceLanguage: intent.sourceLanguage,
          targetLanguage: intent.targetLanguage,
          instructions: intent.instructions,
          scope: intent.scope,
        }),
      ),
    ),
  ]);
  return `v1:${documentDigest}:${intentDigest}`;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("无法打开本地翻译进度数据库。"));
    request.onblocked = () =>
      reject(new Error("本地翻译进度数据库正在被其他页面占用。"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("无法保存本地翻译进度。"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("保存本地翻译进度已中止。"));
  });
}

function validCheckpoint(value: unknown): value is TranslationCheckpoint {
  if (typeof value !== "object" || value === null) return false;
  const checkpoint = value as Record<string, unknown>;
  return (
    checkpoint.version === 1 &&
    typeof checkpoint.glossary === "string" &&
    Array.isArray(checkpoint.translations) &&
    checkpoint.translations.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as Record<string, unknown>).id === "string" &&
        typeof (item as Record<string, unknown>).sourceText === "string" &&
        typeof (item as Record<string, unknown>).translatedText === "string",
    ) &&
    typeof checkpoint.completedBatches === "number" &&
    typeof checkpoint.totalBatches === "number" &&
    typeof checkpoint.completedSegments === "number" &&
    typeof checkpoint.totalSegments === "number"
  );
}

function validStoredCheckpoint(
  value: unknown,
): value is StoredTranslationCheckpoint {
  if (typeof value !== "object" || value === null) return false;
  const stored = value as Record<string, unknown>;
  return (
    typeof stored.id === "string" &&
    typeof stored.fileName === "string" &&
    typeof stored.fileSize === "number" &&
    typeof stored.fileLastModified === "number" &&
    typeof stored.targetLanguage === "string" &&
    typeof stored.updatedAt === "number" &&
    validCheckpoint(stored.checkpoint)
  );
}

export async function loadTranslationCheckpoint(
  id: string,
): Promise<StoredTranslationCheckpoint | null> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(id);
    const value = await new Promise<unknown>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error("无法读取本地翻译进度。"));
    });
    return validStoredCheckpoint(value) ? value : null;
  } finally {
    database.close();
  }
}

export async function saveTranslationCheckpoint(
  checkpoint: StoredTranslationCheckpoint,
): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(checkpoint);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function deleteTranslationCheckpoint(id: string): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(id);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}
