import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const activateRs = readFileSync(join(root, "src-tauri/src/activate.rs"), "utf8");
const mainRs = readFileSync(join(root, "src-tauri/src/main.rs"), "utf8");
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
const readme = readFileSync(join(root, "README.md"), "utf8");
const bugs = readFileSync(join(root, "BUGS.md"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const tauri = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const version = readFileSync(join(root, "src/version.ts"), "utf8");

test("206ae keeps ProductVersion 1.0.206", () => {
  assert.equal(pkg.version, "1.0.207");
  assert.equal(tauri.version, "1.0.207");
  assert.match(version, /1\.0\.207/);
});

test("P0: docs VF emit throttle ≥800ms + every-N dirs", () => {
  assert.match(activateRs, /fn docs_vf_emit_progress_throttle_ms/);
  assert.match(activateRs, /fn docs_vf_emit_every_n_dirs/);
  const throttleBody = activateRs.slice(
    activateRs.indexOf("fn docs_vf_emit_progress_throttle_ms"),
    activateRs.indexOf("fn docs_vf_emit_every_n_dirs"),
  );
  assert.match(throttleBody, /\b9\d{2}\b|\b1000\b|\b800\b/);
  assert.match(activateRs, /docs_vf_emit_throttle_keeps_webview_responsive_contract/);
  assert.match(activateRs, /Refreshing Documents \(/);
  assert.doesNotMatch(
    activateRs.slice(
      activateRs.indexOf("// 1.0.206ae: throttle docs progress"),
      activateRs.indexOf("Ok(finish_docs_vf_sync("),
    ),
    /format!\("Syncing \{name\}"\)/,
  );
});

test("P0: one Cancel button, no pointerdown race", () => {
  assert.doesNotMatch(downloadBar, /onPointerDown|docsChrome \? \(/);
  assert.match(downloadBar, /aria-label=\{docsChrome \? "Cancel Documents refresh"/);
  assert.match(ownership, /Cancel Documents refresh/);
});

test("P0: 206ad keepers — immediate IPC, deferred teardown, honesty", () => {
  const arm = osActivate.slice(
    osActivate.indexOf("function armDocsCancelFromChrome"),
    osActivate.indexOf("export function cancelDownloadQueue"),
  );
  assert.match(arm, /tauriInvoke\("cancel_documents_refresh"\)/);
  assert.match(arm, /setTimeout\(\s*\(\)\s*=>\s*finishDocsCancelTeardown/);
  const sync = osActivate.slice(
    osActivate.indexOf("export async function syncDocumentsVfPolicy"),
    osActivate.indexOf("export async function syncManagedDocumentsRoot"),
  );
  assert.doesNotMatch(
    sync,
    /cancelled\s*=\s*Boolean\(raw\.cancelled\)\s*\|\|\s*docsVfSyncCancelPending/,
  );
  assert.match(activateRs, /purge_redundant_statics_in_dir_cancelable/);
});

test("P1: Escape + tray Cancel Documents refresh", () => {
  assert.match(appShell, /Escape/);
  assert.match(appShell, /cancelDocsVfSyncFromShortcut/);
  assert.match(osActivate, /cancelDocsVfSyncFromShortcut/);
  assert.match(mainRs, /cancel_docs_refresh/);
  assert.match(mainRs, /Cancel Documents refresh/);
  assert.match(mainRs, /cancel_google_downloads/);
});

test("docs mark 206ae; no tip-install/pack", () => {
  assert.match(readme, /1\.0\.206ae/);
  assert.match(bugs, /## Fixed in tip \/ 1\.0\.206ae/);
  assert.match(bugs, /900|throttle|Escape|preventDefault/i);
  assert.match(bugs, /No tip-install\/pack|no tip-install/i);
});
