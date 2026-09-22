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

test("allowlist behavioral: mirror helpers + calm Settled toast (no FS download)", () => {
  assert.equal(isKnown("Gidugu"), true);
  assert.equal(isKnown("gidugu"), true);
  assert.equal(isKnown("Nunito"), false);
  assert.equal(firstSettled(["Nunito", "Gidugu", "Roboto"]), "Gidugu");
  assert.equal(firstSettled(["Roboto"]), undefined);
  assert.match(mirror, /export function firstSettledAllowlistedFamily/);
  assert.match(mirror, /export function isKnownGdiSessionIncapable/);
  assert.match(mirror, /family:\s*"Gidugu"/);
  assert.match(mirror, /isSoftGdiTryAddFirst/);
  // 1.0.188: no Try Fontsource download. 1.0.206d: soft-aware preview wired (no FS offer).
  assert.match(osActivate, /firstSettledAllowlistedFamily\(settledNames\)/);
  assert.doesNotMatch(osActivate, /label: "Try Fontsource"/);
  assert.match(osActivate, /settled > 0 \? toast\.message : toast\.success/);
});

test("Rust allowlist table + no-download offer + remnant purge", () => {
  assert.match(activateRs, /const KNOWN_GDI_SESSION_INCAPABLE/);
  assert.match(activateRs, /fn fontsource_gdi_offer_ttf_urls/);
  assert.match(activateRs, /fn purge_known_incapable_fontsource_remnants/);
  const offer = activateRs.match(/pub fn try_fontsource_gdi_offer[\s\S]*?\n\}\n\n#\[tauri::command\]/);
  assert.ok(offer, "try_fontsource_gdi_offer body");
  assert.doesNotMatch(offer[0], /dir\.join\("gidugu-400-normal\.ttf"\)/);
  assert.doesNotMatch(offer[0], /fetch_url_ttf/);
  assert.match(offer[0], /purge_known_incapable_fontsource_remnants/);
  assert.match(activateRs, /known_gdi_incapable_allowlist_is_table_not_single_hardcode/);
  assert.match(activateRs, /remnant_purge_unblocks_early_skip_for_known_incapable/);
});
