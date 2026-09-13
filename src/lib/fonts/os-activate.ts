import { toast } from "sonner";
import { inDesktopShell } from "@/lib/desktop/open-fonts";
import { isFontsourceOnly, isGoogleCatalog } from "./catalog";
import { idbGet } from "./idb";
import type { FontRecord } from "./types";

export type DownloadJobState = {
  running: boolean;
  paused: boolean;
  mode: "idle" | "download" | "remove";
  done: number;
  total: number;
  failed: number;
  skipped: number;
  current: string;
  failedNames: string[];
  failedDetails: string[];
};

const EMPTY: DownloadJobState = {
  running: false,
  paused: false,
  mode: "idle",
  done: 0,
  total: 0,
  failed: 0,
  skipped: 0,
  current: "",
  failedNames: [],
  failedDetails: [],
};

let job: DownloadJobState = { ...EMPTY };
const listeners = new Set<() => void>();

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

function notifyDownloadResult(done: number, failed: number, names: string[], details: string[]) {
  lastFailedNames = names.slice();
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
  if (done > 0) {
    const skipped = job.skipped;
    const downloaded = Math.max(0, done - skipped - failed);
    toast.success(
      skipped && !downloaded
        ? `Already on disk — ${skipped.toLocaleString()} typeface${skipped === 1 ? "" : "s"} registered`
        : `Background job finished — ${downloaded.toLocaleString()} downloaded, ${skipped.toLocaleString()} skipped`,
      {
        description: "Files: Documents → Font Manager → FamilyName. Intact files were not fetched again.",
      },
    );
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
    const { googleFonts, localFonts, markLiveActivated, pendingSet } = useFontStore.getState();
    const catalogByFamily = new Map<string, string>();
    const localByFamily = new Map<string, string>();
    for (const font of googleFonts) catalogByFamily.set(font.family.toLowerCase(), font.id);
    for (const font of localFonts) localByFamily.set(font.family.toLowerCase(), font.id);
    const ids: string[] = [];
    for (const name of names) {
      const key = name.trim().toLowerCase();
      const catalogId = catalogByFamily.get(key);
      const localId = localByFamily.get(key);
      // Prefer the id we queued (pending), then catalog over a local of the same family.
      if (catalogId && pendingSet.has(catalogId)) ids.push(catalogId);
      else if (localId && pendingSet.has(localId)) ids.push(localId);
      else if (catalogId) ids.push(catalogId);
      else if (localId) ids.push(localId);
    }
    if (ids.length) markLiveActivated(ids);
    useFontStore.getState().addDiskFamilies(names);
  });
}

/** Flush ready marks (await markLiveActivated) then clear pending — never clear first. */
async function finalizeReadyAndClearPending() {
  await flushReadyFamilies();
  resetReadyBatching();
  const { useFontStore } = await import("./store");
  useFontStore.getState().clearPendingActivate();
}

