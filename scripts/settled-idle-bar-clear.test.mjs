import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const osActivate = readFileSync(join(root, "src/lib/fonts/os-activate.ts"), "utf8");
const downloadBar = readFileSync(join(root, "src/components/font-studio/download-bar.tsx"), "utf8");

/**
 * Mirror of applyPayload current merge (1.0.187):
 * empty Rust clear must stick — never `p.current || job.current`.
 */
function mergeCurrent(pCurrent, _jobCurrent) {
  return pCurrent ?? "";
}

test("applyPayload empty current clears (not sticky || job.current)", () => {
  assert.equal(mergeCurrent("", "Registering Zilla Slab"), "");
  assert.equal(mergeCurrent("Registering Nunito", "Registering Zilla Slab"), "Registering Nunito");
  assert.equal(mergeCurrent(undefined, "stale"), "");
  assert.equal(mergeCurrent(null, "stale"), "");
  // Legacy bug: empty || stale kept "Registering …" after rustIdle finish.
  assert.notEqual("" || "Registering Zilla Slab", "");
});

test("os-activate: empty-clear current + dismissDownloadBar (no sticky ||)", () => {
  assert.doesNotMatch(osActivate, /current:\s*p\.current\s*\|\|\s*job\.current/);
  assert.match(osActivate, /current:\s*p\.current\s*\?\?\s*""/);
  assert.match(osActivate, /export function dismissDownloadBar/);
  assert.match(osActivate, /job = \{ \.\.\.EMPTY \}/);
});

test("download-bar: settledIdle Done + Dismiss + 16s auto-hide", () => {
  assert.match(downloadBar, /settledIdle\s*\?\s*"Done"/);
  assert.match(downloadBar, /dismissDownloadBar/);
  assert.match(downloadBar, /Dismiss/);
  assert.match(downloadBar, /SETTLED_IDLE_AUTO_HIDE_MS\s*=\s*16_000/);
  assert.match(downloadBar, /!settledIdle/);
});
