import type { StateStorage } from "zustand/middleware";

type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface PersistStorageOptions {
  /** Backing store; `null` when unavailable (SSR). */
  storage: () => KeyValueStorage | null;
  /** Writes before this returns true are dropped (unhydrated defaults). */
  canWrite: () => boolean;
  /** Called when the backing store rejects a write (quota, blocked storage). */
  onWriteError: (err: unknown) => void;
  /** Debounce for coalescing writes. */
  delayMs?: number;
}

/** Debounced localStorage adapter for zustand persist. A failed write is reported, never thrown from the timer. */
export function createPersistStorage(opts: PersistStorageOptions): StateStorage {
  const delay = opts.delayMs ?? 400;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last: { name: string; value: string } | null = null;
  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (!last) return;
    const { name, value } = last;
    last = null;
    try {
      opts.storage()?.setItem(name, value);
    } catch (err) {
      // The next state change writes the full slice again, so it retries on its own.
      opts.onWriteError(err);
    }
  };
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
  }
  return {
    getItem: (name) => {
      flush();
      return opts.storage()?.getItem(name) ?? null;
    },
    setItem: (name, value) => {
      if (!opts.canWrite()) return;
      last = { name, value };
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, delay);
    },
    removeItem: (name) => {
      last = null;
      if (timer) clearTimeout(timer);
      opts.storage()?.removeItem(name);
    },
  };
}

function errorName(err: unknown): string {
  return err && typeof err === "object" && "name" in err ? String((err as { name: unknown }).name) : "";
}

/** User-facing copy for a failed save. */
export function storageErrorMessage(err: unknown): { title: string; description: string } {
  const name = errorName(err);
  if (/quota/i.test(name) || name === "NS_ERROR_DOM_QUOTA_REACHED") {
    return {
      title: "Couldn't save your library",
      description: "Browser storage is full. Free some space for this site, then make the change again.",
    };
  }
  if (name === "SecurityError") {
    return {
      title: "Couldn't save your library",
      description: "This browser blocks storage for this site (private mode or a privacy setting). Changes last only until you close the tab.",
    };
  }
  return {
    title: "Couldn't save your library",
    description: "The browser refused the write. Your last change may not be saved.",
  };
}
