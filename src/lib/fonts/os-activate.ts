import { toast } from "sonner";
import { inDesktopShell } from "@/lib/desktop/open-fonts";
import { isFontsourceOnly, isGoogleCatalog } from "./catalog";
import { firstSettledAllowlistedFamily } from "./gdi-incapable";
import { idbGet } from "./idb";
import type { FontRecord } from "./types";

/** Progress owner — download vs on-disk register vs remove must not share one sticky bar. */
export type ProgressOwner = "idle" | "download" | "register" | "remove";

export type DownloadJobState = {
  running: boolean;
  paused: boolean;
  mode: ProgressOwner;
  /** Who owns done/total/current — cancel/finish of another owner must not leave Registering… */
  owner: ProgressOwner;
  done: number;
  total: number;
  failed: number;
  skipped: number;
  current: string;
  failedNames: string[];
  failedDetails: string[];
  settledNames?: string[];
};

const EMPTY: DownloadJobState = {
  running: false,
  paused: false,
  mode: "idle",
  owner: "idle",
  done: 0,
  total: 0,
  failed: 0,
  skipped: 0,
  current: "",
  failedNames: [],
  failedDetails: [],
  settledNames: [],
};

let job: DownloadJobState = { ...EMPTY };
const listeners = new Set<() => void>();

/** Begin a progress-owned job. Never steal another owner's sticky current/totals. */
function beginOwnedJob(
  owner: Exclude<ProgressOwner, "idle">,
  patch: Partial<DownloadJobState> & { total: number; current?: string },
) {
  const sameOwnerBusy = (job.running || job.paused) && job.owner === owner;
  if ((job.running || job.paused) && job.owner !== owner && job.owner !== "idle") {
    // Another owner is active — do not overwrite their bar (split owners).
    return false;
  }
  // 1.0.206k: download failures must not gate Deactivate Cancel (stale lastFailedNames).
  if (owner === "remove") lastFailedNames = [];
  job = {
    running: true,
    paused: false,
    mode: owner,
    owner,
    done: sameOwnerBusy ? job.done : 0,
    total: sameOwnerBusy ? Math.max(job.total, patch.total) : patch.total,
    failed: sameOwnerBusy ? job.failed : 0,
    skipped: sameOwnerBusy ? job.skipped : 0,
    current: patch.current ?? "",
    failedNames: sameOwnerBusy ? job.failedNames : [],
    failedDetails: sameOwnerBusy ? job.failedDetails : [],
    settledNames: sameOwnerBusy ? (job.settledNames ?? []) : [],
  };
  markJobClock(true, false);
  emit();
  return true;
}

function finishOwnedJob(owner: ProgressOwner, keepSettled = false) {
  if (job.owner !== owner && job.owner !== "idle" && job.mode !== owner) return;
  const settled = keepSettled ? (job.settledNames ?? []) : [];
  job = {
    ...EMPTY,
    settledNames: settled,
    // settled-idle Done chrome when names remain
    ...(settled.length ? { current: "", mode: "idle" as const, owner: "idle" as const } : {}),
  };
  resetJobClock();
  emit();
}



let clockStarted = 0;
let clockPausedAt = 0;
let clockPausedMs = 0;

function resetJobClock() {
  clockStarted = 0;
  clockPausedAt = 0;
  clockPausedMs = 0;
}

function markJobClock(running: boolean, paused: boolean) {
  const now = Date.now();
  if (!running && !paused) {
    resetJobClock();
    return;
  }
  if (!clockStarted) clockStarted = now;
  if (paused) {
    if (!clockPausedAt) clockPausedAt = now;
    return;
  }
  if (clockPausedAt) {
    clockPausedMs += now - clockPausedAt;
    clockPausedAt = 0;
  }
}

/** Active elapsed ms for ETA — paused time is excluded so Resume does not look like a restart. */
export function getJobClock(): { activeMs: number } {
  if (!clockStarted) return { activeMs: 0 };
  const extra = clockPausedAt ? Date.now() - clockPausedAt : 0;
  return { activeMs: Math.max(0, Date.now() - clockStarted - clockPausedMs - extra) };
}

function notifyDownloadResult(
  done: number,
  failed: number,
  names: string[],
  details: string[],
  settledNames: string[] = [],
) {
  lastFailedNames = names.slice();
  if (settledNames.length) {
    void import("./store").then(({ useFontStore }) => {
      useFontStore.getState().addSettledFamilies(settledNames);
    });
  }
  if (failed > 0 && names.length) {
    const preview = (details.length ? details : names).slice(0, 4).join("; ");
    const extra = names.length > 4 ? ` +${names.length - 4} more` : "";
    toast.error(
      `${names.length} typeface${names.length === 1 ? "" : "s"} failed — tap Retry`,
      {
        description: `${preview}${extra}. Tried jsDelivr + unpkg with cache-bust. Close Word/Adobe if locked, or Open folder and delete then Retry.`,
        duration: 24_000,
        action: {
          label: "Open folder",
          onClick: () => void openActivatedFolder(),
        },
      },
    );
    return;
  }
  if (done > 0 || settledNames.length) {
    const settled = settledNames.length;
    void import("./store").then(({ useFontStore }) => {
      const { googleFonts, activated, diskFamilies, settledFamilies } = useFontStore.getState();
      const gN = googleFonts.filter((f) => f.catalog !== "other").length;
      const fsN = googleFonts.filter((f) => f.catalog === "other").length;
      // 1.0.206h: Live = store activated.length only (never mushy Math.max(skipped, done-failed-settled)).
      const liveCount = activated.length;
      const settledN = Math.max(settled, settledFamilies.length);
      const title = `Live ${liveCount.toLocaleString()} · Settled ${settledN.toLocaleString()} · Google ${gN.toLocaleString()} · Fontsource ${fsN.toLocaleString()} · Disk ${diskFamilies.length.toLocaleString()}`;
      // Prefer hard/soft settle-capable name so toast preview cannot hard-only-lie.
      const allowlisted = firstSettledAllowlistedFamily(settledNames);
      const settledPreview = allowlisted
        ? [allowlisted, ...settledNames.filter((n) => n.toLowerCase() !== allowlisted.toLowerCase())]
            .slice(0, 3)
            .join(", ")
        : settledNames.slice(0, 3).join(", ");
      // 1.0.188: no Try Fontsource download for allowlisted Settled — calm Open folder only.
      const chrome = settled > 0 ? toast.message : toast.success;
      chrome(title, {
        description: settled
          ? `${settledPreview || "Settled faces"} on disk · Windows won’t load for apps this session. Not Activated.`
          : "Files: Documents → Font Manager → FamilyName. Intact files were not fetched again.",
        duration: settled ? 16_000 : 8_000,
        action: {
          label: "Open folder",
          onClick: () => void openActivatedFolder(),
        },
      });
    });
  }
}

export type FontsourceOfferResult = {
  family: string;
  added: number;
  settled: boolean;
  message: string;
};

/** 1.0.188: no-op Settled info — Rust no longer downloads Fontsource for allowlist. */
export async function tryFontsourceGdiOffer(family: string): Promise<FontsourceOfferResult | null> {
  if (!(await inDesktopShell())) return null;
  try {
    const r = await tauriInvoke<FontsourceOfferResult>("try_fontsource_gdi_offer", { family });
    if (!r) return null;
    // Activated only if Add>0 (should not happen — offer does not fetch). Keep honesty.
    if (r.added > 0) {
      const { useFontStore } = await import("./store");
      await commitReadyFamilies([r.family]);
      useFontStore.getState().setSettledFamilies(
        useFontStore.getState().settledFamilies.filter((n) => n.toLowerCase() !== family.toLowerCase()),
      );
      toast.success(`${r.family} Activated`, { description: r.message });
    } else {
      const { useFontStore } = await import("./store");
      useFontStore.getState().addSettledFamilies([r.family]);
      toast.message(`Settled — ${r.family}`, {
        description: r.message || "On disk · Windows won’t load (not Activated). Fontsource download skipped.",
        duration: 14_000,
      });
    }
    return r;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err ?? "offer failed");
    toast.message("Settled", { description: msg });
    return null;
  }
}

let lastFailedNames: string[] = [];
let lastReadyCount = 0;

/** Never lock the document — DownloadBar is non-blocking. Keep clear as a defensive no-op. */
function unlockUi() {
  if (typeof document === "undefined") return;
  document.body.style.pointerEvents = "";
  document.documentElement.style.pointerEvents = "";
}

const READY_FLUSH_MS = 450;
const PROGRESS_EMIT_MS = 300;
let readyCumulative: string[] = [];
let readyFlushTimer = 0;
let lastFlushedReadyLen = 0;
let progressEmitTimer = 0;
let lastProgressEmit = 0;
let lastPayloadSig = "";

function flushReadyFamilies(): Promise<void> {
  if (readyFlushTimer) {
    window.clearTimeout(readyFlushTimer);
    readyFlushTimer = 0;
  }
  const names = readyCumulative;
  if (!names.length) return Promise.resolve();
  const delta = names.slice(lastFlushedReadyLen);
  lastFlushedReadyLen = names.length;
  if (!delta.length) return Promise.resolve();
  return commitReadyFamilies(delta);
}

function queueReadyFamilies(cumulative: string[]) {
  if (!cumulative.length) return;
  readyCumulative = cumulative;
  if (readyFlushTimer) return;
  readyFlushTimer = window.setTimeout(() => {
    readyFlushTimer = 0;
    void flushReadyFamilies();
  }, READY_FLUSH_MS);
}

function resetReadyBatching() {
  if (readyFlushTimer) {
    window.clearTimeout(readyFlushTimer);
    readyFlushTimer = 0;
  }
  readyCumulative = [];
  lastFlushedReadyLen = 0;
  lastReadyCount = 0;
  lastPayloadSig = "";
}

