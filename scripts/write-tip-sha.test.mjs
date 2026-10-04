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
  const { status, body } = stamp({ GITHUB_SHA: "", VITE_FM_BUILD_SHA: "" });
  assert.equal(status, 0);
  assert.match(body, /^sha=[0-9a-f]{40}$/m);
  assert.match(body, /^version=1\.0\.207$/m);
  assert.doesNotMatch(body, /source=no-git/);
  assert.doesNotMatch(body, /sha=unknown/);
});

test("GitHub zip (no .git) exits 0 and does not invent a commit", () => {
  const missing = join(tmpdir(), "font-manager-not-a-git-repo");
  const { status, body, stderr } = stamp({ GIT_DIR: missing, GITHUB_SHA: "", VITE_FM_BUILD_SHA: "" });
  assert.equal(status, 0);
  assert.match(body, /^sha=unknown$/m);
  assert.match(body, /^short=unknown$/m);
  assert.match(body, /^branch=archive$/m);
  assert.match(body, /^source=no-git$/m);
  assert.match(body, /^version=1\.0\.207$/m);
  assert.match(stderr, /no git checkout/i);
  assert.doesNotMatch(body, /sha=[0-9a-f]{7,}/);
});

test("GITHUB_SHA is stamped even when git is missing", () => {
  const missing = join(tmpdir(), "font-manager-not-a-git-repo");
  const sha = "a6dd2bad8829b9e25ddb8000a0a1761690e87525";
  const { status, body } = stamp({ GIT_DIR: missing, GITHUB_SHA: sha, GITHUB_REF_NAME: "", GITHUB_HEAD_REF: "" });
  assert.equal(status, 0);
  assert.match(body, new RegExp(`^sha=${sha}$`, "m"));
  assert.match(body, /^short=a6dd2ba$/m);
  assert.match(body, /^source=github-actions$/m);
  assert.doesNotMatch(body, /source=no-git/);
});

test("VITE_FM_BUILD_SHA local build keeps the real branch and does not claim CI", () => {
  const sha = "26aa48239f4a7101b05bcff2c79daa798a37535b";
  const { status, body } = stamp({ GITHUB_SHA: "", GITHUB_REF_NAME: "", GITHUB_HEAD_REF: "", VITE_FM_BUILD_SHA: sha });
  assert.equal(status, 0);
  assert.match(body, new RegExp(`^sha=${sha}$`, "m"));
  assert.match(body, /^source=env$/m);
  assert.doesNotMatch(body, /github-actions/);
});
