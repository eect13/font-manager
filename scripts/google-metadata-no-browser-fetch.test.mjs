import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const googleApi = readFileSync(join(root, "src/lib/fonts/google-api.ts"), "utf8");
const regen = readFileSync(join(root, "scripts/regen-shipped-catalogs.mjs"), "utf8");

test("web/desktop client never fetches fonts.google.com metadata (no CORS; shipped directory covers it)", () => {
  assert.doesNotMatch(googleApi, /fonts\.google\.com\/metadata/);
  assert.doesNotMatch(googleApi, /fetch\(GOOGLE_META/);
  // The build-time regen script still refreshes the shipped directory from Google.
  assert.match(regen, /fonts\.google\.com\/metadata\/fonts/);
});
