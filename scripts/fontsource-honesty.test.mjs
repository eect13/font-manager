import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const card = readFileSync(join(root, "src/components/font-studio/font-card.tsx"), "utf8");
const osActivate = readFileSync(join(root, "src/lib/fonts/os-activate.ts"), "utf8");
const googleApi = readFileSync(join(root, "src/lib/fonts/google-api.ts"), "utf8");
const activateRs = readFileSync(join(root, "src-tauri/src/activate.rs"), "utf8");
const regen = readFileSync(join(root, "scripts/regen-shipped-catalogs.mjs"), "utf8");
const google = JSON.parse(readFileSync(join(root, "src/lib/fonts/google-catalog.json"), "utf8"));
const other = JSON.parse(readFileSync(join(root, "src/lib/fonts/fontsource-other.json"), "utf8"));
const directory = JSON.parse(readFileSync(join(root, "src/lib/fonts/google-directory.json"), "utf8"));

test("Settled card advertises try Fontsource only for Gidugu allowlist", () => {
  assert.match(card, /function isFontsourceSettledOffer/);
  assert.match(card, /family\.trim\(\)\.toLowerCase\(\) === "gidugu"/);
  assert.match(card, /Settled · try Fontsource/);
  // Non-Gidugu Settled is calm badge — no Fontsource tease on every Settled face.
  assert.match(card, /On disk · Windows won’t load \(not Activated\)/);
  // Click path must not call offer for non-allowlist (guard is the helper).
  assert.equal((card.match(/tryFontsourceGdiOffer\(font\.family\)/g) || []).length, 2);
  assert.doesNotMatch(
    card,
    /title="On disk · Windows won’t load\. Optional: try Fontsource copy"[\s\S]*?if \(font\.family\.trim\(\)\.toLowerCase\(\) === "gidugu"\)/,
  );
});

test("finish toast Try Fontsource is Gidugu-only", () => {
  assert.match(osActivate, /const offerGidugu = settledNames\.some/);
  assert.match(osActivate, /n\.trim\(\)\.toLowerCase\(\) === "gidugu"/);
  assert.match(osActivate, /label: "Try Fontsource"/);
  assert.match(osActivate, /tryFontsourceGdiOffer\("Gidugu"\)/);
});

test("Rust try_fontsource_gdi_offer is known-incapable allowlist (Gidugu)", () => {
  assert.match(activateRs, /fn family_known_gdi_session_incapable\(family: &str\) -> bool/);
  assert.match(
    activateRs,
    /fn family_known_gdi_session_incapable\(family: &str\) -> bool \{\s*family\.trim\(\)\.eq_ignore_ascii_case\("gidugu"\)/,
  );
  assert.match(activateRs, /pub fn try_fontsource_gdi_offer/);
  assert.match(activateRs, /if !family_known_gdi_session_incapable\(&family\)/);
  assert.match(activateRs, /fontsource_offer_activated_only_if_add/);
});

test("Google-first need_fontsource only when Google listing empty", () => {
  assert.match(activateRs, /let need_fontsource = google_listed\.is_empty\(\);/);
  assert.match(activateRs, /if need_fontsource && slug == "clear-sans"/);
  assert.match(activateRs, /\} else if need_fontsource \{/);
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