function commitReadyFamilies(names: string[]): Promise<void> {
  if (!names.length) return Promise.resolve();
  return import("./store").then(({ useFontStore }) => {
    const { googleFonts, localFonts, markLiveActivated, pendingSet, activatedSet } =
      useFontStore.getState();
    // Lane maps — Google catalog vs Fontsource exclusive vs local must stay separate.
    const googleByFamily = new Map<string, string>();
    const fontsourceByFamily = new Map<string, string>();
    const localByFamily = new Map<string, string>();
    for (const font of googleFonts) {
      const key = font.family.toLowerCase();
      if (font.catalog === "other") fontsourceByFamily.set(key, font.id);
      else googleByFamily.set(key, font.id);
    }
    for (const font of localFonts) localByFamily.set(font.family.toLowerCase(), font.id);
    const ids: string[] = [];
    const seenFamily = new Set<string>();
    for (const name of names) {
      const key = name.trim().toLowerCase();
      if (!key || seenFamily.has(key)) continue;
      const gId = googleByFamily.get(key);
      const fsId = fontsourceByFamily.get(key);
      const localId = localByFamily.get(key);
      // Prefer the id we queued (pending), then Google, Fontsource, local — one Live per family.
      let pick: string | undefined;
      if (gId && pendingSet.has(gId)) pick = gId;
      else if (fsId && pendingSet.has(fsId)) pick = fsId;
      else if (localId && pendingSet.has(localId)) pick = localId;
      else if (gId && activatedSet.has(gId)) pick = gId;
      else if (fsId && activatedSet.has(fsId)) pick = fsId;
      else if (localId && activatedSet.has(localId)) pick = localId;
      else if (gId) pick = gId;
      else if (fsId) pick = fsId;
      else if (localId) pick = localId;
      if (pick) {
        seenFamily.add(key);
        ids.push(pick);
      }
    }
    if (ids.length) markLiveActivated(ids);
    useFontStore.getState().addDiskFamilies(names);
  });
}

/** Flush ready marks (await markLiveActivated) then clear pending — never clear first.
 * Pass familyNames to scope the clear (mixed Activate All: google on-disk finish must not wipe local install-queue pending).
 * With no names, clear pending Google fonts only — never a nuclear clearPendingActivate(). */
async function finalizeReadyAndClearPending(familyNames?: string[]) {
  await flushReadyFamilies();
  resetReadyBatching();
  if (familyNames?.length) {
    await clearPendingForFamilyNames(familyNames);
    return;
  }
  const { useFontStore } = await import("./store");
  const { googleFonts, clearPendingActivate, pendingSet } = useFontStore.getState();
  const ids = googleFonts.filter((font) => pendingSet.has(font.id)).map((font) => font.id);
  if (ids.length) clearPendingActivate(ids);
}

/** Direct callers (restore/resume) commit immediately; progress path uses queueReadyFamilies. */
function applyReadyFamilies(names: string[]) {
  if (!names.length) return;
  if (pollTimer || job.running || job.paused) queueReadyFamilies(names);
  else void commitReadyFamilies(names);
}


/** Drop pendingActivate for family names that did not make the registered/live list. */
async function clearPendingForFamilyNames(names: string[]) {
  if (!names.length) return;
  const { useFontStore } = await import("./store");
  const { googleFonts, localFonts, clearPendingActivate, pendingSet } = useFontStore.getState();
  const drop = new Set(names.map((n) => n.trim().toLowerCase()));
  const ids = [...googleFonts, ...localFonts]
    .filter((font) => drop.has(font.family.toLowerCase()) && pendingSet.has(font.id))
    .map((font) => font.id);
  if (ids.length) clearPendingActivate(ids);
}


const MAX_RETRY_ATTEMPTS = 3;
const retryAttempts = new Map<string, number>();

export async function retryFailedDownloads(): Promise<void> {
  if (job.running && job.mode === "download") {
    startGooglePoll("download");
    toast.message("Download already running", {
      description: "Cancel first if you need to stop, then Retry remaining failures.",
    });
    return;
  }
  const names = (lastFailedNames.length ? lastFailedNames : job.failedNames).slice();
  if (!names.length) {
    toast.message("Nothing to retry", {
      description: "No failed families in this session. Delete files in Documents, then Activate again.",
      action: { label: "Open folder", onClick: () => void openActivatedFolder() },
    });
    return;
  }
  const capped: string[] = [];
  const exhausted: string[] = [];
  for (const name of names) {
    const key = name.trim().toLowerCase();
    if ((retryAttempts.get(key) ?? 0) >= MAX_RETRY_ATTEMPTS) exhausted.push(name);
    else capped.push(name);
  }
  if (!capped.length) {
    toast.error("Retry limit reached — stopped", {
      description: `${exhausted.slice(0, 6).join(", ")}${exhausted.length > 6 ? "…" : ""}. Close Word/Adobe, Explorer-delete the family folder (empty = missing), then Activate again.`,
      duration: 28_000,
      action: { label: "Open folder", onClick: () => void openActivatedFolder() },
    });
    return;
  }
  for (const name of capped) {
    const key = name.trim().toLowerCase();
    retryAttempts.set(key, (retryAttempts.get(key) ?? 0) + 1);
  }
  try {
    const added = await tauriInvoke<number>("retry_google_downloads", { families: capped });
    if (added) {
      lastFailedNames = exhausted.slice();
      toast.message("Retrying — re-stage + register (no library wipe)", {
        description: `${added.toLocaleString()} ${added === 1 ? "family" : "families"} (attempt capped at ${MAX_RETRY_ATTEMPTS}). Intact files re-Add; missing faces download without wiping the folder.`,
      });
      startGooglePoll("download");
      return;
    }
    toast.error("Retry did not queue — not a silent success", {
      description:
        capped.slice(0, 6).join(", ") +
        (capped.length > 6 ? "…" : "") +
        ". Folder may still be locked, or already queued. Open Documents, delete the family folder if empty/corrupt, then Retry.",
      duration: 24_000,
      action: { label: "Open folder", onClick: () => void openActivatedFolder() },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err ?? "retry failed");
    toast.error("Retry failed", {
      description: msg,
      duration: 24_000,
      action: { label: "Open folder", onClick: () => void openActivatedFolder() },
    });
  }
}

export async function skipFailedDownloads(): Promise<void> {
  const names = (lastFailedNames.length ? lastFailedNames : job.failedNames).slice();
  if (!names.length) return;
  await tauriInvoke<number>("skip_google_failures", { families: names }).catch(() => 0);
  lastFailedNames = [];
  expectKind = "";
  job = { ...EMPTY };
  emit();
  void import("./store").then(({ useFontStore }) => {
    const { googleFonts, localFonts, clearPendingActivate } = useFontStore.getState();
    const drop = new Set(names.map((n) => n.trim().toLowerCase()));
    const ids = [...googleFonts, ...localFonts]
      .filter((font) => drop.has(font.family.toLowerCase()))
      .map((font) => font.id);
    if (ids.length) clearPendingActivate(ids);
  });
  toast.message(`Skipped ${names.length.toLocaleString()} — not downloaded`, {
    description: "They stay in the catalog. Activate one later, or Retry.",
  });
}

export async function restoreSessionFromDisk(families: string[]): Promise<{
  ready: string[];
  missing: string[];
  onDisk: string[];
}> {
  const empty = { ready: [] as string[], missing: [] as string[], onDisk: [] as string[] };
  if (!(await inDesktopShell())) return empty;
  void bindDownloadEvents();
  const plan = await tauriInvoke<{
    ready: string[];
    missing: string[];
    on_disk?: string[];
  }>("plan_google_activation", { families }).catch(() => null);
  const onDisk = plan?.on_disk?.length ? plan.on_disk : (plan?.ready ?? []);
  const readyNames = plan?.ready ?? [];
  if (!readyNames.length) {
    return { ready: [], missing: plan?.missing ?? [], onDisk };
  }
  // Worker + poll — invoke no longer awaits GDI (1.0.165). Catch/start-fail → [].
  const ready = await activateOnDiskAndWait(readyNames);
  if (ready?.length) applyReadyFamilies(ready);
  return { ready: ready ?? [], missing: plan?.missing ?? [], onDisk };
}

export async function resumeGoogleFamilies(families: string[]): Promise<void> {
  if (!families.length) return;
  if (!(await inDesktopShell())) return;
  void bindDownloadEvents();
  const plan = await tauriInvoke<{ ready: string[]; missing: string[] }>("plan_google_activation", {
    families,
  }).catch(() => null);
  const missing = plan?.missing ?? families;
  if (plan?.ready.length) {
    // Same honesty — start-fail / timeout → [] (no false live).
    const ready = await activateOnDiskAndWait(plan.ready);
    if (ready?.length) applyReadyFamilies(ready);
  }
  if (!missing.length) return;
  // 1.0.205/206: parallel intents (same as Activate). Missing store row → catalog
  // "other" / disk stamp / planned — never blind "google" (wrong-pipes Fontsource).
  const { useFontStore } = await import("./store");
  const { GOOGLE_FONTS } = await import("./catalog");
  const { googleFonts, localFonts } = useFontStore.getState();
  const byFamily = new Map<string, FontRecord>();
  for (const font of [...googleFonts, ...localFonts, ...GOOGLE_FONTS]) {
    const key = font.family.trim().toLowerCase();
    if (!byFamily.has(key)) byFamily.set(key, font);
  }
  const resumeFamilies: string[] = [];
  const intents: Array<"google" | "fontsource" | "local"> = [];
  for (const name of missing) {
    const font = byFamily.get(name.trim().toLowerCase());
    if (font) {
      resumeFamilies.push(name);
      intents.push(fetchIntentFor(font));
      continue;
    }
    const resolved = await tauriInvoke<string | null>("resolve_family_fetch_intent", {
      family: name,
    }).catch(() => null);
    if (resolved === "google" || resolved === "fontsource" || resolved === "local") {
      resumeFamilies.push(name);
      intents.push(resolved);
      continue;
    }
    // Ambiguous — skip rather than wrong-pipe Fontsource vs Google.
  }
  if (!resumeFamilies.length) return;
  const added = await tauriInvoke<number>("start_google_downloads", {
    families: resumeFamilies,
    intents,
  }).catch(() => 0);
  if (added) startGooglePoll("download");
}

export async function rememberSessionFamilies(families: string[]): Promise<void> {
  if (!(await inDesktopShell())) return;
  try {
    await tauriInvoke("set_session_families", { families });
  } catch {
    /* older installer */
  }
}

export async function listSessionFamilies(): Promise<string[]> {
  if (!(await inDesktopShell())) return [];
  try {
    return (await tauriInvoke<string[]>("session_families")) ?? [];
  } catch {
    return [];
  }
}

/** Poll session_begin GDI restore. Live list is this-process Adds, not last-session sidecar.
 * 1.0.190: onReady fires as session_boot.ready grows — do not wait for boot.done (~2099). */
export async function waitSessionBoot(
  timeoutMs = 180_000,
  onReady?: (ready: string[], done: boolean) => void,
): Promise<{ done: boolean; ready: string[] }> {
  if (!(await inDesktopShell())) {
    onReady?.([], true);
    return { done: true, ready: [] };
  }
  const start = Date.now();
  let startedPoll = false;
  let lastReadyLen = -1;
  let latest: string[] = [];
  while (Date.now() - start < timeoutMs) {
    try {
      const s = await tauriInvoke<{ done?: boolean; running?: boolean; ready?: string[] }>(
        "session_boot_state",
      );
      if (s?.running && !startedPoll) {
        startGooglePoll("download");
        startedPoll = true;
      }
      latest = (s?.ready ?? []).slice();
      const done = Boolean(s?.done);
      if (latest.length !== lastReadyLen || done) {
        lastReadyLen = latest.length;
        onReady?.(latest, done);
      }
      if (done) return { done: true, ready: latest };
    } catch {
      onReady?.([], false);
      return { done: false, ready: [] };
    }
    // Slightly slower than 150ms — pairs with Rust emit throttle; keeps webview interactive.
    await new Promise((r) => window.setTimeout(r, 250));
  }
  onReady?.(latest, false);
  return { done: false, ready: latest };
}

export type DiskFamilyInfo = {
  name: string;
  bytes: number;
  files: number;
  corrupt?: number;
  incomplete?: boolean;
  /** Known GDI-incapable + intact — calm Settled (not Incomplete, not Activated). */
  settled?: boolean;
  has_complete?: boolean;
  has_variable?: boolean;
  missing_variable?: boolean;
  undersized?: boolean;
};

export async function managedDocumentsRoot(): Promise<string | null> {
  if (!(await inDesktopShell())) return null;
  try {
    return (await tauriInvoke<string>("activation_folder")) ?? null;
  } catch {
    return null;
  }
}

export async function scanDiskFamilies(): Promise<DiskFamilyInfo[]> {
  if (!(await inDesktopShell())) return [];
  try {
    return (await tauriInvoke<DiskFamilyInfo[]>("scan_disk_families")) ?? [];
  } catch {
    return [];
  }
}


export type SyncDocsResult = {
  familiesSeen: number;
  familiesPurged: number;
  staticsDeleted: number;
  locked: number;
  cancelled: boolean;
};

/** 1.0.206u: Refresh Documents — purge redundant statics when intact VF present. */
export async function syncDocumentsVfPolicy(): Promise<SyncDocsResult | null> {
  if (!(await inDesktopShell())) return null;
  if (!beginOwnedJob("download", { total: 1, current: "Scanning Documents…" })) {
    toast.message("Busy", {
      description: "Activate/download already running — Cancel or wait, then Refresh again.",
    });
    return null;
  }
  docsVfSyncActive = true;
  docsVfSyncCancelPending = false;
  docsVfSyncCancelToasted = false;
  startGooglePoll("download");
  try {
    const raw = await tauriInvoke<{
      familiesSeen?: number;
      families_seen?: number;
      familiesPurged?: number;
      families_purged?: number;
      staticsDeleted?: number;
      statics_deleted?: number;
      locked?: number;
      cancelled?: boolean;
    }>("sync_documents_vf_policy");
    if (!raw) return null;
    const result = {
      familiesSeen: raw.familiesSeen ?? raw.families_seen ?? 0,
      familiesPurged: raw.familiesPurged ?? raw.families_purged ?? 0,
      staticsDeleted: raw.staticsDeleted ?? raw.statics_deleted ?? 0,
      locked: raw.locked ?? 0,
      cancelled: Boolean(raw.cancelled),
    };
    // Success path: drop sticky cancel ownership. Cancelled: leave toasted/pending for caller.
    if (!result.cancelled) {
      docsVfSyncCancelPending = false;
      docsVfSyncCancelToasted = false;
    }
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err ?? "sync failed");
    toast.error("Could not refresh Documents", { description: msg });
    docsVfSyncCancelPending = false;
    docsVfSyncCancelToasted = false;
    return null;
  } finally {
    // Clear active only — sticky pending/toasted must outlive this so cancel toast stays owned.
    docsVfSyncActive = false;
    finishOwnedJob("download");
  }
}

