import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const activateRs = readFileSync(join(root, "src-tauri/src/activate.rs"), "utf8");
const osActivate = readFileSync(join(root, "src/lib/fonts/os-activate.ts"), "utf8");
const gdiMirror = readFileSync(join(root, "src/lib/fonts/gdi-incapable.ts"), "utf8");
const version = readFileSync(join(root, "src/version.ts"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const cargo = readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8");
const tauriConf = readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8");
const perm = readFileSync(join(root, "src-tauri/permissions/font-activate.toml"), "utf8");
const mainRs = readFileSync(join(root, "src-tauri/src/main.rs"), "utf8");

test("version is 1.0.206", () => {
  assert.equal(pkg.version, "1.0.206");
  assert.match(version, /1\.0\.206/);
  assert.match(cargo, /version = "1\.0\.206"/);
  assert.match(tauriConf, /"version": "1\.0\.206"/);
});

test("boot seeds GDI-incapable allowlist into settled", () => {
  assert.match(activateRs, /fn seed_known_gdi_incapable_settled/);
  assert.match(activateRs, /seed_known_gdi_incapable_settled\(app\)/);
  assert.match(activateRs, /stamp_known_incapable_disk_settled\(app, family\);/);
  // early-skip stamps before first settle scan
  const early = activateRs.slice(
    activateRs.indexOf("fn family_early_skip_known_incapable"),
    activateRs.indexOf("fn family_early_skip_known_incapable") + 1200,
  );
  assert.match(early, /stamp_known_incapable_disk_settled/);
  assert.match(early, /note_session_gdi_refused/);
});

test("resume never blind-defaults to google when store missing", () => {
  const start = osActivate.indexOf("export async function resumeGoogleFamilies");
  const fn = osActivate.slice(start, start + 2200);
  assert.doesNotMatch(fn, /:\s*"google"/);
  assert.doesNotMatch(fn, /return font \? fetchIntentFor\(font\) : "google"/);
  assert.match(fn, /resolve_family_fetch_intent/);
  assert.match(fn, /GOOGLE_FONTS/);
  assert.match(fn, /Ambiguous/);
  assert.match(activateRs, /fn resolve_fetch_intent_from_disk/);
  assert.match(activateRs, /pub fn resolve_family_fetch_intent/);
  assert.match(mainRs, /resolve_family_fetch_intent/);
  assert.match(perm, /resolve_family_fetch_intent/);
});

test("emoji P0: full upstream TTF + allowlist Settled honesty", () => {
  assert.match(activateRs, /fn pull_emoji_upstream_color_ttf/);
  assert.match(activateRs, /fn is_emoji_session_family/);
  assert.match(activateRs, /NotoColorEmoji\.ttf/);
  assert.match(activateRs, /family: "Noto Color Emoji"/);
  assert.match(activateRs, /family: "Noto Emoji"/);
  assert.match(gdiMirror, /Noto Color Emoji/);
  assert.match(gdiMirror, /Noto Emoji/);
  assert.match(activateRs, /emoji_allowlist_and_upstream_urls_for_settled_honesty/);
});

test("CJK honesty policy still present (chinese/japanese/korean + tiny purge)", () => {
  assert.match(activateRs, /fn is_cjk_subset/);
  assert.match(activateRs, /fn pick_subsets/);
  assert.match(activateRs, /fn family_may_have_tiny_cjk_statics/);
  assert.match(activateRs, /fn replace_tiny_cjk_static_faces/);
  assert.match(activateRs, /purge_latin_named_files/);
  assert.match(activateRs, /noto sans sc/i);
  assert.match(activateRs, /Prefer CJK \/ emoji \/ script subsets/);
});

test("product honesty: Live = Add>0; Settled never fake Live for emoji/CJK", () => {
  assert.match(activateRs, /settled_implies_not_activated/);
  assert.match(activateRs, /Never claims Activated/);
  // Comment may mention FR_PRIVATE; runtime must stay enumerable (not private).
  assert.match(activateRs, /Not FR_PRIVATE/);
  assert.match(activateRs, /FR_ENUMERABLE/);
});
