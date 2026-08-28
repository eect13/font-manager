const DB_NAME = "font-manager";
const STORE = "blobs";
const VERSION = 1;
const PREVIEW_PREFIX = "preview:";
/** Keep a handful of web preview faces. Uploads (no prefix) are never evicted here. */
const PREVIEW_MAX = 40;
const PREVIEW_MAX_BYTES = 1_500_000;

let cached: IDBDatabase | null = null;
let opening: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (cached) return Promise.resolve(cached);
  if (opening) return opening;
  opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onclose = () => {
        cached = null;
      };
      db.onversionchange = () => {
        db.close();
        cached = null;
      };
      cached = db;
      opening = null;
      resolve(db);
    };
    request.onerror = () => {
      opening = null;
      reject(request.error);
    };
  });
  return opening;
}

function isQuotaError(err: unknown) {
  if (!err || typeof err !== "object") return false;
  const rec = err as { name?: string; code?: number };
  return rec.name === "QuotaExceededError" || rec.code === 22;
}

async function keysOf(store: IDBObjectStore): Promise<IDBValidKey[]> {
  return new Promise((resolve, reject) => {
    const req = store.getAllKeys();
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
  });
}

async function evictPreviewKeys(keep?: string) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const req = store.getAllKeys();
    req.onsuccess = () => {
      for (const key of req.result ?? []) {
        const id = String(key);
        if (id.startsWith(PREVIEW_PREFIX) && id !== keep) store.delete(key);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function trimPreview(max = PREVIEW_MAX) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    void keysOf(store).then((all) => {
      const preview = all.map(String).filter((id) => id.startsWith(PREVIEW_PREFIX));
      const extra = preview.length - max;
      for (let i = 0; i < extra; i += 1) store.delete(preview[i]!);
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function storageEstimate(): Promise<{ usage: number; quota: number }> {
  try {
    const est = await navigator.storage?.estimate?.();
    return { usage: est?.usage ?? 0, quota: est?.quota ?? 0 };
  } catch {
    return { usage: 0, quota: 0 };
  }
}

export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (typeof navigator.storage.persisted === "function" && (await navigator.storage.persisted())) {
      return true;
    }
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/** persist() is more likely to succeed after a click/key. */
export function persistStorageOnGesture() {
  if (typeof window === "undefined") return;
  const run = () => {
    window.removeEventListener("pointerdown", run, true);
    window.removeEventListener("keydown", run, true);
    void requestPersistentStorage();
  };
  window.addEventListener("pointerdown", run, true);
  window.addEventListener("keydown", run, true);
}

export async function idbPut(id: string, blob: Blob): Promise<void> {
  await idbPutMany([{ id, blob }]);
}

export async function idbPutPreview(fontId: string, blob: Blob): Promise<void> {
  if (blob.size > PREVIEW_MAX_BYTES) return;
  const { usage, quota } = await storageEstimate();
  if (quota && usage + blob.size > quota * 0.9) {
    await evictPreviewKeys();
  }
  try {
    await idbPut(`${PREVIEW_PREFIX}${fontId}`, blob);
    void trimPreview();
  } catch (err) {
    if (!isQuotaError(err)) return;
    await evictPreviewKeys();
    try {
      await idbPut(`${PREVIEW_PREFIX}${fontId}`, blob);
    } catch {
      /* give up — preview still works from network this session */
    }
  }
}

export function previewCacheId(id: string) {
  return `${PREVIEW_PREFIX}${id}`;
}

export async function idbPutMany(entries: { id: string; blob: Blob }[]): Promise<void> {
  if (!entries.length) return;
  const db = await openDb();
  const write = () =>
    new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      for (const { id, blob } of entries) store.put(blob, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  try {
    await write();
  } catch (err) {
    if (!isQuotaError(err)) throw err;
    await evictPreviewKeys();
    await write();
  }
}

export async function idbGet(id: string): Promise<Blob | undefined> {
  const db = await openDb();
  return new Promise<Blob | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).get(id);
    request.onsuccess = () => resolve(request.result as Blob | undefined);
    request.onerror = () => reject(request.error);
  });
}

export async function idbDelete(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.objectStore(STORE).delete(`${PREVIEW_PREFIX}${id}`);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
