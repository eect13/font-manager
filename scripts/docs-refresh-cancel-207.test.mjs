import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const activateRs = readFileSync(new URL("../src-tauri/src/activate.rs", import.meta.url), "utf8");
const mainRs = readFileSync(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");
const cargo = readFileSync(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8");
const caps = readFileSync(new URL("../src-tauri/capabilities/default.json", import.meta.url), "utf8");
const acl = readFileSync(new URL("../src-tauri/permissions/font-activate.toml", import.meta.url), "utf8");
const os = readFileSync(new URL("../src/lib/fonts/os-activate.ts", import.meta.url), "utf8");
const bar = readFileSync(new URL("../src/components/font-studio/download-bar.tsx", import.meta.url), "utf8");
const shell = readFileSync(new URL("../src/components/font-studio/app-shell.tsx", import.meta.url), "utf8");
const ownership = readFileSync(new URL("../src/lib/fonts/docs-vf-sync-ownership.mjs", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const version = readFileSync(new URL("../src/version.ts", import.meta.url), "utf8");

test("1.0.207 version pins", () => {
  assert.equal(pkg.version, "1.0.207");
  assert.match(version, /APP_VERSION = "1\.0\.207"/);
  assert.match(cargo, /version = "1\.0\.207"/);
});

test("docs refresh uses its own cancel flag, not Activate cancel", () => {
  assert.match(activateRs, /docs_cancel:\s*AtomicBool/);
  const work = activateRs.slice(activateRs.indexOf("fn sync_documents_vf_policy_work"));
  const workBody = work.slice(0, work.indexOf("fn finish_docs_vf_sync"));
  assert.match(workBody, /state\.docs_cancel/);
  assert.doesNotMatch(workBody, /state\.cancel\.load/);
  assert.match(workBody, /purge_redundant_statics_in_dir_cancelable\([\s\S]*docs_cancel/);
});

test("Activate cancel does not pretend to be a Documents refresh", () => {
  const fn = activateRs.slice(activateRs.indexOf("pub async fn cancel_google_downloads"));
  const body = fn.slice(0, fn.indexOf("pub fn drop_google_download_families"));
  assert.doesNotMatch(body, /docs-vf-cancel-requested/);
  assert.match(body, /docs_vf_session_live/);
  assert.match(body, /Stopping…/);
});

test("no system-wide Escape shortcut", () => {
  assert.doesNotMatch(cargo, /tauri-plugin-global-shortcut/);
  assert.doesNotMatch(mainRs, /global_shortcut/);
  assert.doesNotMatch(caps, /global-shortcut/);
  assert.doesNotMatch(activateRs, /docs_vf_register_escape|global_shortcut/);
  assert.doesNotMatch(mainRs, /Some\("Esc"\)/);
});

test("Cancel button invokes cancel_documents_refresh only", () => {
  assert.match(acl, /cancel_documents_refresh/);
  assert.match(mainRs, /cancel_documents_refresh/);
  assert.match(activateRs, /pub async fn cancel_documents_refresh/);
  assert.match(os, /tauriInvoke\("cancel_documents_refresh"\)/);
  const arm = os.slice(os.indexOf("function armDocsCancelFromChrome"));
  const armBody = arm.slice(0, arm.indexOf("export function cancelDownloadQueue"));
  assert.match(armBody, /cancel_documents_refresh/);
  assert.doesNotMatch(armBody, /cancel_google_downloads|bumpDocsCancelSeqInDom/);
  assert.doesNotMatch(os, /data-fm-cancel-seq|getDocsCancelSeq|bumpDocsCancelSeqInDom/);
  assert.match(bar, /fromDocsCancelChrome: true/);
  assert.doesNotMatch(bar, /onPointerDown|onMouseDown|data-fm-cancel-seq|aria-labelledby/);
});

test("docs cancel does not abort a later Activate walk", () => {
  const walk = activateRs.slice(activateRs.indexOf("fn for_family_dirs"));
  const walkBody = walk.slice(0, walk.indexOf("/// LocalAppData"));
  assert.match(walkBody, /docs_vf_session_live/);
  assert.match(walkBody, /docs_cancel/);
  assert.match(activateRs, /fn docs_vf_session_end[\s\S]{0,280}docs_cancel\.store\(false/);
});

test("library is not hidden during refresh; Escape ignores text fields", () => {
  assert.match(ownership, /return false/);
  assert.match(shell, /HTMLInputElement/);
  assert.match(shell, /cancelDocsVfSyncFromShortcut/);
});