/** Keep library diskFamilies in sync with Documents\Font Manager (incl. Activated/Library). */
export async function syncManagedDocumentsRoot(): Promise<DiskFamilyInfo[]> {
  const rows = await scanDiskFamilies();
  if (!rows.length) return rows;
  const names = rows.map((r) => r.name);
  void import("./store").then(({ useFontStore }) => {
    const store = useFontStore.getState();
    store.setDiskFamilies(names);
    // Variable badge/facet = intact on-disk *-variable-* only (never catalog alone).
    store.applyDiskStatusHonesty(rows);
  });
  void import("./loader").then(({ noteDiskFamilies }) => {
    noteDiskFamilies(names);
  });
  return rows;
}

export async function pruneUnknownFolders(keep: string[]): Promise<number> {
  if (!(await inDesktopShell())) return 0;
  try {
    return (await tauriInvoke<number>("prune_unknown_folders", { keep })) ?? 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err ?? "prune failed");
    toast.error("Could not prune Documents folders", { description: msg });
    return 0;
  }
}

export type RepairResult = {
  queued: number;
  healed: number;
  locked: number;
  write_failed: number;
  var_ensured: number;
};

function toastNameHealLocked(locked: number, healed = 0) {
  const faces = `${locked.toLocaleString()} face${locked === 1 ? "" : "s"} locked`;
  const healedBit =
    healed > 0 ? `Healed ${healed.toLocaleString()}; ${locked.toLocaleString()} locked skipped. ` : "";
  toast.error(`${faces} — deactivate fonts or quit Adobe/Word, then Repair`, {
    description: `${healedBit}Illustrator, fontdrvhost, or another app is holding mashed TTFs. Quit those apps (or Deactivate), then Repair again.`,
    duration: 24_000,
    action: { label: "Open folder", onClick: () => void openActivatedFolder() },
  });
}

function toastSessionRecoveryLocked(locked: number, attempted = 0) {
  const faces = `${locked.toLocaleString()} face${locked === 1 ? "" : "s"} still write-locked`;
  const attemptedBit =
    attempted > 0 ? ` after Remove (attempted ${attempted.toLocaleString()})` : "";
  toast.error(`Session recovery: ${faces}`, {
    description: `Prior quit left GDI maps held by fontdrvhost/Adobe${attemptedBit}. Deactivate-all or reboot, then Repair — Heal cannot rewrite locked TTFs.`,
    duration: 28_000,
    action: { label: "Open folder", onClick: () => void openActivatedFolder() },
  });
}

function toastGdiPressure(objects: number, quota: number, message?: string) {
  const n = Math.max(0, objects);
  const cap = quota > 0 ? quota : 10_000;
  toast.message(`GDI objects ${n.toLocaleString()} / ${cap.toLocaleString()}`, {
    id: "gdi-pressure",
    description:
      message ||
      "Windows per-process quota is 10,000 GDI objects (HFONT/HDC), not one per activated family. Deactivate some typefaces if this window hitchs. Live marks stay honest.",
    duration: 16_000,
  });
}

function toastFontCacheHeld(locked: number, accessDenied = false) {
  const n = Math.max(locked, accessDenied ? 1 : 0);
  toast.error(`Font Cache still holding ${n.toLocaleString()} files — retry as admin or reboot`, {
    description: accessDenied
      ? "Windows Font Cache service restart needs elevation. Run Font Manager as admin once after Deactivate, or reboot so Documents TTFs unlock."
      : "svchost (LOCAL SERVICE / Font Cache) is still holding Documents TTFs after Deactivate. Retry Deactivate as admin, or reboot.",
    duration: 28_000,
    action: { label: "Open folder", onClick: () => void openActivatedFolder() },
  });
}

export async function repairIncompleteFamilies(families: string[] = []): Promise<number> {
  if (!(await inDesktopShell())) return 0;
  void bindDownloadEvents();
  try {
    const result =
      (await tauriInvoke<RepairResult>("repair_incomplete_families", { families })) ?? {
        queued: 0,
        healed: 0,
        locked: 0,
        write_failed: 0,
        var_ensured: 0,
      };
    const locked = (result.locked ?? 0) + (result.write_failed ?? 0);
    const healed = result.healed ?? 0;
    const queued = result.queued ?? 0;
    const varEnsured = result.var_ensured ?? 0;
    const work = queued + healed + varEnsured;

    if (locked > 0) {
      toastNameHealLocked(locked, healed);
    }
    if (queued > 0) {
      toast.message("Repairing incomplete families", {
        description: `${queued.toLocaleString()} ${queued === 1 ? "family" : "families"} — re-fetching missing faces.${
          healed ? ` Also healed ${healed.toLocaleString()} name${healed === 1 ? "" : "s"}.` : ""
        }`,
      });
      startGooglePoll("download");
    } else if (healed > 0 && locked === 0) {
      toast.success(
        `Healed ${healed.toLocaleString()} face name${healed === 1 ? "" : "s"}`,
        {
          description: varEnsured
            ? `Also ensured ${varEnsured.toLocaleString()} catalog variable face${varEnsured === 1 ? "" : "s"}.`
            : "Illustrator-friendly family/style split rewritten in place.",
        },
      );
    } else if (varEnsured > 0 && locked === 0) {
      toast.success(
        `Ensured ${varEnsured.toLocaleString()} variable face${varEnsured === 1 ? "" : "s"}`,
        { description: "Catalog vars added to complete folders." },
      );
    } else if (work === 0 && locked === 0) {
      toast.message("Nothing to repair", {
        description: "Every on-disk family has a .complete marker, or Documents is empty.",
      });
    }
    return work + locked;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err ?? "repair failed");
    toast.error("Repair failed", {
      description: msg,
      action: { label: "Open folder", onClick: () => void openActivatedFolder() },
    });
    return 0;
  }
}

