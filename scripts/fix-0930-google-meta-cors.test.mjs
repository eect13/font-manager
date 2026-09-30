// Card 20: the browser must not fetch fonts.google.com/metadata/fonts — it has
// no ACAO header, so every page load logged a CORS error (review 1 item 24).
// Behaviour test: runs fetchGoogleDirectory with a fetch spy.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const api = readFileSync(join(root, "src/lib/fonts/google-api.ts"), "utf8");
const chunk = api.slice(
  api.indexOf("async function fetchGoogleDirectory"),
  api.indexOf("export async function refreshGoogleCatalog"),
);
const js = stripTypeScriptTypes(chunk, { mode: "strip" });

test("fetchGoogleDirectory returns the shipped directory without a network fetch", async () => {
  const seen = [];
  const fetch = async (url) => {
    seen.push(String(url));
    throw new TypeError("Failed to fetch (CORS)");
  };
  const GOOGLE_DIRECTORY = new Set(["inter", "roboto"]);
  const fn = new Function(
    "fetch",
    "GOOGLE_DIRECTORY",
    "GOOGLE_META",
    "FETCH_MS",
    "familyKey",
    `${js}\nreturn fetchGoogleDirectory;`,
  )(fetch, GOOGLE_DIRECTORY, "https://fonts.google.com/metadata/fonts", 10, (s) => s.toLowerCase());
  const dir = await fn();
  assert.deepEqual(seen, [], "no browser fetch of fonts.google.com metadata");
  assert.equal(dir, GOOGLE_DIRECTORY);
});
