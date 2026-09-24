import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..");
const script = join(root, "scripts/write-tip-sha.mjs");

function stamp(extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tip-sha-"));
  const r = spawnSync(process.execPath, [script, dir], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
  let body = "";
  try {
    body = readFileSync(join(dir, "TIP_SHA.txt"), "utf8");
  } catch {
    body = "";
  }
  rmSync(dir, { recursive: true, force: true });
  return { status: r.status ?? 1, body, stderr: r.stderr || "" };
}

test("git checkout stamps the real HEAD and does not claim no-git", () => {
  const { status, body } = stamp();
  assert.equal(status, 0);
  assert.match(body, /^sha=[0-9a-f]{40}$/m);
  assert.match(body, /^version=1\.0\.207$/m);
  assert.doesNotMatch(body, /source=no-git/);
  assert.doesNotMatch(body, /sha=unknown/);
});

test("GitHub zip (no .git) exits 0 and does not invent a commit", () => {
  const missing = join(tmpdir(), "font-manager-not-a-git-repo");
  const { status, body, stderr } = stamp({ GIT_DIR: missing });
  assert.equal(status, 0);
  assert.match(body, /^sha=unknown$/m);
  assert.match(body, /^short=unknown$/m);
  assert.match(body, /^branch=archive$/m);
  assert.match(body, /^source=no-git$/m);
  assert.match(body, /^version=1\.0\.207$/m);
  assert.match(stderr, /no git checkout/i);
  assert.doesNotMatch(body, /sha=[0-9a-f]{7,}/);
});