function emit() {
  job = { ...job };
  listeners.forEach((fn) => fn());
}

/** Clear the progress bar only — store settledFamilies stay. Settled-idle Done / auto-hide. */
export function dismissDownloadBar() {
  job = { ...EMPTY };
  resetJobClock();
  emit();
}

export function getDownloadJob(): DownloadJobState {
  return job;
}

export function subscribeDownloadJob(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function yieldUi() {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

function slugFamily(family: string) {
  return family
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}


async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** Soft Settled Power Retry: clear Rust this-session Add=0 refuse so Add runs again (1.0.206f). */
export async function clearSessionGdiRefused(family: string): Promise<void> {
  const name = family.trim();
  if (!name) return;
  try {
    await tauriInvoke("clear_session_gdi_refused_family", { family: name });
  } catch {
    /* web preview / no Tauri */
  }
}

type OnDiskProgressSnap = {
  running: boolean;
  paused?: boolean;
  done: number;
  total: number;
  failed: number;
  current: string;
  failed_names?: string[];
  failed_details?: string[];
  ready_names?: string[];
  settled_names?: string[];
  skipped?: number;
  kind?: string;
};

/**
 * 1.0.165: activate_families_on_disk returns immediately (Ok([]) = accepted).
 * GDI register runs on a Rust worker; live marks come from progress ready_names.
 * Invoke throw/reject still means nothing started → [] (honesty).
 */
async function startActivateOnDisk(families: string[]): Promise<boolean> {
  if (!families.length) return false;
  void bindDownloadEvents();
  try {
    await tauriInvoke<string[]>("activate_families_on_disk", { families });
    return true;
  } catch {
    return false;
  }
}

/** Poll until on-disk register worker idles; return ready_names (pending-until-GDI). */
async function waitForOnDiskRegisterIdle(timeoutMs = 30 * 60_000): Promise<string[]> {
  const start = Date.now();
  let sawRunning = false;
  while (Date.now() - start < timeoutMs) {
    try {
      const p = await tauriInvoke<OnDiskProgressSnap>("google_download_progress");
      if (p.running || p.paused) sawRunning = true;
      applyPayload(p);
      if (sawRunning && !p.running && !p.paused) {
        return (p.ready_names ?? []).slice();
      }
      if (
        !p.running &&
        !p.paused &&
        p.kind === "download" &&
        p.total > 0 &&
        p.done + p.failed >= p.total &&
        ((p.ready_names?.length ?? 0) > 0 || (p.failed_names?.length ?? 0) > 0)
      ) {
        return (p.ready_names ?? []).slice();
      }
    } catch {
      /* ignore */
    }
    await new Promise<void>((r) => window.setTimeout(r, 200));
  }
  return [];
}

/** Start worker + wait for ready_names (restore / single-family / resume). */
async function activateOnDiskAndWait(families: string[]): Promise<string[]> {
  if (!families.length) return [];
  beginOwnedJob("register", { total: families.length, current: "Checking disk…" });
  startGooglePoll("register");
  const started = await startActivateOnDisk(families);
  if (!started) {
    finishOwnedJob("register");
    return [];
  }
  return waitForOnDiskRegisterIdle();
}


const installedCache = new Set<string>();

function cacheHas(family: string) {
  return installedCache.has(family.toLowerCase());
}

function safeSegment(name: string) {
  const t = name.replace(/[<>:"/\\|?*]/g, "-").replace(/[. ]+$/g, "").trim();
  return t || "font";
}

async function writeAndRegister(
  family: string,
  fileName: string,
  bytes: Uint8Array,
) {
  const fam = safeSegment(family);
  const file = safeSegment(fileName);
  const { mkdir, writeFile, exists, stat, BaseDirectory } = await import("@tauri-apps/plugin-fs");
  const relDir = `Font Manager/${fam}`;
  const relFile = `${relDir}/${file}`;
  await mkdir(relDir, { baseDir: BaseDirectory.Document, recursive: true });
  let skipWrite = false;
  try {
    if (await exists(relFile, { baseDir: BaseDirectory.Document })) {
      const info = await stat(relFile, { baseDir: BaseDirectory.Document });
      skipWrite = info.size === bytes.byteLength && info.size >= 1000;
    }
  } catch {
    skipWrite = false;
  }
  if (!skipWrite) {
    await writeFile(relFile, bytes, { baseDir: BaseDirectory.Document });
  }
  const { documentDir, join } = await import("@tauri-apps/api/path");
  const abs = await join(await documentDir(), "Font Manager", fam, file);
  await tauriInvoke("register_font_path", { path: abs });
  installedCache.add(family.toLowerCase());
}

async function fetchBytes(url: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.byteLength > 1000 ? buf : null;
  } catch {
    return null;
  }
}

function isCjkSubset(name: string) {
  const s = name.toLowerCase();
  return s.startsWith("chinese") || s === "japanese" || s === "korean" || s === "japanese-latin";
}

/** Prefer CJK / emoji script subsets when present; never treat latin-only as enough. */
async function fontsourceSubsets(slug: string): Promise<string[]> {
  try {
    const res = await fetch(`https://api.fontsource.org/v1/fonts/${slug}`);
    if (!res.ok) return ["latin"];
    const data = (await res.json()) as { subsets?: string[] };
    const subsets = Array.isArray(data.subsets) ? data.subsets.filter((s) => typeof s === "string") : [];
    const cjk = subsets.filter(isCjkSubset);
    if (cjk.length) return cjk;
    if (subsets.includes("emoji")) return ["emoji"];
    if (subsets.includes("latin")) return ["latin"];
    return subsets.slice(0, 4);
  } catch {
    return ["latin"];
  }
}

/** Build static ital,wght@0|1,w CSS2 axis (mirrors Rust static_weight_axis). */
function staticWeightAxis() {
  const pairs: string[] = [];
  for (const ital of [0, 1]) {
    for (const w of [100, 200, 300, 400, 500, 600, 700, 800, 900]) {
      pairs.push(`${ital},${w}`);
    }
  }
  return `ital,wght@${pairs.join(";")}`;
}

function parseCssTtfFaces(css: string): { style: string; weight: string; url: string }[] {
  const best = new Map<string, { rank: number; style: string; weight: string; url: string }>();
  for (const block of css.split("@font-face")) {
    const urlMatch = block.match(/url\((['"]?)(https:\/\/[^)'"]+?\.(?:ttf|otf))\1\)/i);
    if (!urlMatch || /\.woff/i.test(urlMatch[2])) continue;
    const style = (block.match(/font-style:\s*([^;]+)/i)?.[1] ?? "normal").trim().toLowerCase();
    const weight = (block.match(/font-weight:\s*([^;]+)/i)?.[1] ?? "400").trim().replace(/\s+/g, "-");
    const lower = block.toLowerCase();
    let rank = 1;
    if (/u\+4e00|chinese|japanese|korean/.test(lower)) rank = 3;
    else if (!/unicode-range/.test(block)) rank = 2;
    else if (/U\+0000/.test(block)) rank = 0;
    const key = `${style}|${weight}`;
    const prev = best.get(key);
    if (!prev || rank > prev.rank) best.set(key, { rank, style, weight, url: urlMatch[2] });
  }
  return [...best.values()]
    .sort((a, b) => a.style.localeCompare(b.style) || a.weight.localeCompare(b.weight))
    .slice(0, 24);
}

/** Google CSS2 desktop TTFs first (Mozilla UA). Discover richest axis listing, then fetch. */
async function googleCssTtfFiles(family: string, slug: string) {
  // Caller gates on isGoogleCatalog; still safe if mis-invoked for catalog:other.
  // Match Rust discover_richest_google_listing: static ital,wght@… then bare.
  // Skip variable 100..900 axes — they 400-sweep for some CJK (Chiron).
  const axes = [staticWeightAxis(), ""];
  let best: { style: string; weight: string; url: string }[] = [];
  let bestRank = -1;
  for (const axis of axes) {
    const param = family.replace(/ /g, "+");
    const href = axis
      ? `https://fonts.googleapis.com/css2?family=${param}:${axis}&display=swap`
      : `https://fonts.googleapis.com/css2?family=${param}&display=swap`;
    try {
      const res = await fetch(href, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) continue;
      const css = await res.text();
      if (css.length < 32 || !css.includes("@font-face")) continue;
      const listed = parseCssTtfFaces(css);
      if (!listed.length) continue;
      const rank = !axis ? 0 : axis.startsWith("ital,wght@") ? 3 : 1;
      if (listed.length > best.length || (listed.length === best.length && rank > bestRank)) {
        best = listed;
        bestRank = rank;
      }
      if (rank >= 3 && best.length >= 2) break;
    } catch {
      /* try next axis */
    }
  }
  const files: { fileName: string; data: Uint8Array }[] = [];
  // Cap concurrent browser downloads to avoid buffering many CJK faces at once.
  const queue = best.slice();
  const workers = Math.min(2, queue.length);
  async function worker() {
    while (queue.length) {
      const face = queue.shift();
      if (!face) return;
      const data = await fetchBytes(face.url);
      if (data) files.push({ fileName: `${slug}-${face.weight}-${face.style}.ttf`, data });
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return files;
}


async function fontsourceTtfFiles(font: FontRecord, slug: string) {
  const emoji = /emoji/i.test(font.family);
  const colorEmoji = slug === "noto-color-emoji" || /noto color emoji/i.test(font.family);
  const outlineEmoji = slug === "noto-emoji" || /^noto emoji$/i.test(font.family.trim());
  const softEmojiStubGate = colorEmoji || outlineEmoji;
  const weights = emoji
    ? [400]
    : Array.from(new Set(font.weights.length ? font.weights : [400])).sort((a, b) => a - b);
  const styles: Array<"normal" | "italic"> = emoji ? ["normal"] : font.italic ? ["normal", "italic"] : ["normal"];
  // Completeness P0: emoji = script subset / upstream color TTF — never force latin.
  const subsets = emoji ? (colorEmoji || outlineEmoji ? ["emoji"] : await fontsourceSubsets(slug)) : await fontsourceSubsets(slug);
  const files: { fileName: string; data: Uint8Array }[] = [];
  for (const subset of subsets) {
    for (const weight of weights) {
      for (const style of styles) {
        const urls = [
          "https://cdn.jsdelivr.net/fontsource/fonts/" + slug + "@latest/" + subset + "-" + weight + "-" + style + ".ttf",
          "https://cdn.jsdelivr.net/npm/@fontsource/" + slug + "/files/" + slug + "-" + subset + "-" + weight + "-" + style + ".ttf",
          "https://unpkg.com/@fontsource/" + slug + "/files/" + slug + "-" + subset + "-" + weight + "-" + style + ".ttf",
        ];
        if (colorEmoji && weight === 400 && style === "normal") {
          // Full upstream only — do not fall through to latin CDN stubs.
          urls.length = 0;
          urls.push(
            "https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@main/fonts/NotoColorEmoji.ttf",
            "https://github.com/googlefonts/noto-emoji/raw/refs/heads/main/fonts/NotoColorEmoji.ttf",
          );
        } else if (outlineEmoji && weight === 400 && style === "normal") {
          urls.length = 0;
          urls.push(
            "https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@main/fonts/NotoEmoji-Regular.ttf",
            "https://github.com/googlefonts/noto-emoji/raw/refs/heads/main/fonts/NotoEmoji-Regular.ttf",
          );
        }
        let data: Uint8Array | null = null;
        for (const url of urls) {
          data = await fetchBytes(url);
          // Soft emoji TTFs are large; reject obvious latin stubs (<256KB) — color + outline.
          if (data && softEmojiStubGate && data.byteLength < 256 * 1024) {
            data = null;
            continue;
          }
          if (data) break;
        }
        // First-face 404 on non-400 must not abort the whole family (variable-only still aborts on 400).
        if (!data && subset === subsets[0] && weight === 400 && style === "normal") {
          return files;
        }
        if (data) {
          const fileName = colorEmoji
            ? `${slug}.ttf`
            : slug + "-" + subset + "-" + weight + "-" + style + ".ttf";
          files.push({ fileName, data });
        }
      }
    }
  }
  return files;
}

/** Activate fetch intent: google | fontsource | local — hard separation, no cross-fill. */
export function fetchIntentFor(font: FontRecord): "google" | "fontsource" | "local" {
  if (font.source === "local") return "local";
  if (isFontsourceOnly(font)) return "fontsource";
  if (isGoogleCatalog(font)) return "google";
  return "local";
}

async function googleTtfFiles(font: FontRecord, _lean: boolean) {
  const slug = slugFamily(font.family);
  const intent = fetchIntentFor(font);
  // Google Activate = Google faces only (no Fontsource fill).
  if (intent === "google") {
    return isGoogleCatalog(font) ? await googleCssTtfFiles(font.family, slug) : [];
  }
  // Fontsource/other Activate = Fontsource only (no Google CSS2 / desktop fetch).
  if (intent === "fontsource") {
    return fontsourceTtfFiles(font, slug);
  }
  return [];
}

async function localFiles(font: FontRecord) {
  const blob = await idbGet(font.id);
  if (!blob) return [];
  const data = new Uint8Array(await blob.arrayBuffer());
  if (!data.byteLength) return [];
  return [{ fileName: font.fileName || `${slugFamily(font.family)}.ttf`, data }];
}

let batchId = 0;
let workers = 0;
const MAX_WORKERS = 2;
const installQueue: { font: FontRecord; lean: boolean }[] = [];
const removeQueue: FontRecord[] = [];
/** Bulk Deactivate batch — Off only after unload prefix (1.0.206j). Not all at spawn. */
let removeBatchIds: string[] = [];
let removeBatchFamilies: string[] = [];
const removeBatchConfirmed = new Set<string>();

function beginRemoveBatch(fonts: FontRecord[]) {
  removeBatchIds = fonts.map((f) => f.id);
  removeBatchFamilies = fonts.map((f) => f.family);
  removeBatchConfirmed.clear();
}

function clearRemoveBatch() {
  removeBatchIds = [];
  removeBatchFamilies = [];
  removeBatchConfirmed.clear();
}

/** Confirm Off for unloaded family names (ready_names / done prefix). */
async function confirmRemoveUnloaded(names: string[]) {
  if (!names.length || !removeBatchIds.length) return;
  const want = new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean));
  const ids: string[] = [];
  for (let i = 0; i < removeBatchFamilies.length; i += 1) {
    const fam = removeBatchFamilies[i]!;
    const id = removeBatchIds[i]!;
    if (!want.has(fam.trim().toLowerCase())) continue;
    if (removeBatchConfirmed.has(id)) continue;
    removeBatchConfirmed.add(id);
    ids.push(id);
    installedCache.delete(fam.toLowerCase());
  }
  if (!ids.length) return;
  const { useFontStore } = await import("./store");
  useFontStore.getState().confirmDeactivated(ids);
}

/** Index fallback when ready_names empty (older path): first `done` families. */
async function confirmRemovePrefixByDone(done: number) {
  if (!removeBatchIds.length || done <= 0) return;
  const n = Math.min(done, removeBatchFamilies.length);
  await confirmRemoveUnloaded(removeBatchFamilies.slice(0, n));
}

/** Never-unloaded: clear pending-off so chrome stays Live (matches Cancel toast). */
async function restoreRemoveRemainderLive(extraIds: string[] = []) {
  const { useFontStore } = await import("./store");
  const remainder = [
    ...removeBatchIds.filter((id) => !removeBatchConfirmed.has(id)),
    ...extraIds,
  ];
  const uniq = Array.from(new Set(remainder));
  if (uniq.length) useFontStore.getState().clearPendingDeactivate(uniq);
  clearRemoveBatch();
  return uniq;
}

let lastPaint = 0;
let pollTimer = 0;
let rustSeenRunning = false;
let ignoreProgress = false;
/** 1.0.206w: Refresh Documents owns cancel toast (sticky — survives finally clearing active). */
let docsVfSyncActive = false;
/** Set when Cancel hits while docs sync owns the bar; survives docsVfSyncActive=false in finally. */
let docsVfSyncCancelPending = false;
/** cancelDownloadQueue already toasted Documents refresh cancelled — callers must not double-toast. */
let docsVfSyncCancelToasted = false;
let expectKind: "" | "download" | "register" | "remove" = "";

/** Progress current looks like Refresh Documents / docs VF sync (belt-and-suspenders vs flag race). */
function isDocsRefreshJobCurrent(current: string): boolean {
  return /scanning documents|syncing documents|sync cancelled|refresh(?:ing)? documents/i.test(
    current ?? "",
  );
}

/** True while Refresh Documents owns the progress bar (active or sticky cancel pending). */
export function isDocsVfSyncJob(): boolean {
  return (
    docsVfSyncActive ||
    docsVfSyncCancelPending ||
    isDocsRefreshJobCurrent(job.current ?? "")
  );
}

/** Caller: skip Documents refresh cancelled if cancelDownloadQueue already toasted it. */
export function didDocsVfSyncCancelToast(): boolean {
  if (!docsVfSyncCancelToasted) return false;
  docsVfSyncCancelToasted = false;
  return true;
}

function emitProgress(force = false) {
  if (force) {
    if (progressEmitTimer) {
      window.clearTimeout(progressEmitTimer);
      progressEmitTimer = 0;
    }
    lastProgressEmit = Date.now();
    emit();
    return;
  }
  const now = Date.now();
  if (now - lastProgressEmit >= PROGRESS_EMIT_MS) {
    lastProgressEmit = now;
    emit();
    return;
  }
  if (!progressEmitTimer) {
    progressEmitTimer = window.setTimeout(() => {
      progressEmitTimer = 0;
      lastProgressEmit = Date.now();
      emit();
    }, PROGRESS_EMIT_MS - (now - lastProgressEmit));
  }
}

function applyPayload(p: {
  running: boolean;
  paused?: boolean;
  done: number;
  total: number;
  failed: number;
  current: string;
  failed_names?: string[];
  failed_details?: string[];
  ready_names?: string[];
  settled_names?: string[];
  skipped?: number;
  kind?: string;
}) {
  if (ignoreProgress) return;
  const readyLen = p.ready_names?.length ?? 0;
  const payloadKind = p.kind === "remove" || p.kind === "download" || p.kind === "register" ? p.kind : "";
  // Register is on-disk Add — same Rust download progress channel, distinct owner.
  const registering =
    payloadKind === "register" ||
    (payloadKind === "download" && /registering/i.test(p.current ?? "")) ||
    (expectKind === "register");
  if (expectKind === "register" && payloadKind === "download") {
    /* register polls share download channel — allow */
  } else if (expectKind && payloadKind && payloadKind !== expectKind && !(expectKind === "register" && payloadKind === "download")) {
    return;
  }
  if (expectKind && !payloadKind && !p.running && !p.paused) return;
  const kind: ProgressOwner =
    payloadKind === "remove" || expectKind === "remove" || job.mode === "remove"
      ? "remove"
      : registering
        ? "register"
        : payloadKind === "download" || expectKind === "download"
          ? "download"
          : job.owner !== "idle"
            ? job.owner
            : "download";
  const sig = [
    p.running ? 1 : 0,
    p.paused ? 1 : 0,
    p.done,
    p.total,
    p.failed,
    p.skipped ?? 0,
    readyLen,
    p.failed_names?.length ?? 0,
    p.settled_names?.length ?? 0,
    (p.failed_details ?? []).join("\x1e"),
    p.current,
    kind,
  ].join("|");
  // Never let a stale idle/zero snapshot wipe a live or paused bar back to 0%.
  if (
    (job.running || job.paused) &&
    job.total > 0 &&
    p.total === 0 &&
    !p.running &&
    !p.paused
  ) {
    return;
  }
  if (sig === lastPayloadSig) return;
  lastPayloadSig = sig;
  const rustIdle = !p.running && !p.paused;
  if (rustIdle && pollTimer) {
    const thisJobDone =
      rustSeenRunning ||
      (Boolean(payloadKind) &&
        payloadKind === expectKind &&
        p.total > 0 &&
        p.done + p.failed >= p.total);
    if (!thisJobDone) return;
  }
  const prevRunning = job.running;
  const prevPaused = job.paused;
  const wasRunning = job.running || job.paused;
  const done = job.paused && p.done < job.done && p.total === job.total ? job.done : p.done;
  const skipped = job.paused
    ? Math.max(p.skipped ?? 0, job.skipped)
    : (p.skipped ?? 0);
  const active = Boolean(p.running || p.paused);
  job = {
    running: p.running,
    paused: Boolean(p.paused),
    mode: active ? kind : "idle",
    owner: active ? kind : "idle",
    done,
    total: Math.max(p.total, p.done, job.paused || job.running ? job.total : 0),
    failed: p.failed,
    skipped,
    // 1.0.187: never `p.current || job.current` — Rust empty clear must stick (settled-idle hang).
    // 1.0.204: idle finish always clears current so Registering… cannot stick after job idle.
    current: active ? (p.current ?? "") : "",
    failedNames: p.failed_names ?? [],
    failedDetails: p.failed_details ?? [],
    settledNames: p.settled_names ?? [],
  };
  markJobClock(job.running, job.paused);
  const forceEmit =
    Boolean(p.running) !== Boolean(prevRunning) ||
    Boolean(p.paused) !== Boolean(prevPaused) ||
    (!p.running && !p.paused && wasRunning);
  emitProgress(forceEmit);
  unlockUi();
  if (readyLen && readyLen !== lastReadyCount && kind !== "remove") {
    lastReadyCount = readyLen;
    queueReadyFamilies(p.ready_names ?? []);
  }
  // 1.0.206j: remove ready_names = unloaded prefix — confirm Off progressively (not all at spawn).
  if (kind === "remove" && removeBatchIds.length) {
    if (readyLen) void confirmRemoveUnloaded(p.ready_names ?? []);
    else if (p.done > 0) void confirmRemovePrefixByDone(p.done);
  }
  if (p.running || p.paused) rustSeenRunning = true;
  if (
    rustIdle &&
    pollTimer &&
    (rustSeenRunning ||
      (Boolean(payloadKind) && payloadKind === expectKind && p.total > 0 && p.done + p.failed >= p.total))
  ) {
    window.clearInterval(pollTimer);
    pollTimer = 0;
    rustSeenRunning = false;
    expectKind = "";
    if (kind !== "remove" && p.ready_names?.length) readyCumulative = p.ready_names;
    emitProgress(true);
    if (kind === "remove") {
      const cancelled =
        (p.total > 0 && p.done < p.total) || /cancel/i.test(String(p.current ?? ""));
      const unloaded = (p.ready_names?.length ? p.ready_names : removeBatchFamilies.slice(0, p.done)).slice();
      void (async () => {
        await confirmRemoveUnloaded(unloaded);
        if (cancelled) {
          await restoreRemoveRemainderLive();
          // Cancel toast owned by cancelDownloadQueue when user clicked Cancel.
        } else {
          // Full finish — confirm any stragglers in batch, then clear.
          if (removeBatchFamilies.length) await confirmRemoveUnloaded(removeBatchFamilies);
          const n = Math.max(unloaded.length, p.done, removeBatchConfirmed.size);
          clearRemoveBatch();
          if (n > 0) {
            toast.success(`Deactivated ${n.toLocaleString()} — files kept in Documents`, {
              description: n > 8 ? "Windows is catching up in the background." : undefined,
            });
          }
        }
        finishOwnedJob("remove");
      })();
      return;
    }
    notifyDownloadResult(p.done, p.failed, p.failed_names ?? [], p.failed_details ?? [], p.settled_names ?? []);
    // Scope to this google job — do not wipe local install-queue pending (mixed Activate All).
    // settled_names: Gidugu-class quiet settle (intact + known GDI-incapable) — clear pending, no toast.
    void finalizeReadyAndClearPending([
      ...readyCumulative,
      ...(p.failed_names ?? []),
      ...(p.settled_names ?? []),
    ]);
  }
}

async function pollRustProgress() {
  try {
    const p = await tauriInvoke<{
      running: boolean;
      paused?: boolean;
      done: number;
      total: number;
      failed: number;
      current: string;
      failed_names?: string[];
      failed_details?: string[];
      ready_names?: string[];
      settled_names?: string[];
      skipped?: number;
      kind?: string;
    }>("google_download_progress");
    applyPayload(p);
  } catch {
    /* ignore */
  }
}

let eventsBound = false;
/** Bind desktop event listeners early (hydrate) so startup session-recovery toasts are not lost. */
export async function bindDownloadEvents() {
  if (eventsBound) return;
  eventsBound = true;
  if (!(await inDesktopShell())) return;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    await listen("font-download", (ev) => {
      applyPayload(ev.payload as Parameters<typeof applyPayload>[0]);
    });
    await listen("name-heal", (ev) => {
      const p = ev.payload as { healed?: number; locked?: number; write_failed?: number };
      const locked = (p.locked ?? 0) + (p.write_failed ?? 0);
      // Activate/download heal path — fail loud when Illustrator/fontdrvhost holds TTFs.
      if (locked > 0) {
        toastNameHealLocked(locked, p.healed ?? 0);
      }
    });
    await listen("session-recovery", (ev) => {
      const p = ev.payload as { locked?: number; attempted?: number };
      const locked = p.locked ?? 0;
      if (locked > 0) {
        toastSessionRecoveryLocked(locked, p.attempted ?? 0);
      }
    });
    await listen("font-cache-held", (ev) => {
      const p = ev.payload as { locked?: number; access_denied?: boolean };
      const locked = p.locked ?? 0;
      if (locked > 0 || p.access_denied) {
        toastFontCacheHeld(locked, !!p.access_denied);
      }
    });
    await listen("gdi-pressure", (ev) => {
      const p = ev.payload as { objects?: number; quota?: number; message?: string };
      const objects = p.objects ?? 0;
      if (objects > 0) toastGdiPressure(objects, p.quota ?? 10_000, p.message);
    });
  } catch {
    eventsBound = false;
  }
}

function ensureGooglePoll() {
  void bindDownloadEvents();
  ignoreProgress = false;
  unlockUi();
  if (pollTimer) return;
  rustSeenRunning = rustSeenRunning || job.running || job.paused;
  pollTimer = window.setInterval(() => void pollRustProgress(), 400);
  void pollRustProgress();
}

function startGooglePoll(kind?: "download" | "register" | "remove") {
  if (kind) {
    expectKind = kind;
    lastPayloadSig = "";
  }
  void bindDownloadEvents();
  ignoreProgress = false;
  unlockUi();
  // New job only — Resume must not reset ready marks or the percent clock.
  const restartFlush = flushReadyFamilies();
  resetReadyBatching();
  void restartFlush;
  if (!(job.running || job.paused)) rustSeenRunning = false;
  if (pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = 0;
  }
  ensureGooglePoll();
}

function paint(force = false) {
  markJobClock(job.running, job.paused);
  const now = Date.now();
  if (!force && now - lastPaint < 400) return;
  lastPaint = now;
  emit();
}

function finishIfIdle() {
  if (installQueue.length || removeQueue.length || workers > 0) return;
  const wasRemove = job.mode === "remove" || job.owner === "remove";
  const snapshot = { ...job, running: false, mode: "idle" as const, owner: "idle" as const, current: "" };
  job = snapshot;
  markJobClock(false, false);
  emit();
  unlockUi();
  if (snapshot.total > 0 && snapshot.done + snapshot.failed > 0) {
    if (wasRemove) {
      toast.success(`Deactivated ${snapshot.done.toLocaleString()} — files kept in Documents`);
    } else {
      notifyDownloadResult(snapshot.done, snapshot.failed, snapshot.failedNames, snapshot.failedDetails, snapshot.settledNames ?? []);
    }
  }
}

async function installOne(font: FontRecord, lean: boolean) {
  if (cacheHas(font.family)) return;
  if (font.originPath) {
    await tauriInvoke("register_font_path", { path: font.originPath });
    installedCache.add(font.family.toLowerCase());
    return;
  }
  if (font.source === "local") {
    const files = await localFiles(font);
    if (!files.length) throw new Error("Uploaded file is not in the library yet.");
    for (const file of files) {
      await writeAndRegister(font.family, file.fileName, file.data);
    }
    return;
  }
  const files = await googleTtfFiles(font, lean);
  if (!files.length) throw new Error(`Could not download ${font.family}`);
  for (const file of files) {
    await writeAndRegister(font.family, file.fileName, file.data);
  }
}

async function pumpInstall(myBatch: number) {
  workers += 1;
  while (myBatch === batchId) {
    while (job.paused && myBatch === batchId) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 200));
    }
    if (myBatch !== batchId) break;
    const next = installQueue.shift();
    if (!next) break;
    job = { ...job, current: next.font.family, running: true, mode: "download", owner: job.owner === "idle" ? "download" : job.owner };
    paint();
    try {
      await installOne(next.font, next.lean);
      job = { ...job, done: job.done + 1 };
      // Local/upload path used to set activated[] up front — mark live only after register.
      const { useFontStore } = await import("./store");
      useFontStore.getState().markLiveActivated([next.font.id]);
    } catch (err) {
      console.error(err);
      const detail = err instanceof Error ? `${next.font.family} — ${err.message}` : next.font.family;
      const names = job.failedNames.includes(next.font.family)
        ? job.failedNames
        : [...job.failedNames, next.font.family];
      const details = job.failedDetails.includes(detail) ? job.failedDetails : [...job.failedDetails, detail];
      job = { ...job, failed: job.failed + 1, failedNames: names, failedDetails: details };
      lastFailedNames = names;
      const { useFontStore } = await import("./store");
      useFontStore.getState().clearPendingActivate([next.font.id]);
    }
    paint();
    unlockUi();
    await yieldUi();
  }
  workers -= 1;
  if (myBatch === batchId) finishIfIdle();
}

function kickInstall() {
  const myBatch = batchId;
  if (!installQueue.length && workers === 0) {
    finishIfIdle();
    return;
  }
  const need = Math.max(0, Math.min(MAX_WORKERS, installQueue.length) - workers);
  for (let i = 0; i < need; i += 1) void pumpInstall(myBatch);
}

async function pumpRemove(myBatch: number) {
  workers += 1;
  while (myBatch === batchId) {
    while (job.paused && myBatch === batchId) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 200));
    }
    if (myBatch !== batchId) break;
    const font = removeQueue.shift();
    if (!font) break;
    // Only paint remove chrome when remove owns the bar (split owners).
    if (!(job.running && job.owner !== "remove" && job.owner !== "idle")) {
      beginOwnedJob("remove", {
        total: Math.max(1, job.owner === "remove" ? job.total : removeQueue.length + 1),
        current: font.family,
      });
    } else {
      job = { ...job, current: font.family };
      paint();
    }
    try {
      await tauriInvoke("unload_font_family", { family: font.family });
      installedCache.delete(font.family.toLowerCase());
      job = { ...job, done: job.done + 1 };
      const { useFontStore } = await import("./store");
      useFontStore.getState().confirmDeactivated([font.id]);
    } catch {
      job = { ...job, failed: job.failed + 1 };
      const { useFontStore } = await import("./store");
      // Unload failed — clear pending-off so user can retry; keep Live honest.
      useFontStore.getState().clearPendingDeactivate([font.id]);
    }
    await yieldUi();
  }
  workers -= 1;
  if (myBatch === batchId) finishIfIdle();
}