/** Direct callers (restore/resume) commit immediately; progress path uses queueReadyFamilies. */
function applyReadyFamilies(names: string[]) {
  if (!names.length) return;
  if (pollTimer || job.running || job.paused) queueReadyFamilies(names);
  else void commitReadyFamilies(names);
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
      toast.message("Retrying — old files are replaced", {
        description: `${added.toLocaleString()} ${added === 1 ? "family" : "families"} (attempt capped at ${MAX_RETRY_ATTEMPTS}). Cancel anytime. Close Word or Adobe if a file stays locked.`,
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
    clearPendingActivate(ids.length ? ids : undefined);
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
  const ready = await tauriInvoke<string[]>("activate_families_on_disk", { families: readyNames }).catch(
    () => readyNames,
  );
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
    const ready = await tauriInvoke<string[]>("activate_families_on_disk", { families: plan.ready }).catch(
      () => plan.ready,
    );
    if (ready?.length) applyReadyFamilies(ready);
  }
  if (!missing.length) return;
  const added = await tauriInvoke<number>("start_google_downloads", { families: missing }).catch(() => 0);
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

export type DiskFamilyInfo = {
  name: string;
  bytes: number;
  files: number;
  corrupt?: number;
  incomplete?: boolean;
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

/** Keep library diskFamilies in sync with Documents\Font Manager (incl. Activated/Library). */
export async function syncManagedDocumentsRoot(): Promise<DiskFamilyInfo[]> {
  const rows = await scanDiskFamilies();
  if (!rows.length) return rows;
  const names = rows.map((r) => r.name);
  void import("./store").then(({ useFontStore }) => {
    useFontStore.getState().setDiskFamilies(names);
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

/** Prefer CJK script subsets when present; never treat latin-only as enough for CJK families. */
async function fontsourceSubsets(slug: string): Promise<string[]> {
  try {
    const res = await fetch(`https://api.fontsource.org/v1/fonts/${slug}`);
    if (!res.ok) return ["latin"];
    const data = (await res.json()) as { subsets?: string[] };
    const subsets = Array.isArray(data.subsets) ? data.subsets.filter((s) => typeof s === "string") : [];
    const cjk = subsets.filter(isCjkSubset);
    if (cjk.length) return cjk;
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
  const weights = emoji
    ? [400]
    : Array.from(new Set(font.weights.length ? font.weights : [400])).sort((a, b) => a - b);
  const styles: Array<"normal" | "italic"> = emoji ? ["normal"] : font.italic ? ["normal", "italic"] : ["normal"];
  const subsets = emoji ? ["latin"] : await fontsourceSubsets(slug);
  const files: { fileName: string; data: Uint8Array }[] = [];
  for (const subset of subsets) {
    for (const weight of weights) {
      for (const style of styles) {
        const urls = [
          "https://cdn.jsdelivr.net/fontsource/fonts/" + slug + "@latest/" + subset + "-" + weight + "-" + style + ".ttf",
          "https://cdn.jsdelivr.net/npm/@fontsource/" + slug + "/files/" + slug + "-" + subset + "-" + weight + "-" + style + ".ttf",
          "https://unpkg.com/@fontsource/" + slug + "/files/" + slug + "-" + subset + "-" + weight + "-" + style + ".ttf",
        ];
        if (slug === "noto-color-emoji" && weight === 400 && style === "normal") {
          urls.unshift(
            "https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@main/fonts/NotoColorEmoji.ttf",
            "https://github.com/googlefonts/noto-emoji/raw/refs/heads/main/fonts/NotoColorEmoji.ttf",
          );
        }
        let data: Uint8Array | null = null;
        for (const url of urls) {
          data = await fetchBytes(url);
          if (data) break;
        }
        // First-face 404 on non-400 must not abort the whole family (variable-only still aborts on 400).
        if (!data && subset === subsets[0] && weight === 400 && style === "normal") {
          return files;
        }
        if (data) files.push({ fileName: slug + "-" + subset + "-" + weight + "-" + style + ".ttf", data });
      }
    }
  }
  return files;
}

async function googleTtfFiles(font: FontRecord, _lean: boolean) {
  const slug = slugFamily(font.family);
  // Google CSS2 desktop TTFs first for official families; Fontsource only when Google listed nothing.
  const google = isGoogleCatalog(font) ? await googleCssTtfFiles(font.family, slug) : [];
  if (google.length) {
    // Fontsource `*-{subset}-*` names can never fill Google face keys — skip FS
    // fill on partial Google (matches Rust need_fontsource = google_expected == 0).
    return google;
  }
  return fontsourceTtfFiles(font, slug);
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
let lastPaint = 0;
let pollTimer = 0;
let rustSeenRunning = false;
let ignoreProgress = false;
let expectKind: "" | "download" | "remove" = "";

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
  skipped?: number;
  kind?: string;
}) {
  if (ignoreProgress) return;
  const readyLen = p.ready_names?.length ?? 0;
  const payloadKind = p.kind === "remove" || p.kind === "download" ? p.kind : "";
  if (expectKind && payloadKind && payloadKind !== expectKind) return;
  if (expectKind && !payloadKind && !p.running && !p.paused) return;
  const kind = payloadKind || expectKind || (job.mode === "remove" ? "remove" : "download");
  const sig = [
    p.running ? 1 : 0,
    p.paused ? 1 : 0,
    p.done,
    p.total,
    p.failed,
    p.skipped ?? 0,
    readyLen,
    p.failed_names?.length ?? 0,
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
  job = {
    running: p.running,
    paused: Boolean(p.paused),
    mode: p.running || p.paused ? kind : "idle",
    done,
    total: Math.max(p.total, job.paused || job.running ? job.total : 0),
    failed: p.failed,
    skipped,
    current: p.current || job.current,
    failedNames: p.failed_names ?? [],
    failedDetails: p.failed_details ?? [],
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
      const n = Math.max(p.done, p.total, job.total);
      if (n > 0) {
        toast.success(`Deactivated ${n.toLocaleString()} — files kept in Documents`, {
          description: n > 8 ? "Windows is catching up in the background." : undefined,
        });
      }
      job = { ...EMPTY };
      resetJobClock();
      emit();
      return;
    }
    notifyDownloadResult(p.done, p.failed, p.failed_names ?? [], p.failed_details ?? []);
    void finalizeReadyAndClearPending();
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

function startGooglePoll(kind?: "download" | "remove") {
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
  const wasRemove = job.mode === "remove";
  const snapshot = { ...job, running: false, mode: "idle" as const, current: "" };
  job = snapshot;
  markJobClock(false, false);
  emit();
  unlockUi();
  if (snapshot.total > 0 && snapshot.done + snapshot.failed > 0) {
    if (wasRemove) {
      toast.success(`Deactivated ${snapshot.done.toLocaleString()} — files kept in Documents`);
    } else {
      notifyDownloadResult(snapshot.done, snapshot.failed, snapshot.failedNames, snapshot.failedDetails);
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
    job = { ...job, current: next.font.family, running: true, mode: "download" };
    paint();
    try {
      await installOne(next.font, next.lean);
      job = { ...job, done: job.done + 1 };
    } catch (err) {
      console.error(err);
      const detail = err instanceof Error ? `${next.font.family} — ${err.message}` : next.font.family;
      const names = job.failedNames.includes(next.font.family)
        ? job.failedNames
        : [...job.failedNames, next.font.family];
      const details = job.failedDetails.includes(detail) ? job.failedDetails : [...job.failedDetails, detail];
      job = { ...job, failed: job.failed + 1, failedNames: names, failedDetails: details };
      lastFailedNames = names;
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
    job = { ...job, current: font.family, running: true, mode: "remove" };
    paint();
    try {
      await tauriInvoke("unload_font_family", { family: font.family });
      installedCache.delete(font.family.toLowerCase());
      job = { ...job, done: job.done + 1 };
    } catch {
      job = { ...job, failed: job.failed + 1 };
    }
    await yieldUi();
  }
  workers -= 1;
  if (myBatch === batchId) finishIfIdle();
}

export function cancelDownloadQueue() {
  batchId += 1;
  installQueue.length = 0;
  removeQueue.length = 0;
  workers = 0;
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
  toast.message("Download cancelled", {
    description: keepFailed.length
      ? `${keepFailed.length.toLocaleString()} failed still listed — Retry, Skip, or Open folder.`
      : "Fonts already saved stay in Documents → Font Manager.",
    action: { label: "Open folder", onClick: () => void openActivatedFolder() },
  });
  // Flush+mark any queued ready families before clearPending; reset timer/cumulative with that.
  void finalizeReadyAndClearPending();
}

export function pauseDownloadQueue() {
  if (!job.running && !job.paused) return;
  job = { ...job, paused: true, running: true };
  markJobClock(true, true);
  emit();
  void tauriInvoke("pause_google_downloads").catch(() => undefined);
  toast.message("Paused", { description: `${Math.round((100 * Math.max(job.done, job.skipped)) / Math.max(1, job.total))}% held. Resume continues from here — it does not restart.` });
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

export async function installFontOnSystem(font: FontRecord): Promise<boolean> {
  if (font.source === "system") return true;
  if (!(await inDesktopShell())) {
    await markPreviewLive([font.id]);
    tellWebPreview(font);
    return true;
  }
  if (font.source === "google") {
    void bindDownloadEvents();
    const ready = await tauriInvoke<string[]>("activate_families_on_disk", {
      families: [font.family],
    }).catch(() => [] as string[]);
    if (ready.length) {
      installedCache.add(font.family.toLowerCase());
      await markPreviewLive([font.id]);
      return true;
    }
    const added = await tauriInvoke<number>("start_google_downloads", {
      families: [font.family],
    }).catch(() => 0);
    startGooglePoll("download");
    if (!added) {
      const again = await tauriInvoke<string[]>("activate_families_on_disk", {
        families: [font.family],
      }).catch(() => [] as string[]);
      if (again.length) {
        installedCache.add(font.family.toLowerCase());
        await markPreviewLive([font.id]);
      }
    }
    return true;
  }
  const ready = await tauriInvoke<string[]>("activate_families_on_disk", {
    families: [font.family],
  }).catch(() => [] as string[]);
  if (ready.length) {
    installedCache.add(font.family.toLowerCase());
    await markPreviewLive([font.id]);
    return true;
  }
  job = {
    running: true,
    paused: false,
    mode: "download",
    done: job.mode === "download" ? job.done : 0,
    total: (job.mode === "download" ? job.total : 0) + 1,
    failed: job.mode === "download" ? job.failed : 0,
    skipped: job.mode === "download" ? job.skipped : 0,
    current: font.family,
    failedNames: job.mode === "download" ? job.failedNames : [],
    failedDetails: job.mode === "download" ? job.failedDetails : [],
  };
  emit();
  installQueue.push({ font, lean: false });
  kickInstall();
  return true;
}

export async function uninstallFontOnSystem(font: FontRecord): Promise<void> {
  if (font.source === "system") return;
  if (!(await inDesktopShell())) return;
  if (job.running && job.mode === "download") {
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
    }
    return;
  }
  unlockUi();
  if (!on) {
    const names = fonts.map((font) => font.family);
    const steal = !(job.running && job.mode === "download");
    if (steal) {
      job = {
        running: true,
        paused: false,
        mode: "remove",
        done: 0,
        total: names.length,
        failed: 0,
        skipped: 0,
        current: names[0] ?? "",
        failedNames: [],
        failedDetails: [],
      };
      markJobClock(true, false);
      emit();
    }
    try {
      await tauriInvoke<number>("unload_font_families", { families: names });
      for (const font of fonts) installedCache.delete(font.family.toLowerCase());
      if (steal) startGooglePoll("remove");
    } catch {
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
    if (!(job.running && job.mode === "download")) {
      job = {
        running: true,
        paused: false,
        mode: "download",
        done: 0,
        total: names.length,
        failed: 0,
        skipped: 0,
        current: "Scanning Documents…",
        failedNames: [],
        failedDetails: [],
      };
      markJobClock(true, false);
      emit();
    }
    toast.message("Scanning Documents first", {
      description: `${names.length.toLocaleString()} families. Intact files register only; missing files download up to three at a time.`,
    });
    const added = await tauriInvoke<number>("start_google_downloads", { families: names }).catch(() => 0);
    startGooglePoll("download");
    if (!added) {
      const ready = await tauriInvoke<string[]>("activate_families_on_disk", { families: names }).catch(
        () => [] as string[],
      );
      if (ready.length) {
        for (const name of ready) installedCache.add(name.toLowerCase());
        applyReadyFamilies(ready);
        toast.message("Already on disk", {
          description: `${ready.length.toLocaleString()} intact ${ready.length === 1 ? "family" : "families"} — registered, not fetched again.`,
        });
      }
    }
  }
  if (local.length) {
    if (!(job.running && job.mode === "download" && google.length)) {
      job = {
        running: true,
        paused: false,
        mode: "download",
        done: job.mode === "download" ? job.done : 0,
        total: (job.mode === "download" ? job.total : 0) + local.length,
        failed: job.mode === "download" ? job.failed : 0,
        skipped: job.mode === "download" ? job.skipped : 0,
        current: local[0]?.family ?? "",
        failedNames: job.mode === "download" ? job.failedNames : [],
        failedDetails: job.mode === "download" ? job.failedDetails : [],
      };
      markJobClock(true, false);
      emit();
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
