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

test("206b keep ProductVersion 1.0.206 (completeness amend-style tip)", () => {
  assert.equal(pkg.version, "1.0.206");
  assert.match(version, /1\.0\.206/);
});

test("Completeness P0: .complete only when planned faces intact", () => {
  assert.match(activateRs, /fn mark_family_complete/);
  assert.match(activateRs, /if planned > 0 && intact_for_complete >= planned/);
  assert.match(activateRs, /clear_complete_marker/);
  assert.match(activateRs, /fn verify_complete_marker/);
  assert.match(activateRs, /Stamp `\.complete` only for a full face set/);
});

test("Completeness P0: CJK script subsets + tiny latin purge/replace", () => {
  assert.match(activateRs, /fn is_cjk_subset/);
  assert.match(activateRs, /fn pick_subsets/);
  assert.match(activateRs, /fn family_may_have_tiny_cjk_statics/);
  assert.match(activateRs, /fn replace_tiny_cjk_static_faces/);
  assert.match(activateRs, /purge_latin_named_files/);
  assert.match(osActivate, /Prefer CJK \/ emoji script subsets/);
  assert.match(osActivate, /subsets\.includes\("emoji"\)/);
});

test("Completeness P0: emoji full upstream — never CSS/latin stubs for color", () => {
  assert.match(activateRs, /fn pull_emoji_upstream_color_ttf/);
  assert.match(activateRs, /fn is_noto_color_emoji_family/);
  assert.match(activateRs, /!is_noto_color_emoji_family\(family, &slug\)/);
  assert.match(activateRs, /NotoColorEmoji\.ttf/);
  assert.match(activateRs, /bytes\.len\(\) < 256 \* 1024/);
  assert.match(activateRs, /pick_subsets_prefers_emoji_over_latin/);
  assert.match(osActivate, /softEmojiStubGate && data\.byteLength < 256 \* 1024/);
  assert.match(osActivate, /NotoColorEmoji\.ttf/);
});

test("Completeness P0: VF families keep vars + statics (Google path)", () => {
  assert.match(activateRs, /fn download_google_variable_ttfs/);
  assert.match(activateRs, /fn ensure_catalog_variable_faces/);
  assert.match(activateRs, /merge_variable_into_planned_keys/);
  assert.match(activateRs, /never var-only/);
});

test("Honesty P0: Live = Add>0; Gidugu hard; emoji soft try-Add then Settled", () => {
  assert.match(gdiMirror, /Gidugu/);
  assert.match(gdiMirror, /SOFT_GDI_TRY_ADD_FIRST/);
  assert.match(gdiMirror, /Noto Color Emoji/);
  assert.match(gdiMirror, /Noto Emoji/);
  const hard = gdiMirror.slice(
    gdiMirror.indexOf("KNOWN_GDI_SESSION_INCAPABLE"),
    gdiMirror.indexOf("SOFT_GDI_TRY_ADD_FIRST"),
  );
  assert.doesNotMatch(hard, /Noto Color Emoji|Noto Emoji/);
  assert.match(activateRs, /settled_implies_not_activated/);
  assert.match(activateRs, /Never claims Activated/);
  assert.match(activateRs, /family_disk_settled_known_gdi_incapable/);
  assert.match(activateRs, /stamp_settle_after_add_zero/);
  assert.match(activateRs, /stamp_known_incapable_dir_settled/);
});
