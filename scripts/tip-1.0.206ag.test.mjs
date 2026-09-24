import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const activateRs = readFileSync(join(root, "src-tauri/src/activate.rs"), "utf8");
const mainRs = readFileSync(join(root, "src-tauri/src/main.rs"), "utf8");
const cargo = readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8");
const caps = readFileSync(join(root, "src-tauri/capabilities/default.json"), "utf8");
const osActivate = readFileSync(join(root, "src/lib/fonts/os-activate.ts"), "utf8");
const downloadBar = readFileSync(
  join(root, "src/components/font-studio/download-bar.tsx"),
  "utf8",
);
const appShell = readFileSync(
  join(root, "src/components/font-studio/app-shell.tsx"),
  "utf8",
);
const ownership = readFileSync(
  join(root, "src/lib/fonts/docs-vf-sync-ownership.mjs"),
  "utf8",
);
const {
  cancelToastKind,
  isDocsRefreshJobCurrent,
} = await import(pathToFileURL(join(root, "src/lib/fonts/docs-vf-sync-ownership.mjs")).href);
const readme = readFileSync(join(root, "README.md"), "utf8");
const bugs = readFileSync(join(root, "BUGS.md"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const tauri = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const version = readFileSync(join(root, "src/version.ts"), "utf8");

test("206ag keeps ProductVersion 1.0.206", () => {
  assert.equal(pkg.version, "1.0.207");
  assert.equal(tauri.version, "1.0.207");
  assert.match(version, /1\.0\.207/);
});

test("1.0.207 removed the system-wide Escape shortcut", () => {
  assert.doesNotMatch(cargo, /tauri-plugin-global-shortcut/);
  assert.doesNotMatch(caps, /global-shortcut:allow-register/);
  assert.doesNotMatch(mainRs, /tauri_plugin_global_shortcut|Code::Escape|Some\("Esc"\)/);
  assert.match(mainRs, /request_docs_vf_cancel_native/);
  assert.match(mainRs, /cancel_docs_refresh/);
  assert.doesNotMatch(activateRs, /docs_vf_register_escape|global_shortcut/);
  assert.match(activateRs, /docs_cancel/);
});

test("P0: Gate D cancelled toast ownership — Activate Stopping ≠ documents-refresh", () => {
  assert.equal(isDocsRefreshJobCurrent("Stopping…"), false);
  assert.notEqual(
    cancelToastKind({
      docsVfSyncActive: false,
      docsVfSyncCancelPending: false,
      current: "Stopping…",
    }),
    "documents-refresh",
  );
  assert.equal(
    cancelToastKind({
      docsVfSyncActive: false,
      docsVfSyncCancelPending: false,
      current: "Stopping…",
    }),
    "download",
  );
  assert.equal(
    cancelToastKind({
      docsVfSyncActive: false,
      docsVfSyncCancelPending: true,
      current: "Stopping…",
    }),
    "documents-refresh",
  );
  assert.doesNotMatch(ownership, /\|stopping/i);
  // Callers toast exact Gate D PASS string
  assert.match(
    readFileSync(join(root, "src/components/font-studio/activate-toggle.tsx"), "utf8"),
    /Documents refresh cancelled/,
  );
});

test("P0: in-window Cancel, library stays visible", () => {
  assert.match(downloadBar, /Cancel Documents refresh/);
  assert.doesNotMatch(downloadBar, /aria-labelledby|fm-cancel-documents-refresh-label/);
  assert.match(ownership, /return false/);
  assert.match(appShell, /HTMLInputElement/);
  assert.match(osActivate, /docsVfSyncSessionLive/);
});

test("P0: keep 206af sessionLive + tray emit + 206ae throttle + 206ad IPC", () => {
  assert.match(osActivate, /docs-vf-cancel-requested/);
  assert.match(activateRs, /docs_vf_emit_progress_throttle_ms/);
  assert.match(activateRs, /\b900\b/);
  assert.match(activateRs, /purge_redundant_statics_in_dir_cancelable/);
  const arm = osActivate.slice(
    osActivate.indexOf("function armDocsCancelFromChrome"),
    osActivate.indexOf("export function cancelDownloadQueue"),
  );
  assert.match(arm, /tauriInvoke\("cancel_documents_refresh"\)/);
  assert.match(arm, /setTimeout\(\s*\(\)\s*=>\s*finishDocsCancelTeardown/);
});

test("docs mark 206ag; no tip-install/pack", () => {
  assert.match(readme, /1\.0\.206ag/);
  assert.match(bugs, /## Fixed in tip \/ 1\.0\.206ag/);
  assert.match(bugs, /global.shortcut|native Escape|SendKeys/i);
  assert.match(bugs, /No tip-install\/pack|no tip-install/i);
});
