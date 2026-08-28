import { toast } from "sonner";
import { inDesktopShell } from "@/lib/desktop/open-fonts";
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

function notifyDownloadResult(done: number, failed: number, names: string[], details: string[]) {
  lastFailedNames = names.slice();
  if (failed > 0 && names.length) {
    const preview = (details.length ? details : names).slice(0, 4).join("; ");
    const extra = names.length > 4 ? ` +${names.length - 4} more` : "";
    toast.error(
      `${names.length} typeface${names.length === 1 ? "" : "s"} failed — tap Retry`,
      {
        description: `${preview}${extra}. Tried jsDelivr + unpkg with cache-bust. Re-upload a TTF if Retry still fails.`,
        duration: 24_000,
        action: {
          label: "Retry",
          onClick: () => void retryFailedDownloads(),
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

function applyReadyFamilies(names: string[]) {
  if (!names.length) return;
  void import("./store").then(({ useFontStore }) => {
    const { googleFonts, localFonts, markLiveActivated } = useFontStore.getState();
    const byFamily = new Map<string, string>();
    for (const font of googleFonts) byFamily.set(font.family.toLowerCase(), font.id);
    for (const font of localFonts) byFamily.set(font.family.toLowerCase(), font.id);
    const ids: string[] = [];
    for (const name of names) {
      const id = byFamily.get(name.trim().toLowerCase());
      if (id) ids.push(id);
    }
    if (ids.length) markLiveActivated(ids);
  });
}

export async function retryFailedDownloads(): Promise<void> {
  if (job.running && job.mode === "download") {
    startGooglePoll();
    toast.message("Download already running", { description: "Wait for it to finish, then Retry if names remain." });
    return;
  }
  const names = (lastFailedNames.length ? lastFailedNames : job.failedNames).slice();
  if (!names.length) {
    toast.message("Nothing to retry", {
      description: "No failed families in this session. Delete files, then Activate again.",
    });
    return;
  }
  const added = await tauriInvoke<number>("retry_google_downloads", { families: names }).catch(
    () => 0,
  );
  if (added) {
    lastFailedNames = [];
    toast.message("Retrying — old files are replaced", {
      description: `${added.toLocaleString()} ${added === 1 ? "family" : "families"}. Corrupt or empty files are overwritten.`,
    });
    startGooglePoll();
    return;
  }
  toast.message("Retry skipped — files already on disk", {
    description:
      names.slice(0, 6).join(", ") +
      (names.length > 6 ? "…" : "") +
      ". Delete the family folder if you want a fresh download.",
  });
}

export async function skipFailedDownloads(): Promise<void> {
  const names = (lastFailedNames.length ? lastFailedNames : job.failedNames).slice();
  if (!names.length) return;
  await tauriInvoke<number>("skip_google_failures", { families: names }).catch(() => 0);
  lastFailedNames = [];
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
  if (added) startGooglePoll();
}

export async function rememberSessionFamilies(families: string[]): Promise<void> {
  if (!(await inDesktopShell())) return;
  try {
    await tauriInvoke("set_session_families", { families });
  } catch {
    /* older installer */
  }
}

export async function listDiskFamilies(): Promise<string[]> {
  if (!(await inDesktopShell())) return [];
  try {
    return (await tauriInvoke<string[]>("list_activated_families")) ?? [];
  } catch {
    return [];
  }
}

export type DiskFamilyInfo = { name: string; bytes: number; files: number; corrupt?: number };

export async function scanDiskFamilies(): Promise<DiskFamilyInfo[]> {
  if (!(await inDesktopShell())) return [];
  try {
    return (await tauriInvoke<DiskFamilyInfo[]>("scan_disk_families")) ?? [];
  } catch {
    return [];
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

function unlockUi() {
  if (typeof document === "undefined") return;
  document.body.style.pointerEvents = "";
  document.documentElement.style.pointerEvents = "";
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

async function refreshInstalledCache() {
  try {
    const names = await tauriInvoke<string[]>("list_activated_families");
    installedCache.clear();
    for (const name of names ?? []) installedCache.add(name.toLowerCase());
  } catch {
    /* first run */
  }
}

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

async function googleTtfFiles(font: FontRecord, _lean: boolean) {
  const slug = slugFamily(font.family);
  const emoji = /emoji/i.test(font.family);
  const weights = emoji
    ? [400]
    : Array.from(new Set(font.weights.length ? font.weights : [400])).sort((a, b) => a - b);
  const styles: Array<"normal" | "italic"> = emoji ? ["normal"] : font.italic ? ["normal", "italic"] : ["normal"];
  const files: { fileName: string; data: Uint8Array }[] = [];
  for (const weight of weights) {
    for (const style of styles) {
      const urls: string[] = [
        `https://cdn.jsdelivr.net/fontsource/fonts/${slug}@latest/latin-${weight}-${style}.ttf`,
        `https://cdn.jsdelivr.net/npm/@fontsource/${slug}/files/${slug}-latin-${weight}-${style}.ttf`,
        `https://unpkg.com/@fontsource/${slug}/files/${slug}-latin-${weight}-${style}.ttf`,
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
      if (data) files.push({ fileName: `${slug}-${weight}-${style}.ttf`, data });
    }
  }
  return files;
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
}) {
  job = {
    running: p.running,
    paused: Boolean(p.paused),
    mode: p.running || p.paused ? "download" : "idle",
    done: p.done,
    total: p.total,
    failed: p.failed,
    skipped: p.skipped ?? 0,
    current: p.current,
    failedNames: p.failed_names ?? [],
    failedDetails: p.failed_details ?? [],
  };
  emit();
  unlockUi();
  if (p.ready_names?.length && p.ready_names.length !== lastReadyCount) {
    lastReadyCount = p.ready_names.length;
    applyReadyFamilies(p.ready_names);
  }
  if (p.running || p.paused) rustSeenRunning = true;
  if (!p.running && !p.paused && pollTimer && (rustSeenRunning || p.skipped || p.ready_names?.length)) {
    window.clearInterval(pollTimer);
    pollTimer = 0;
    rustSeenRunning = false;
    lastReadyCount = 0;
    if (p.ready_names?.length) applyReadyFamilies(p.ready_names);
    notifyDownloadResult(p.done, p.failed, p.failed_names ?? [], p.failed_details ?? []);
    void import("./store").then(({ useFontStore }) => {
      useFontStore.getState().clearPendingActivate();
    });
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
    }>("google_download_progress");
    applyPayload(p);
  } catch {
    /* ignore */
  }
}

let eventsBound = false;
async function bindDownloadEvents() {
  if (eventsBound) return;
  eventsBound = true;
  if (!(await inDesktopShell())) return;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    await listen("font-download", (ev) => {
      applyPayload(ev.payload as Parameters<typeof applyPayload>[0]);
    });
  } catch {
    eventsBound = false;
  }
}

function startGooglePoll() {
  void bindDownloadEvents();
  if (pollTimer) return;
  rustSeenRunning = false;
  pollTimer = window.setInterval(() => void pollRustProgress(), 800);
  void pollRustProgress();
}

function paint(force = false) {
  const now = Date.now();
  if (!force && now - lastPaint < 400) return;
  lastPaint = now;
  emit();
}

function finishIfIdle() {
  if (installQueue.length || removeQueue.length || workers > 0) return;
  const snapshot = { ...job, running: false, mode: "idle" as const, current: "" };
  job = snapshot;
  emit();
  unlockUi();
  if (snapshot.total > 0 && snapshot.done + snapshot.failed > 0) {
    notifyDownloadResult(snapshot.done, snapshot.failed, snapshot.failedNames, snapshot.failedDetails);
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
  job = { ...EMPTY };
  emit();
  unlockUi();
  void tauriInvoke("cancel_google_downloads").catch(() => undefined);
  if (pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = 0;
    rustSeenRunning = false;
  }
  toast.message("Background download stopped", {
    description: "Fonts already saved stay in Documents → Font Manager.",
  });
  void import("./store").then(({ useFontStore }) => {
    useFontStore.getState().clearPendingActivate();
  });
}

export function pauseDownloadQueue() {
  job = { ...job, paused: true, running: true, mode: "download" };
  emit();
  void tauriInvoke("pause_google_downloads").catch(() => undefined);
  toast.message("Download paused", { description: "Resume anytime. Files already saved stay put." });
}

export function resumeDownloadQueue() {
  job = { ...job, paused: false, running: true, mode: "download" };
  emit();
  void tauriInvoke("resume_google_downloads").catch(() => undefined);
  startGooglePoll();
  toast.message("Download resumed");
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

let webPreviewTold = false;

function tellWebPreview() {
  if (webPreviewTold) return;
  webPreviewTold = true;
  toast.message("Browser preview — files stay on Google’s servers", {
    description: "This window loads CSS only. Use the desktop app to download TTFs into Documents and register them for Word or Adobe.",
    duration: 12_000,
  });
}

async function markPreviewLive(ids: string[]) {
  if (!ids.length) return;
  const { useFontStore } = await import("./store");
  useFontStore.getState().markLiveActivated(ids);
}

export async function installFontOnSystem(font: FontRecord): Promise<boolean> {
  if (!(await inDesktopShell())) {
    await markPreviewLive([font.id]);
    const { loadFont } = await import("./loader");
    void loadFont(font, "full");
    tellWebPreview();
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
  if (font.source === "google") {
    await tauriInvoke<number>("start_google_downloads", {
      families: [font.family],
    }).catch(() => 0);
    startGooglePoll();
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
  if (!(await inDesktopShell())) return;
  removeQueue.push(font);
  void pumpRemove(batchId);
}

export async function deleteFontFiles(font: FontRecord): Promise<void> {
  if (!(await inDesktopShell())) return;
  try {
    await tauriInvoke("uninstall_font_family", { family: font.family });
    installedCache.delete(font.family.toLowerCase());
  } catch {
    /* ignore */
  }
}

export const removeUploadFromDisk = deleteFontFiles;

export async function syncFontOnSystem(font: FontRecord, on: boolean): Promise<void> {
  if (on) await installFontOnSystem(font);
  else await uninstallFontOnSystem(font);
}

export async function syncFontsOnSystem(fonts: FontRecord[], on: boolean): Promise<void> {
  if (!fonts.length) return;
  if (!(await inDesktopShell())) {
    if (on) {
      await markPreviewLive(fonts.map((font) => font.id));
      const { loadFont } = await import("./loader");
      for (const font of fonts.slice(0, 24)) void loadFont(font, "full");
      tellWebPreview();
    }
    return;
  }
  unlockUi();
  if (!on) {
    const names = fonts.map((font) => font.family);
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
    emit();
    try {
      const n = await tauriInvoke<number>("unload_font_families", { families: names }).catch(() => 0);
      for (const font of fonts) installedCache.delete(font.family.toLowerCase());
      job = {
        ...EMPTY,
        done: n || names.length,
        total: names.length,
      };
      emit();
      toast.success(
        `Deactivated ${names.length.toLocaleString()} — files kept in Documents`,
      );
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
    toast.message("Scanning Documents first", {
      description: `${names.length.toLocaleString()} families. Intact files are registered, not re-downloaded.`,
    });
    const plan = await tauriInvoke<{ ready: string[]; missing: string[] }>("plan_google_activation", {
      families: names,
    }).catch(() => null);
    const onDisk = plan?.ready ?? [];
    const missing = plan?.missing ?? names;
    if (onDisk.length) {
      const ready = await tauriInvoke<string[]>("activate_families_on_disk", { families: onDisk }).catch(
        () => onDisk,
      );
      if (ready.length) {
        for (const name of ready) installedCache.add(name.toLowerCase());
        applyReadyFamilies(ready);
      }
    }
    if (missing.length) {
      const added = await tauriInvoke<number>("start_google_downloads", { families: missing }).catch(() => 0);
      if (added) startGooglePoll();
    } else {
      toast.message("Already on disk", {
        description: `${onDisk.length.toLocaleString()} intact ${onDisk.length === 1 ? "family" : "families"} — registered, not fetched again.`,
      });
    }
  }
  if (local.length) {
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
