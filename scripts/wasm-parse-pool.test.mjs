import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  LAYOUT_IPC_MAX_BYTES,
  PARSE_WORKER_MAX,
  parseWorkerCount,
  shouldUseIpcCmap,
  shouldUseIpcLayout,
} from "../src/lib/fonts/wasm-parse.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("parse worker pool size is 1..4", () => {
  assert.equal(PARSE_WORKER_MAX, 4);
  assert.equal(parseWorkerCount(1), 1);
  assert.equal(parseWorkerCount(8), 4);
  assert.equal(parseWorkerCount(0), 1);
  assert.equal(parseWorkerCount(-3), 1);
});

test("IPC layout allows 8MB Uint8Array, cmap stays 180KB", () => {
  assert.equal(LAYOUT_IPC_MAX_BYTES, 8_000_000);
  assert.equal(shouldUseIpcLayout(180_001), true);
  assert.equal(shouldUseIpcLayout(8_000_001), false);
  assert.equal(shouldUseIpcCmap(180_000), true);
  assert.equal(shouldUseIpcCmap(180_001), false);
});

test("source: transferable buffer pool, no Array.from bytes, no File post", () => {
  const pool = readFileSync(join(root, "src/lib/fonts/parse-pool.ts"), "utf8");
  assert.match(pool, /parseWorkerCount/);
  assert.match(pool, /postMessage\(\{ id, name: file\.name, size: file\.size, buffer \}, \[buffer\]\)/);
  assert.doesNotMatch(pool, /postMessage\(\{ id, file \}\)/);
  const worker = readFileSync(join(root, "src/lib/fonts/parse.worker.ts"), "utf8");
  assert.match(worker, /parseFontCollectionFromBuffer/);
  const native = readFileSync(join(root, "src/lib/fonts/native-parse.ts"), "utf8");
  assert.doesNotMatch(native, /Array\.from\(new Uint8Array/);
  assert.match(native, /bytesArg\(buffer\)/);
  assert.doesNotMatch(native, /harfbuzz|pyftsubset|hb-subset/);
});
