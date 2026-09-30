import "./lib-ts-hooks.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const { absorbReadyNames } = await import("../src/lib/fonts/ready-batch.ts");

test("first names and a full poll replace the list", () => {
  assert.deepEqual(absorbReadyNames([], ["A"]), ["A"]);
  assert.deepEqual(absorbReadyNames(["A", "B"], ["A", "B", "C"]), ["A", "B", "C"]);
});

test("a short event tail appends and does not drop earlier families", () => {
  assert.deepEqual(absorbReadyNames(["A", "B"], ["C"]), ["A", "B", "C"]);
  assert.deepEqual(absorbReadyNames(["A", "B", "C"], ["C"]), ["A", "B", "C"]);
  assert.deepEqual(absorbReadyNames(["A"], []), ["A"]);
});

test("catalog probes cannot use the 300s body timeout, and events send only the new names", () => {
  const rust = readFileSync(new URL("../src-tauri/src/activate.rs", import.meta.url), "utf8");
  assert.match(rust, /const CATALOG_PROBE_TIMEOUT: Duration = Duration::from_secs\(20\)/);
  assert.match(rust, /fn ready_emit_delta/);
  assert.match(rust, /\.timeout\(CATALOG_PROBE_TIMEOUT\)/);
  assert.match(rust, /note_catalog_current/);
  const js = readFileSync(new URL("../src/lib/fonts/os-activate.ts", import.meta.url), "utf8");
  assert.match(js, /absorbReadyNames/);
  assert.match(js, /return eventsBound \? 2500 : 400/);
});
