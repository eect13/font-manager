import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const activateRs = readFileSync(join(root, "src-tauri/src/activate.rs"), "utf8");
const osActivate = readFileSync(join(root, "src/lib/fonts/os-activate.ts"), "utf8");
const loader = readFileSync(join(root, "src/lib/fonts/loader.ts"), "utf8");

test("FetchIntent hard-separates Google vs Fontsource download pipes", () => {
  assert.match(activateRs, /enum FetchIntent/);
  assert.match(activateRs, /let need_fontsource = matches!\(intent, FetchIntent::Fontsource\)/);
  assert.doesNotMatch(
    activateRs,
    /let need_fontsource = google_listed\.is_empty\(\);/,
  );
  // Google path never falls through to Fontsource fill
  assert.match(
    activateRs,
    /Hard separation: Google Activate = Google faces only \(no Fontsource fill\)/,
  );
  assert.match(
    activateRs,
    /Fontsource Activate = Fontsource only \(no Google CSS2 \/ desktop fetch\)/,
  );
});

test("start_google_downloads accepts parallel intents", () => {
  assert.match(activateRs, /intents: Option<Vec<String>>/);
  assert.match(activateRs, /remember_fetch_intent\(family, intent\)/);
  assert.match(osActivate, /export function fetchIntentFor/);
  assert.match(osActivate, /intents: \[intent\]/);
  assert.match(osActivate, /intents: google\.map\(\(font\) => fetchIntentFor\(font\)\)|intents = google\.map/);
});

test("JS Google activate never Fontsource-fills; FS activate never Google CSS2", () => {
  const start = osActivate.indexOf("async function googleTtfFiles");
  const fn = osActivate.slice(start, start + 900);
  assert.match(fn, /intent === "google"/);
  assert.match(fn, /intent === "fontsource"/);
  assert.match(fn, /googleCssTtfFiles/);
  assert.match(fn, /fontsourceTtfFiles/);
  // No fallback: return google then fontsourceTtfFiles without intent gate
  assert.doesNotMatch(
    fn,
    /if \(google\.length\) \{\s*return google;\s*\}\s*return fontsourceTtfFiles/,
  );
});

test("register filters by .download-source / planned keys", () => {
  assert.match(activateRs, /fn face_allowed_for_register/);
  assert.match(activateRs, /\.download-source/);
  assert.match(activateRs, /\.fontsource-planned/);
  assert.match(activateRs, /write_download_source\(&root, intent\)/);
  assert.match(activateRs, /if !face_allowed_for_register\(&dir, &path, family\)/);
  assert.match(activateRs, /fn face_allowed_for_register_google_stamp_skips_fontsource/);
  assert.match(activateRs, /fn face_allowed_for_register_fontsource_stamp_skips_google_planned/);
});

test("preview CSS: Google cards Google-only; other Fontsource-only (no dual hrefs)", () => {
  const start = loader.indexOf("function catalogCssHrefs");
  const fn = loader.slice(start, loader.indexOf("function fontsourceCssHref"));
  assert.match(fn, /Hard separation/);
  assert.match(fn, /if \(font\.catalog === "other"\) return fontsourceCssHrefs/);
  assert.match(fn, /return \[googlePreviewCssHref\(font, italic\)\];/);
  assert.doesNotMatch(fn, /\.\.\.fontsource/);
  assert.doesNotMatch(fn, /return \[google, \.\.\.fontsource\]/);
});

test("1.0.204 feel work still present (not reverted)", () => {
  assert.match(osActivate, /drop_google_download_families/);
  assert.match(osActivate, /ProgressOwner/);
  assert.match(osActivate, /beginOwnedJob/);
  assert.match(activateRs, /fn drop_google_download_families/);
});
