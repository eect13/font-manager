import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const card = readFileSync(join(root, "src/components/font-studio/font-card.tsx"), "utf8");
const osActivate = readFileSync(join(root, "src/lib/fonts/os-activate.ts"), "utf8");
const gdiMirror = readFileSync(join(root, "src/lib/fonts/gdi-incapable.ts"), "utf8");
const googleApi = readFileSync(join(root, "src/lib/fonts/google-api.ts"), "utf8");
const activateRs = readFileSync(join(root, "src-tauri/src/activate.rs"), "utf8");
const regen = readFileSync(join(root, "scripts/regen-shipped-catalogs.mjs"), "utf8");
const google = JSON.parse(readFileSync(join(root, "src/lib/fonts/google-catalog.json"), "utf8"));
const other = JSON.parse(readFileSync(join(root, "src/lib/fonts/fontsource-other.json"), "utf8"));
const directory = JSON.parse(readFileSync(join(root, "src/lib/fonts/google-directory.json"), "utf8"));

test("shared TS allowlist mirrors Rust known-GDI-incapable table", () => {
  assert.match(gdiMirror, /export const KNOWN_GDI_SESSION_INCAPABLE/);
  assert.match(gdiMirror, /family:\s*"Gidugu"/);
  assert.match(gdiMirror, /fsSlug:\s*"gidugu"/);
  assert.match(gdiMirror, /subsets:\s*\["telugu",\s*"latin"\]/);
  assert.match(gdiMirror, /export function isKnownGdiSessionIncapable/);
  assert.match(gdiMirror, /export function firstSettledAllowlistedFamily/);
  assert.match(activateRs, /const KNOWN_GDI_SESSION_INCAPABLE/);
  assert.match(activateRs, /struct KnownGdiIncapableEntry/);
  assert.match(activateRs, /fn known_gdi_incapable_entry/);
  assert.match(activateRs, /fn family_known_gdi_session_incapable/);
  assert.match(activateRs, /family:\s*"Gidugu"/);
  assert.match(activateRs, /subsets:\s*&?\["telugu",\s*"latin"\]/);
  // No single-hardcode body for the predicate.
  assert.doesNotMatch(
    activateRs,
    /fn family_known_gdi_session_incapable\(family: &str\) -> bool \{\s*family\.trim\(\)\.eq_ignore_ascii_case\("gidugu"\)\s*\}/,
  );
});

test("Settled card has calm badge only — no Fontsource download affordance", () => {
  // 1.0.188: remove Try Fontsource from allowlisted Settled cards.
  assert.doesNotMatch(card, /Settled · try Fontsource/);
  assert.doesNotMatch(card, /tryFontsourceGdiOffer/);
  assert.doesNotMatch(card, /isFontsourceSettledOffer/);
  assert.match(card, /On disk · Windows won’t load \(not Activated\)/);
  assert.equal((card.match(/\bSettled\b/g) || []).length >= 2, true);
});

test("finish toast Settled is calm + Open folder (no Try Fontsource download)", () => {
  assert.match(osActivate, /const chrome = settled > 0 \? toast\.message : toast\.success/);
  assert.doesNotMatch(osActivate, /label: "Try Fontsource"/);
  assert.match(osActivate, /firstSettledAllowlistedFamily\(settledNames\)/);
  assert.match(osActivate, /label: "Open folder"/);
  // Fail path stays error; Settled must not use success chrome when settledNames present.
  assert.match(osActivate, /toast\.error\(/);
});

test("Rust try_fontsource_gdi_offer is allowlist no-download + remnant purge", () => {
  assert.match(activateRs, /pub fn try_fontsource_gdi_offer/);
  assert.match(activateRs, /if !family_known_gdi_session_incapable\(&family\)/);
  assert.match(activateRs, /fontsource_offer_activated_only_if_add/);
  assert.match(activateRs, /fn purge_known_incapable_fontsource_remnants/);
  assert.match(activateRs, /fn fontsource_gdi_offer_ttf_urls/);
  const offer = activateRs.match(/pub fn try_fontsource_gdi_offer[\s\S]*?\n\}\n\n#\[tauri::command\]/);
  assert.ok(offer, "try_fontsource_gdi_offer body");
  // 1.0.188: no CDN fetch / write of Fontsource TTFs.
  assert.doesNotMatch(offer[0], /fetch_url_ttf/);
  assert.doesNotMatch(offer[0], /http_download_client/);
  assert.doesNotMatch(offer[0], /write_font_file/);
  assert.doesNotMatch(offer[0], /fontsource_face_filename/);
  assert.match(offer[0], /purge_known_incapable_fontsource_remnants/);
  assert.match(offer[0], /settled:\s*true/);
  assert.match(offer[0], /added:\s*0/);
});

test("Fontsource fill only on Fontsource intent (hard separation, no Google fallback)", () => {
  assert.match(activateRs, /let need_fontsource = matches!\(intent, FetchIntent::Fontsource\)/);
  assert.match(activateRs, /if need_fontsource && slug == "clear-sans"/);
  assert.match(activateRs, /\} else if need_fontsource \{/);
  assert.doesNotMatch(activateRs, /let need_fontsource = google_listed\.is_empty\(\);/);
});

test("live catalog fetches use cache no-store", () => {
  assert.match(googleApi, /cache: "no-store"/);
  const noStore = (googleApi.match(/cache:\s*"no-store"/g) || []).length;
  assert.ok(noStore >= 2, `expected ≥2 no-store fetches, got ${noStore}`);
  assert.match(regen, /cache:\s*"no-store"/);
  assert.match(regen, /FONTSOURCE_LIST|api\.fontsource\.org/);
  assert.match(regen, /fonts\.google\.com\/metadata\/fonts/);
});

test("shipped snapshots ≈ Google 1946 + Fontsource exclusive 154", () => {
  assert.equal(google.count, google.families.length);
  assert.equal(other.count, other.families.length);
  assert.equal(directory.count, directory.families.length);
  assert.equal(google.families.length, 1946);
  assert.equal(other.families.length, 154);
  assert.equal(directory.families.length, 1946);
  assert.equal(google.families.length + other.families.length, 2100);
  assert.ok(String(google.source).includes("live"));
  assert.ok(String(other.source).includes("live"));
  assert.ok(
    google.families.some((row) => (Array.isArray(row) ? row[0] : row) === "Gidugu"),
  );
  assert.ok(
    other.families.some((row) => (Array.isArray(row) ? row[0] : row) === "Clear Sans"),
  );
});