export function cancelDownloadQueue() {
  // 1.0.206w: snapshot BEFORE clearing job / before sync finally races active→false.
  const currentSnap = job.current ?? "";
  const wasDocsVfSync =
    docsVfSyncActive ||
    docsVfSyncCancelPending ||
    isDocsRefreshJobCurrent(currentSnap);
  const wasRestore = !wasDocsVfSync && /restoring/i.test(currentSnap);
  if (wasDocsVfSync) {
    docsVfSyncCancelPending = true;
  }
  // Docs cancel toast must fire before any await (race-proof ownership).
  if (wasDocsVfSync) {
    toast.message("Documents refresh cancelled", {
      id: "sync-docs-vf",
      description:
        "Folders checked / statics removed before cancel stay applied. Fonts already saved stay in Documents → Font Manager.",
    });
    docsVfSyncCancelToasted = true;
    docsVfSyncCancelPending = false;
    docsVfSyncActive = false;
  }
  batchId += 1;
  installQueue.length = 0;
  const queuedRemove = removeQueue.splice(0, removeQueue.length);
  workers = 0;
  const wasRemove =
    job.mode === "remove" || job.owner === "remove" || removeBatchIds.length > 0 || queuedRemove.length > 0;
  const doneSnap = wasRemove ? Math.max(0, job.done) : 0;
  const keepFailed = (lastFailedNames.length ? lastFailedNames : job.failedNames).slice();
  const keepDetails = job.failedDetails.slice();
  ignoreProgress = true;
  expectKind = "";
  // Cancel always stops the queue; keep failures so Retry stays visible.
  job = {
    ...EMPTY,
    failed: keepFailed.length,
    failedNames: keepFailed,
    failedDetails: keepDetails,
  };
  lastFailedNames = keepFailed;
  markJobClock(false, false);
  emit();
  unlockUi();
  void tauriInvoke("cancel_google_downloads").catch(() => undefined);
  if (pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = 0;
    rustSeenRunning = false;
  }
  window.setTimeout(() => {
    ignoreProgress = false;
  }, 600);
  // Flush+mark any queued ready families before clearPending; reset timer/cumulative with that.
  void finalizeReadyAndClearPending();
  // Docs path already toasted — never emit Download cancelled.
  if (wasDocsVfSync) {
    return;
  }
  // 1.0.206j: Cancel Deactivate — confirm Off only for unloaded prefix; restore Live for remainder.
  // Toast must match store (no "stay Live" if already confirmDeactivated-all at spawn).
  // 1.0.206k: wasRemove always runs prefix confirm + restoreRemoveRemainderLive — independent of
  // keepFailed (stale Activate lastFailedNames must not skip Live restore or steal toast).
  void (async () => {
    let description: string;
    if (wasRemove) {
      const { useFontStore } = await import("./store");
      await confirmRemovePrefixByDone(doneSnap);
      const extra = queuedRemove.map((f) => f.id);
      const unloadedN = Math.max(doneSnap, removeBatchConfirmed.size);
      const remainder = await restoreRemoveRemainderLive(extra);
      const liveRemain = remainder.filter((id) => useFontStore.getState().activatedSet.has(id)).length;
      if (liveRemain > 0) {
        description =
          "Already-unloaded stay Off; Cancel stops further Removes — remaining stay Live.";
      } else if (unloadedN > 0) {
        description = `Unloaded ${unloadedN.toLocaleString()} Off; nothing left pending.`;
      } else {
        description = "No Removes finished — Live unchanged.";
      }
    } else if (keepFailed.length) {
      description = `${keepFailed.length.toLocaleString()} failed still listed — Retry, Skip, or Open folder.`;
    } else if (wasRestore) {
      description = "Already-restored faces stay Live; Cancel stops further session Adds.";
    } else {
      description = "Fonts already saved stay in Documents → Font Manager.";
    }
    // 1.0.206w: session GDI restore Cancel is not a download — honest title (optional honesty).
    const title = wasRemove
      ? "Deactivate cancelled"
      : wasRestore
        ? "Session restore cancelled"
        : "Download cancelled";
    toast.message(title, {
      description,
      action: { label: "Open folder", onClick: () => void openActivatedFolder() },
    });
  })();
}

