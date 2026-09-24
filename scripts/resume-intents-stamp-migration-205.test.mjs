import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const activateRs = readFileSync(join(root, "src-tauri/src/activate.rs"), "utf8");
const osActivate = readFileSync(join(root, "src/lib/fonts/os-activate.ts"), "utf8");
const storeTs = readFileSync(join(root, "src/lib/fonts/store.ts"), "utf8");
const hydrateTs = readFileSync(join(root, "src/lib/fonts/hydrate.ts"), "utf8");
const toggleTs = readFileSync(join(root, "src/components/font-studio/activate-toggle.tsx"), "utf8");
const version = readFileSync(join(root, "src/version.ts"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("version is 1.0.206", () => {
  assert.equal(pkg.version, "1.0.207");
  assert.match(version, /1\.0\.207/);
});

test("resumeGoogleFamilies passes parallel intents (never infer-only)", () => {
  const start = osActivate.indexOf("export async function resumeGoogleFamilies");
  const fn = osActivate.slice(start, start + 2800);
  assert.match(fn, /intents/);
  assert.match(fn, /fetchIntentFor/);
  assert.match(fn, /start_google_downloads/);
  assert.match(fn, /families:\s*resumeFamilies|families:\s*missing/);
  assert.match(fn, /resolve_family_fetch_intent|GOOGLE_FONTS/);
  assert.match(fn, /intents/);
});

test("stamp migration helper + scan/activate hooks", () => {
  assert.match(activateRs, /fn migrate_download_source_stamp/);
  assert.match(activateRs, /migrate_download_source_stamp\(dir\)/);
  assert.match(activateRs, /migrate_download_source_stamp\(&dir\)/);
  assert.match(activateRs, /fn migrate_download_source_stamp_google_planned/);
  assert.match(activateRs, /fn migrate_download_source_stamp_leaves_ambiguous_unset/);
  // Never guess google on ambiguous folders.
  assert.match(activateRs, /ambiguous folder must stay unset/);
});

test("Activate All speed: skip Settled, soft confirm, waves, visible-first", () => {
  assert.match(toggleTs, /settledFamilySet/);
  assert.match(toggleTs, /usable\.length > 50/);
  assert.match(toggleTs, /activateInWaves|ACTIVATE_WAVE/);
  assert.match(toggleTs, /ActivateVisibleMenuItem/);
  assert.match(toggleTs, /orderActivateIds|visibleFamilySet/);
  assert.match(storeTs, /settledFamilySet/);
  assert.match(storeTs, /Activate All must not queue Settled/);
});

test("already-Live short-circuit kept (204 feel)", () => {
  assert.match(activateRs, /family_skip_register_this_process/);
  assert.match(storeTs, /familyAlreadyLiveOrPending/);
});

test("visible-first restore includes viewport families", () => {
  assert.match(hydrateTs, /visibleFamilyNames/);
  // 1.0.205 Visible-first; 1.0.206l expands to prefer waves (favorites + first-page).
  assert.match(hydrateTs, /Visible-first|1\.0\.206l prefer waves/);
});

test("pending-off timeout keeps Live honest — never fake Off", () => {
  assert.match(storeTs, /PENDING_OFF_TIMEOUT_MS/);
  assert.match(storeTs, /armPendingOffTimeout/);
  assert.match(storeTs, /unloadStuckIds/);
  assert.match(storeTs, /Still unloading/);
  // confirmDeactivated clears stuck + timers
  assert.match(storeTs, /clearPendingOffTimeout/);
});

test("register progress owner separate from download", () => {
  assert.match(activateRs, /p\.kind = "register"/);
});

test("204 hard separation still present", () => {
  assert.match(activateRs, /enum FetchIntent/);
  assert.match(activateRs, /fn face_allowed_for_register/);
  assert.match(activateRs, /\.download-source/);
  assert.match(osActivate, /export function fetchIntentFor/);
});
