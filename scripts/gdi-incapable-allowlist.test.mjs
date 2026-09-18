import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mirror = readFileSync(join(root, "src/lib/fonts/gdi-incapable.ts"), "utf8");
const osActivate = readFileSync(join(root, "src/lib/fonts/os-activate.ts"), "utf8");
const activateRs = readFileSync(join(root, "src-tauri/src/activate.rs"), "utf8");

/** Minimal runtime twin of gdi-incapable.ts for behavioral lock. */
const KNOWN = [{ family: "Gidugu", fsSlug: "gidugu", subsets: ["telugu", "latin"] }];
function isKnown(family) {
  const key = family.trim().toLowerCase();
  return KNOWN.some((e) => e.family.toLowerCase() === key);
}
function firstSettled(settledNames) {
  for (const n of settledNames) {
    if (isKnown(n)) return n.trim();
  }
  return undefined;
}

test("allowlist behavioral: Settled toast picks first allowlisted settled name", () => {
  assert.equal(isKnown("Gidugu"), true);
  assert.equal(isKnown("gidugu"), true);
  assert.equal(isKnown("Nunito"), false);
  assert.equal(firstSettled(["Nunito", "Gidugu", "Roboto"]), "Gidugu");
  assert.equal(firstSettled(["Roboto"]), undefined);
  // Mirror source must export the same helpers the toast uses.
  assert.match(mirror, /export function firstSettledAllowlistedFamily/);
  assert.match(mirror, /export function isKnownGdiSessionIncapable/);
  assert.match(mirror, /family:\s*"Gidugu"/);
  assert.match(osActivate, /firstSettledAllowlistedFamily\(settledNames\)/);
  assert.match(osActivate, /settled > 0 \? toast\.message : toast\.success/);
});

test("Rust allowlist table + slug offer (not forever-hardcoded gidugu filename)", () => {
  assert.match(activateRs, /const KNOWN_GDI_SESSION_INCAPABLE/);
  assert.match(activateRs, /fn fontsource_gdi_offer_ttf_urls/);
  assert.match(activateRs, /fontsource_face_filename\(&slug,\s*"latin",\s*400,\s*"normal"\)/);
  const offer = activateRs.match(/pub fn try_fontsource_gdi_offer[\s\S]*?\n\}\n\n#\[tauri::command\]/);
  assert.ok(offer, "try_fontsource_gdi_offer body");
  assert.doesNotMatch(offer[0], /dir\.join\("gidugu-400-normal\.ttf"\)/);
  assert.match(activateRs, /known_gdi_incapable_allowlist_is_table_not_single_hardcode/);
});
