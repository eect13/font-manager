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

test("206b keeps ProductVersion 1.0.206", () => {
  assert.equal(pkg.version, "1.0.206");
  assert.match(version, /1\.0\.206/);
});

test("hydrate seeds KNOWN_GDI_SESSION_INCAPABLE into settled", () => {
  assert.match(hydrate, /KNOWN_GDI_SESSION_INCAPABLE/);
  assert.match(hydrate, /addSettledFamilies/);
  assert.match(hydrate, /KNOWN_GDI_SESSION_INCAPABLE\.map\(\(e\) => e\.family\)/);
});

test("activateSet + setActivatedMany skip isKnownGdiSessionIncapable", () => {
  assert.match(store, /isKnownGdiSessionIncapable\(font\.family\)/);
  // 1.0.206i: shared activate-queue.mjs (hard Gidugu); activateSet calls activateQueueIds.
  const queueMod = readFileSync(join(root, "src/lib/fonts/activate-queue.mjs"), "utf8");
  assert.match(queueMod, /gidugu/i);
  assert.match(activateToggle, /activateQueueIds\(ids, state\)/);
  assert.match(activateToggle, /activate-queue\.mjs/);
  // Visible menu path still hard-skips in toggle.
  assert.match(activateToggle, /isKnownGdiSessionIncapable\(font\.family\)/);
  const manyStart = store.indexOf("setActivatedMany: (ids, on) =>");
  const many = store.slice(manyStart, manyStart + 2200);
  assert.match(many, /isKnownGdiSessionIncapable/);
});

test("applyDiskStatusHonesty re-merges allowlist seed", () => {
  assert.match(store, /KNOWN_GDI_SESSION_INCAPABLE/);
  const start = store.indexOf("applyDiskStatusHonesty: (rows) =>");
  assert.ok(start >= 0, "implementation applyDiskStatusHonesty");
  const body = store.slice(start, start + 900);
  assert.match(body, /for \(const e of KNOWN_GDI_SESSION_INCAPABLE\)/);
  assert.match(body, /settledNames\.push\(e\.family\)/);
});

test("mirror hard allowlist Gidugu; soft emoji separate; Rust boot seed kept", () => {
  assert.match(gdiMirror, /Gidugu/);
  assert.match(gdiMirror, /SOFT_GDI_TRY_ADD_FIRST/);
  assert.match(gdiMirror, /Noto Color Emoji/);
  assert.match(gdiMirror, /Noto Emoji/);
  const hard = gdiMirror.slice(
    gdiMirror.indexOf("KNOWN_GDI_SESSION_INCAPABLE"),
    gdiMirror.indexOf("SOFT_GDI_TRY_ADD_FIRST"),
  );
  assert.doesNotMatch(hard, /Noto Color Emoji|Noto Emoji/);
  assert.match(activateRs, /fn seed_known_gdi_incapable_settled/);
  assert.match(activateRs, /seed_known_gdi_incapable_settled\(app\)/);
});