export function pauseDownloadQueue() {
  if (!job.running && !job.paused) return;
  job = { ...job, paused: true, running: true };
  markJobClock(true, true);
  emit();
  void tauriInvoke("pause_google_downloads").catch(() => undefined);
  toast.message("Paused", { description: `${Math.round((100 * job.done) / Math.max(1, job.total))}% held. Resume continues from here — it does not restart.` });
}

export function resumeDownloadQueue() {
  if (!job.paused && !job.running) return;
  job = { ...job, paused: false, running: true };
  markJobClock(true, false);
  emit();
  void tauriInvoke("resume_google_downloads").catch(() => undefined);
  ensureGooglePoll();
  toast.message("Resumed", { description: "Same queue, same percent." });
}

const uploadQueue: { family: string; fileName: string; bytes: Uint8Array }[] = [];
let uploadPumping = false;
let uploadsSaved = 0;

async function pumpUploads() {
  if (uploadPumping) return;
  uploadPumping = true;
  while (uploadQueue.length) {
    const item = uploadQueue.shift();
    if (!item) break;
    try {
      await writeAndRegister(item.family, item.fileName, item.bytes);
      uploadsSaved += 1;
    } catch (err) {
      console.error(err);
    }
    await yieldUi();
  }
  uploadPumping = false;
  if (uploadsSaved) {
    await tauriInvoke("flush_font_cache").catch(() => undefined);
    toast.success(
      uploadsSaved === 1 ? "Upload saved to Documents" : `${uploadsSaved} uploads saved to Documents`,
      { description: "Documents → Font Manager → FamilyName. Other apps may need a restart." },
    );
    uploadsSaved = 0;
  }
}

