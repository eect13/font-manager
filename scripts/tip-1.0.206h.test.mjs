import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const activateToggle = readFileSync(
  join(root, "src/components/font-studio/activate-toggle.tsx"),
  "utf8",
);
const confirmDlg = readFileSync(
  join(root, "src/components/font-studio/activate-confirm-dialog.tsx"),
  "utf8",
);
const downloadBar = readFileSync(
  join(root, "src/components/font-studio/download-bar.tsx"),
  "utf8",
);
const osActivate = readFileSync(join(root, "src/lib/fonts/os-activate.ts"), "utf8");
const activateRs = readFileSync(join(root, "src-tauri/src/activate.rs"), "utf8");
const grokPwaTest = readFileSync(join(root, "scripts/grok-pwa-plugin.test.mjs"), "utf8");
const writeAtomicTest = readFileSync(join(root, "scripts/write-atomic.test.mjs"), "utf8");
const version = readFileSync(join(root, "src/version.ts"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const readme = readFileSync(join(root, "README.md"), "utf8");
const bugs = readFileSync(join(root, "BUGS.md"), "utf8");

test("206h keeps ProductVersion 1.0.206 (amend-style)", () => {
  assert.equal(pkg.version, "1.0.206");
  assert.match(version, /1\.0\.206/);
});

test("P1 remaining count uses same filter as activateSet queue", () => {
  // 1.0.206i: activateQueueIds lives in shared activate-queue.mjs; toggle re-exports + uses it.
  assert.match(activateToggle, /activate-queue\.mjs/);
  assert.match(activateToggle, /export \{ activateQueueIds/);
  assert.match(activateToggle, /const usable = activateQueueIds\(ids, state\)/);
  assert.match(activateToggle, /activateQueueIds\(ids, s\)\.length/);
  assert.match(activateToggle, /catalogMenuStats\(/);
  assert.match(activateToggle, /catalogMenuRemaining/);
  // Visible path / hard-skip still referenced in toggle; Settled filter in shared module.
  assert.match(activateToggle, /settledFamilySet\.has\(font\.family/);
  assert.match(activateToggle, /isKnownGdiSessionIncapable\(font\.family\)/);
  const queueMod = readFileSync(join(root, "src/lib/fonts/activate-queue.mjs"), "utf8");
  assert.match(queueMod, /settledFamilySet/);
  assert.match(queueMod, /gidugu/i);
  // Library remaining also goes through activateQueueIds
  const libStart = activateToggle.indexOf("export function LibraryActivateMenuItem");
  const lib = activateToggle.slice(libStart, libStart + 1200);
  assert.match(lib, /activateQueueIds\(ids, s\)\.length/);
});

test("P1 start_google_downloads skips when resolve None and no explicit intent", () => {
  const start = activateRs.indexOf("pub fn start_google_downloads");
  const body = activateRs.slice(start, start + 2000);
  assert.match(body, /None => continue/);
  assert.doesNotMatch(body, /unwrap_or_else\(\|\| infer_fetch_intent\(family\)\)/);
  assert.match(body, /resolve_fetch_intent_from_disk/);
  assert.match(body, /never infer_fetch_intent after resolve None|never blind-infer/i);
});

test("P1 OG tests isolate cwd site.json / og.jpg pollution", () => {
  assert.match(grokPwaTest, /ISOLATED_CWD/);
  assert.match(grokPwaTest, /cwd: ctx\.cwd \?\? ISOLATED_CWD/);
  assert.match(grokPwaTest, /stamps card=custom onto an explicit site without card/);
  assert.match(writeAtomicTest, /no write-atomic stage|direct public\/ writes/);
});

test("P2 Deactivate anyOn includes pendingDeactivateSet; desktop queue toast", () => {
  const start = activateToggle.indexOf("export function DeactivateMenuItem");
  const body = activateToggle.slice(start, start + 500);
  assert.match(body, /pendingDeactivateSet\.has\(id\)/);
  assert.match(activateToggle, /Queuing \$\{pendingOff\.toLocaleString\(\)\} off in/);
  assert.match(activateToggle, /Remove bar tracks unload/);
});

test("P2 finish toast Live = activated.length only", () => {
  assert.match(osActivate, /liveCount = activated\.length/);
  assert.doesNotMatch(
    osActivate,
    /Math\.max\(0, skipped, done - failed - settled\)/,
  );
  assert.doesNotMatch(osActivate, /activated\.length \|\| live/);
});

test("P2 short confirm Cancel labels; OK/Abort semantics kept", () => {
  assert.match(confirmDlg, /OK = all/);
  assert.match(confirmDlg, /Abort/);
  assert.match(confirmDlg, /Cancel · keep first/);
  assert.match(confirmDlg, /Cancel · visible/);
  assert.match(confirmDlg, /Cancel · first page/);
});

test("P2 remove-mode Pause/Cancel on download bar", () => {
  const start = downloadBar.indexOf("{job.running || job.paused ? (");
  const body = downloadBar.slice(start, start + 900);
  assert.match(body, /pauseDownloadQueue/);
  assert.match(body, /cancelDownloadQueue/);
  assert.doesNotMatch(body, /job\.mode !== "remove"/);
  assert.match(osActivate, /Deactivate cancelled/);
});

test("docs mark 206h; session restore prefer landed 206l (not soft-deferred)", () => {
  assert.match(readme, /1\.0\.206h/);
  assert.match(bugs, /1\.0\.206h/);
  // 1.0.206n hygiene: do not soft-pass on "Deferred P1 (landed 1.0.206l)" wording.
  assert.match(bugs, /session restore prefer landed 206l|Landed 1\.0\.206l.*prefer waves/i);
  assert.doesNotMatch(
    bugs,
    /Deferred \(still\): session restore prefer visible\/favorites\/first-page/,
  );
});

test("no reopen: Live=Add>0 / Gidugu-hard / Soft Retry / modal wave0 / Google↔FS", () => {
  assert.match(activateRs, /KNOWN_GDI_SESSION_INCAPABLE/);
  const hard = activateRs.slice(
    activateRs.indexOf("const KNOWN_GDI_SESSION_INCAPABLE"),
    activateRs.indexOf("const KNOWN_GDI_SESSION_INCAPABLE") + 500,
  );
  assert.match(hard, /Gidugu/);
  assert.doesNotMatch(hard, /Noto Color Emoji|Noto Emoji/);
  assert.match(activateRs, /\.settled-add-zero/);
  assert.match(activateToggle, /splitPreferRemainder/);
  assert.match(confirmDlg, /Abort/);
});
