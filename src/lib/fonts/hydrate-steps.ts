export type HydrateStep = "catalog" | "library";

export interface HydratePersistedStoreOptions {
  /** Cached Google catalog (IndexedDB). A failure only costs the cache. */
  loadCatalog: () => Promise<unknown>;
  /** `useFontStore.persist.rehydrate()` — zustand resolves even when the load fails. */
  rehydrate: () => Promise<void> | void;
  /** `useFontStore.persist.hasHydrated()` — false after a failed load. */
  hasHydrated: () => boolean;
  cancelled: () => boolean;
  report: (step: HydrateStep, err: unknown) => void;
  /** Extra rehydrate attempts after the first. */
  retries?: number;
  retryDelayMs?: number;
}

/**
 * Startup load of the saved library. Retries a failed rehydrate (zustand
 * swallows the error and leaves hasHydrated() false) and returns "failed" when
 * it keeps failing, so the caller can keep writes blocked and tell the user
 * instead of saving defaults over the library.
 */
export async function hydratePersistedStore(
  opts: HydratePersistedStoreOptions,
): Promise<"ok" | "failed" | "cancelled"> {
  try {
    await opts.loadCatalog();
  } catch (err) {
    opts.report("catalog", err);
  }
  if (opts.cancelled()) return "cancelled";
  const attempts = 1 + Math.max(0, opts.retries ?? 1);
  let lastErr: unknown = new Error("saved library did not load");
  for (let i = 0; i < attempts; i += 1) {
    if (i > 0 && opts.retryDelayMs !== 0) {
      await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 250));
    }
    try {
      await opts.rehydrate();
    } catch (err) {
      lastErr = err;
    }
    if (opts.cancelled()) return "cancelled";
    if (opts.hasHydrated()) return "ok";
  }
  opts.report("library", lastErr);
  return "failed";
}