export async function saveUploadToDisk(opts: {
  family: string;
  fileName: string;
  buffer: ArrayBuffer;
}): Promise<void> {
  if (!(await inDesktopShell())) return;
  uploadQueue.push({
    family: opts.family,
    fileName: opts.fileName,
    bytes: new Uint8Array(opts.buffer),
  });
  void pumpUploads();
}

let webPreviewTold = new Set<string>();

function tellWebPreview(font?: FontRecord) {
  const kind = !font ? "local" : isFontsourceOnly(font) ? "other" : isGoogleCatalog(font) ? "google" : "local";
  if (webPreviewTold.has(kind)) return;
  webPreviewTold.add(kind);
  const fontsource = kind === "other";
  const google = kind === "google";
  toast.message(
    fontsource
      ? "This website previews Fontsource in the browser"
      : google
        ? "This website previews Google Fonts in the browser"
        : "This website previews in the browser",
    {
      description: fontsource
        ? "Files stay on Fontsource (jsDelivr). Use the desktop app to download TTFs into Documents and register them for Word or Adobe."
        : google
          ? "Files stay on Google Fonts. Use the desktop app to download TTFs into Documents and register them for Word or Adobe."
          : "Use the desktop app to download TTFs into Documents and register them for Word or Adobe.",
      duration: 12_000,
    },
  );
}

