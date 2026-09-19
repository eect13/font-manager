import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bytesNearlySame, countByteDiffs } from "../src/lib/fonts/binary-diff.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("word-stride diff: identical, name-patch, unlike", () => {
  const a = new Uint8Array(1024);
  a.fill(7);
  const b = new Uint8Array(a);
  assert.equal(countByteDiffs(a, b), 0);
  assert.equal(bytesNearlySame(a, b).near, true);
  b[100] = 8;
  b[101] = 9;
  assert.equal(countByteDiffs(a, b), 2);
  assert.equal(bytesNearlySame(a, b).near, true);
  const c = new Uint8Array(1024);
  c.fill(1);
  assert.ok(countByteDiffs(a, c, 128) > 128);
  assert.equal(bytesNearlySame(a, c).near, false);
});

test("unaligned subarray still counts", () => {
  const raw = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  const a = raw.subarray(1, 8);
  const b = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
  assert.equal(countByteDiffs(a, b), 0);
  b[3] = 99;
  assert.equal(countByteDiffs(a, b), 1);
});

test("source: Uint32 stride, no WebGPU/harfbuzz renderer", () => {
  const diff = readFileSync(join(root, "src/lib/fonts/binary-diff.ts"), "utf8");
  assert.match(diff, /new Uint32Array/);
  const policy = readFileSync(join(root, "src/lib/fonts/wasm-parse.ts"), "utf8");
  assert.match(policy, /WebGPU/);
  assert.match(policy, /does \*\*not\*\* AddFontResourceExW/);
  assert.doesNotMatch(diff, /navigator\.gpu|createShaderModule/);
});
