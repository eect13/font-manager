import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const activateRs = readFileSync(join(root, "src-tauri/src/activate.rs"), "utf8");
const hydrateTs = readFileSync(join(root, "src/lib/fonts/hydrate.ts"), "utf8");
const osActivate = readFileSync(join(root, "src/lib/fonts/os-activate.ts"), "utf8");
const downloadBar = readFileSync(join(root, "src/components/font-studio/download-bar.tsx"), "utf8");

/**
 * Mirror hydrate progressive rule (1.0.190): boot.ready ⇒ Live even when !boot.done.
 * Sidecar ignored until boot.done if boot.ready is empty.
 */
function progressiveLive(bootReady, bootDone, sessionNames) {
  if (bootReady?.length) return bootReady.slice();
  if (bootDone) return sessionNames.slice();
  return [];
}

/** Settled known-incapable must not enter Add queue. */
function partitionRestoreTargets(ready, earlySkip) {
  const targets = [];
  const settled = [];
  for (const f of ready) {
    if (earlySkip(f)) settled.push(f);
    else targets.push(f);
  }
  return { targets, settled };
}

function shouldThrottleEmit(elapsedMs, throttleMs, force, idle) {
  if (force || idle) return false;
  return elapsedMs < throttleMs;
}

test("1.0.190: progressive Live from boot.ready before boot.done", () => {
  assert.deepEqual(progressiveLive(["Nunito"], false, ["Nunito", "Gidugu"]), ["Nunito"]);
  assert.deepEqual(progressiveLive([], false, ["Nunito", "Gidugu"]), []);
  assert.deepEqual(progressiveLive([], true, ["Nunito"]), ["Nunito"]);
  assert.deepEqual(progressiveLive(["A", "B"], false, ["A", "B", "Gidugu"]), ["A", "B"]);
});

test("1.0.190: hydrate waits with onReady callback — not boot.done-only Live", () => {
  assert.match(hydrateTs, /waitSessionBoot\(180_000,\s*\(readyChunk/);
  assert.match(hydrateTs, /restoreActivation\(live,\s*\[\]\)/);
  assert.match(hydrateTs, /progressive Live/);
  assert.match(osActivate, /onReady\?:\s*\(ready: string\[\], done: boolean\) => void/);
  // Must not gate ready on boot.done alone anymore.
  assert.doesNotMatch(hydrateTs, /const bootReady = boot\.done \? boot\.ready : \[\]/);
});

test("1.0.190: Settled known-incapable never queued for Add", () => {
  const { targets, settled } = partitionRestoreTargets(
    ["Nunito", "Gidugu", "Roboto"],
    (f) => f === "Gidugu",
  );
  assert.deepEqual(targets, ["Nunito", "Roboto"]);
  assert.deepEqual(settled, ["Gidugu"]);
  assert.match(activateRs, /fn partition_session_restore_targets/);
  assert.match(activateRs, /family_early_skip_known_incapable/);
  assert.match(activateRs, /partition_session_restore_targets\(app, &ready_all\)/);
});

test("1.0.190: emit_progress throttled; idle/force always emit", () => {
  assert.equal(shouldThrottleEmit(100, 350, false, false), true);
  assert.equal(shouldThrottleEmit(400, 350, false, false), false);
  assert.equal(shouldThrottleEmit(0, 350, true, false), false);
  assert.equal(shouldThrottleEmit(0, 350, false, true), false);
  assert.match(activateRs, /fn emit_progress_throttled/);
  assert.match(activateRs, /fn emit_progress_force/);
  assert.match(activateRs, /emit_progress_throttle_ms\(\) -> u64/);
  assert.match(activateRs, /350/);
});

test("1.0.190: Restoring chrome + session_boot_push_ready", () => {
  assert.match(activateRs, /session_boot_push_ready/);
  assert.match(activateRs, /Restoring \{\}\/\{\}/);
  assert.match(downloadBar, /restoring && job\.running/);
  assert.match(downloadBar, /Restoring \$\{processed/);
  assert.match(downloadBar, /session GDI restore/);
});

test("1.0.190 HOLD: maps still skip-copy only; no fake Activated from maps", () => {
  assert.match(activateRs, /Do NOT hydrate loaded\(\) from gdi-maps/);
  assert.match(activateRs, /maps skip copy only/);
});
