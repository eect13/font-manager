// Card 20: the browser must not fetch fonts.google.com/metadata/fonts — it has
// no ACAO header, so a page fetch logs a CORS error. Refresh no longer has a
// directory function; the lock is that the catalog module never calls that URL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const api = readFileSync(join(root, "src/lib/fonts/google-api.ts"), "utf8");

test("catalog code does not fetch fonts.google.com metadata", () => {
  assert.doesNotMatch(api, /fonts\.google\.com\/metadata/);
  assert.doesNotMatch(api, /fetch\(\s*[`'"]https:\/\/fonts\.google\.com/);
  assert.match(api, /GOOGLE_DIRECTORY/);
});
