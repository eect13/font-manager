import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hydrate = readFileSync(join(root, "src/lib/fonts/hydrate.ts"), "utf8");
const store = readFileSync(join(root, "src/lib/fonts/store.ts"), "utf8");
const activateToggle = readFileSync(
  join(root, "src/components/font-studio/activate-toggle.tsx"),
  "utf8",
);
const gdiMirror = readFileSync(join(root, "src/lib/fonts/gdi-incapable.ts"), "utf8");
const activateRs = readFileSync(join(root, "src-tauri/src/activate.rs"), "utf8");
const version = readFileSync(join(root, "src/version.ts"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const readme = readFileSync(join(root, "README.md"), "utf8");
const bugs = readFileSync(join(root, "BUGS.md"), "utf8");

test("206c keeps ProductVersion 1.0.206 (amend-style like 206b)", () => {
  assert.equal(pkg.version, "1.0.206");
  assert.match(version, /1\.0\.206/);
});

test("hard allowlist is Gidugu only — emoji NOT hard-skipped", () => {
  assert.match(gdiMirror, /family:\s*"Gidugu"/);
  assert.doesNotMatch(
    gdiMirror.slice(gdiMirror.indexOf("KNOWN_GDI_SESSION_INCAPABLE"), gdiMirror.indexOf("SOFT_GDI_TRY_ADD_FIRST")),
    /Noto Color Emoji|Noto Emoji/,
  );
  assert.match(gdiMirror, /SOFT_GDI_TRY_ADD_FIRST/);
  assert.match(gdiMirror, /Noto Color Emoji/);
  assert.match(gdiMirror, /Noto Emoji/);
  assert.match(gdiMirror, /isSoftGdiTryAddFirst/);

  const tableStart = activateRs.indexOf("const KNOWN_GDI_SESSION_INCAPABLE");
  const table = activateRs.slice(tableStart, tableStart + 500);
  assert.match(table, /Gidugu/);
  assert.doesNotMatch(table, /Noto Color Emoji|Noto Emoji/);
  assert.match(activateRs, /fn family_soft_try_add_then_settle/);
  assert.match(activateRs, /fn family_may_settle_add_zero/);
  assert.match(activateRs, /fn stamp_settle_after_add_zero/);
  assert.match(activateRs, /fn is_emoji_session_family/);
});

test("UI still seeds/skips hard allowlist only (Gidugu) — Activate All queues emoji", () => {
  assert.match(hydrate, /KNOWN_GDI_SESSION_INCAPABLE\.map\(\(e\) => e\.family\)/);
  assert.doesNotMatch(hydrate, /SOFT_GDI_TRY_ADD_FIRST/);
  assert.match(activateToggle, /isKnownGdiSessionIncapable\(font\.family\)/);
  assert.match(store, /isKnownGdiSessionIncapable\(font\.family\)/);
  assert.doesNotMatch(activateToggle, /isSoftGdiTryAddFirst/);
  assert.doesNotMatch(store, /isSoftGdiTryAddFirst/);
});

test("completeness emoji P0 still present (upstream TTF + stub reject)", () => {
  assert.match(activateRs, /fn pull_emoji_upstream_color_ttf/);
  assert.match(activateRs, /NotoColorEmoji\.ttf/);
  assert.match(activateRs, /bytes\.len\(\) < 256 \* 1024/);
  assert.match(activateRs, /fn is_noto_color_emoji_family/);
  assert.match(activateRs, /settled_implies_not_activated/);
  assert.match(activateRs, /Never claims Activated/);
});

test("docs note 206c emoji soft try-Add", () => {
  assert.match(readme, /1\.0\.206c/);
  assert.match(bugs, /1\.0\.206c/);
  assert.match(bugs, /soft|try Add|not hard/i);
});