async function markPreviewLive(ids: string[]) {
  if (!ids.length) return;
  const { useFontStore } = await import("./store");
  useFontStore.getState().markLiveActivated(ids);
}

function bumpDownloadJobForFamily(family: string) {
  if (job.running && (job.mode === "download" || job.owner === "download")) {
    if (!job.current) {
      job = { ...job, current: family };
      emit();
    }
    return;
  }
  if (job.paused && (job.mode === "download" || job.owner === "download")) return;
  beginOwnedJob("download", { total: 1, current: family });
}

/** Single-card Activate must merge into the bulk worker — never wait for a sibling family's idle. */
export function googleCardActivateWaitsForIdle() {
  return false;
}

async function queueGoogleFamilyDownload(
  family: string,
  intent: "google" | "fontsource" | "local" = "google",
): Promise<void> {
  void bindDownloadEvents();
  bumpDownloadJobForFamily(family);
  const added = await tauriInvoke<number>("start_google_downloads", {
    families: [family],
    intents: [intent],
  }).catch(() => 0);
  startGooglePoll("download");
  if (!added) void startActivateOnDisk([family]);
}

export async function installFontOnSystem(font: FontRecord): Promise<boolean> {
  if (font.source === "system") return true;
  if (!(await inDesktopShell())) {
    await markPreviewLive([font.id]);
    tellWebPreview(font);
    return true;
  }
  if (font.source === "google") {
    await queueGoogleFamilyDownload(font.family, fetchIntentFor(font));
    return true;
  }
  bumpDownloadJobForFamily(font.family);
  void startActivateOnDisk([font.family]);
  installQueue.push({ font, lean: false });
  kickInstall();
  return true;
}

/** Drop a family's download/register queue slot so Deactivate is not buried behind the job. */
export async function dropDownloadFamilies(families: string[]): Promise<void> {
  if (!families.length) return;
  const keys = new Set(families.map((n) => n.trim().toLowerCase()).filter(Boolean));
  for (let i = installQueue.length - 1; i >= 0; i -= 1) {
    if (keys.has(installQueue[i]!.font.family.toLowerCase())) installQueue.splice(i, 1);
  }
  if (!(await inDesktopShell())) return;
  try {
    await tauriInvoke("drop_google_download_families", { families });
  } catch {
    /* older installer — cancel-all is too heavy; Remove still runs */
  }
}

export async function uninstallFontOnSystem(font: FontRecord): Promise<void> {
  if (font.source === "system") return;
  if (!(await inDesktopShell())) return;
  // P1: Deactivate while download/register running — drop that family's slot, then Remove.
  if (job.running && (job.mode === "download" || job.mode === "register" || job.owner === "download" || job.owner === "register")) {
    await dropDownloadFamilies([font.family]);
    removeQueue.push(font);
    void pumpRemove(batchId);
    return;
  }
  await syncFontsOnSystem([font], false);
}

function invokeError(err: unknown): string {
  if (typeof err === "string" && err.trim()) return err;
  if (err instanceof Error && err.message.trim()) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    const m = String((err as { message: unknown }).message ?? "").trim();
    if (m) return m;
  }
  return "delete failed";
}

/** Delete family folder from Documents after unload. Surfaces locks — no silent success. */
export async function deleteFontFiles(font: FontRecord): Promise<boolean> {
  if (font.source === "system") {
    toast.message("System fonts are read-only", {
      description: "Font Manager never deletes C:\\Windows\\Fonts.",
    });
    return false;
  }
  if (!(await inDesktopShell())) {
    toast.message("Delete files needs the desktop app");
    return false;
  }
  try {
    await tauriInvoke("uninstall_font_family", { family: font.family });
    installedCache.delete(font.family.toLowerCase());
    const { useFontStore } = await import("./store");
    const s = useFontStore.getState();
    s.setActivatedMany([font.id], false);
    const next = s.diskFamilies.filter((n) => n.toLowerCase() !== font.family.toLowerCase());
    s.setDiskFamilies(next);
    const local = font.source === "local";
    toast.success(`Moved ${font.family} to the Recycle Bin`, {
      id: `recycle-${font.id}`,
      description: local
        ? "Removed from the library. Restore from Recycle Bin if you need it back."
        : "Restore from Recycle Bin if you need the files back. Catalog entry stays.",
    });
    return true;
  } catch (err) {
    toast.error(`Could not move ${font.family} to the Recycle Bin`, {
      id: `recycle-${font.id}`,
      description: invokeError(err),
      duration: 20_000,
      action: { label: "Open folder", onClick: () => void openActivatedFolder() },
    });
    return false;
  }
}

export const removeUploadFromDisk = deleteFontFiles;

export async function syncFontOnSystem(font: FontRecord, on: boolean): Promise<void> {
  if (on) await installFontOnSystem(font);
  else await uninstallFontOnSystem(font);
}

export async function syncFontsOnSystem(fonts: FontRecord[], on: boolean): Promise<void> {
  fonts = fonts.filter((font) => font.source !== "system");
  if (!fonts.length) return;
  if (!(await inDesktopShell())) {
    if (on) {
      await markPreviewLive(fonts.map((font) => font.id));
      if (fonts.length === 1) tellWebPreview(fonts[0]);
    } else {
      const { useFontStore } = await import("./store");
      useFontStore.getState().confirmDeactivated(fonts.map((f) => f.id));
    }
    return;
  }
  unlockUi();
  if (!on) {
    const names = fonts.map((font) => font.family);
    // Drop any in-flight download slots for these families first.
    await dropDownloadFamilies(names);
    // Never steal download/register bar — split progress owners.
    const canOwn = beginOwnedJob("remove", { total: names.length, current: names[0] ?? "" });
    // 1.0.206j: when another owner holds the bar, per-family pumpRemove confirms each Remove
    // complete (never confirmDeactivated(all) at spawn).
    if (!canOwn) {
      for (const font of fonts) removeQueue.push(font);
      void pumpRemove(batchId);
      unlockUi();
      return;
    }
    beginRemoveBatch(fonts);
    try {
      // unload_font_families returns at spawn — GDI runs on a worker. Do NOT confirm all Off here.
      await tauriInvoke<number>("unload_font_families", { families: names });
      startGooglePoll("remove");
      // Poll / ready_names drive prefix confirmDeactivated; Cancel restores remainder Live.
    } catch {
      clearRemoveBatch();
      for (const font of fonts) removeQueue.push(font);
      void pumpRemove(batchId);
    }
    unlockUi();
    return;
  }
  const google = fonts.filter((font) => font.source === "google");
  const local = fonts.filter((font) => font.source === "local");
  if (google.length) {
    const names = google.map((font) => font.family);
    const intents = google.map((font) => fetchIntentFor(font));
    if (!(job.running && (job.mode === "download" || job.owner === "download"))) {
      beginOwnedJob("download", { total: names.length, current: "Scanning Documents…" });
    }
    toast.message("Scanning Documents first", {
      description: `${names.length.toLocaleString()} families. Intact files register only; missing files download up to three at a time.`,
    });
    let added = 0;
    let startFailed = false;
    try {
      added = await tauriInvoke<number>("start_google_downloads", { families: names, intents });
    } catch {
      // Invoke fail/timeout — fall back to sync on-disk register (no false live).
      startFailed = true;
      added = 0;
    }
    startGooglePoll("download");
    if (!added) {
      // Ok(0) often means already queued in a running bulk job — leave the poll alone.
      // Sync-register when start failed, or when Rust is idle (nothing else owns the bar).
      let bulkRunning = false;
      if (!startFailed) {
        try {
          const p = await tauriInvoke<{ running: boolean; paused?: boolean }>("google_download_progress");
          bulkRunning = Boolean(p.running || p.paused);
        } catch {
          bulkRunning = false;
        }
      }
      if (bulkRunning) {
        /* poll drives progress / ready_names */
      } else {
        // 1.0.165: spawn Rust worker; do not await multi-minute GDI on invoke.
        // Ok([]) = accepted — poll/event drives % + ready_names + finalize.
        // Invoke fail (no worker) → nothing live, clear pending (honesty).
        if (!(job.running || job.paused)) {
          beginOwnedJob("register", { total: names.length, current: "Checking disk…" });
        }
        startGooglePoll("register");
        const started = await startActivateOnDisk(names);
        if (!started) {
          lastFailedNames = names.slice();
          const details = names.map(
            (n) => `${n} — on disk but GDI register failed or invoke timed out`,
          );
          job = {
            ...job,
            running: false,
            paused: false,
            done: 0,
            skipped: 0,
            failed: names.length,
            failedNames: names.slice(),
            failedDetails: details,
            total: Math.max(job.total, names.length),
            current: "",
            mode: "idle",
            owner: "idle",
          };
          markJobClock(false, false);
          emit();
          notifyDownloadResult(0, names.length, names, details);
          await clearPendingForFamilyNames(names);
        }
        /* else: poll applyPayload marks live from ready_names; finalize on idle */
      }
    }
  }
  if (local.length) {
    if (!(job.running && (job.mode === "download" || job.owner === "download") && google.length)) {
      const merge = job.running && (job.mode === "download" || job.owner === "download");
      beginOwnedJob("download", {
        total: (merge ? job.total : 0) + local.length,
        current: local[0]?.family ?? "",
      });
      if (merge) {
        job = {
          ...job,
          done: job.done,
          failed: job.failed,
          skipped: job.skipped,
          failedNames: job.failedNames,
          failedDetails: job.failedDetails,
          total: job.total,
        };
        emit();
      }
    }
    for (const font of local) installQueue.push({ font, lean: false });
    kickInstall();
  }
}

export async function openActivatedFolder(): Promise<string | null> {
  if (!(await inDesktopShell())) return null;
  try {
    const dir = (await tauriInvoke<string>("activation_folder")) ?? null;
    await tauriInvoke("open_activation_folder");
    return dir;
  } catch {
    return null;
  }
}
