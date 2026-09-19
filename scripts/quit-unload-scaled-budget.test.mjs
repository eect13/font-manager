import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const activateRs = readFileSync(join(root, "src-tauri/src/activate.rs"), "utf8");
const mainRs = readFileSync(join(root, "src-tauri/src/main.rs"), "utf8");
const versionTs = readFileSync(join(root, "src/version.ts"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("1.0.195: version is 1.0.195 (quit unload budget from 1.0.189 kept)", () => {
  assert.equal(pkg.version, "1.0.195");
  assert.match(versionTs, /APP_VERSION\s*=\s*"1\.0\.195"/);
});

test("1.0.189: quit_unload_budget_for scales 15ms/path clamp 12s–180s", () => {
  const fn = activateRs.match(
    /pub fn quit_unload_budget_for\(path_count: usize\) -> Duration \{[\s\S]*?\n\}/,
  );
  assert.ok(fn, "quit_unload_budget_for missing");
  assert.match(fn[0], /saturating_mul\(15\)/);
  assert.match(fn[0], /clamp\(12_000,\s*180_000\)/);
  assert.doesNotMatch(fn[0], /Duration::from_secs\(4\)/);
  assert.doesNotMatch(fn[0], /_path_count/);
});

test("1.0.189: quit_unload_budget_clamps documents Eric 2k/11k reality", () => {
  const testFn = activateRs.match(
    /fn quit_unload_budget_clamps\(\) \{[\s\S]*?\n    \}/,
  );
  assert.ok(testFn, "quit_unload_budget_clamps missing");
  assert.match(testFn[0], /2_099/);
  assert.match(testFn[0], /31_485/);
  assert.match(testFn[0], /from_secs\(165\)/);
  assert.match(testFn[0], /from_secs\(180\)/);
  assert.match(testFn[0], /from_secs\(12\)/);
  assert.doesNotMatch(testFn[0], /assert_eq!\(quit_unload_budget_for\(\d+\), Duration::from_secs\(4\)\)/);
});

test("1.0.189: quit_gracefully hide + worker + scaled watchdog", () => {
  assert.match(mainRs, /fn quit_gracefully/);
  assert.match(mainRs, /win\.hide\(\)/);
  assert.match(mainRs, /activate::session_end/);
  assert.match(mainRs, /quit_unload_budget\(app\)/);
  assert.match(mainRs, /std::process::exit\(0\)/);
  // QUITTING second-launch still exits (no zombie)
  assert.match(mainRs, /if QUITTING\.load\(Ordering::SeqCst\)/);
});

test("1.0.189: session_end Removes stage+loaded; no FontCache on quit path", () => {
  const end = activateRs.match(/pub fn session_end\(app: &AppHandle\) \{[\s\S]*?\n\}/);
  assert.ok(end, "session_end missing");
  assert.match(end[0], /snapshot_stage_paths/);
  assert.match(end[0], /unload_paths/);
  assert.match(end[0], /begin_unload/);
  // Quit intentionally skips FontCache restart (Explorer hang); live Deactivate still flushes.
  assert.doesNotMatch(end[0], /restart_font_cache_service/);
});

test("1.0.188 remnant purge / no FS download still intact", () => {
  assert.match(activateRs, /fn purge_known_incapable_fontsource_remnants/);
  assert.match(activateRs, /Fontsource download skipped/);
});
