import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const loader = readFileSync(join(root, "src/lib/fonts/loader.ts"), "utf8");
const card = readFileSync(join(root, "src/components/font-studio/font-card.tsx"), "utf8");

test("library cards always load preview, never VF full", () => {
  assert.match(card, /loadFont\(font, "preview"\)/);
  assert.doesNotMatch(card, /loadFont\(font, font\.variable \? "full"/);
  assert.match(loader, /googlePreviewIsCssOnly\(mode, special\)/);
});

test("prime CSS batch is latin, not emoji/special", () => {
  assert.match(loader, /export function primeGooglePreviewAllows/);
  const start = loader.indexOf("export function primeGooglePreviewAllows");
  const fn = loader.slice(start, start + 280);
  assert.match(fn, /scriptSubset\(font\.family\) === "latin"/);
  assert.match(fn, /!isSpecialPreviewFont/);
  assert.doesNotMatch(fn, /font\.catalog !== "other"/);
});

test("preview CSS2 uses text= not a full family sheet", () => {
  assert.match(loader, /export function googlePreviewCssHref/);
  assert.match(loader, /&text=\$\{googlePreviewTextQuery/);
  assert.match(loader, /family=\$\{family\}:wght@400/);
  assert.match(loader, /Noto Sans JP CSS2/);
});

test("CSS injection has an LRU (not unbounded head)", () => {
  assert.match(loader, /export const CSS_LRU = 96/);
  assert.match(loader, /function rememberCss/);
  assert.match(loader, /cssOrder\.length > CSS_LRU/);
});

test("failed inject does not mark loadedGoogle preview", () => {
  assert.match(loader, /if \(ok\) loadedGoogle\.set\(font\.id, "preview"\)/);
  assert.match(loader, /let ok = false/);
});

test("latin on-disk preview is allowed; CJK/Unifont/color is not", () => {
  assert.match(loader, /export function googlePreviewMayUseLocalDisk/);
  assert.match(loader, /loadGooglePreviewFromLocal/);
  assert.match(loader, /unifont\|cjk\|emoji/);
  const start = loader.indexOf("export function googlePreviewMayUseLocalDisk");
  const fn = loader.slice(start, start + 400);
  assert.match(fn, /scriptSubset\(font\.family\) === "latin"/);
  assert.doesNotMatch(fn, /!font\.variable/);
});

test("Fontsource exclusive preview does not hit fonts.googleapis.com first", () => {
  const start = loader.indexOf("function catalogCssHrefs");
  const fn = loader.slice(start, loader.indexOf("function fontsourceCssHref"));
  assert.match(fn, /if \(font\.catalog === "other"\) return fontsource/);
  const otherIdx = fn.indexOf('catalog === "other"');
  const googleIdx = fn.indexOf("googlePreviewCssHref");
  assert.ok(otherIdx >= 0 && otherIdx < googleIdx, "exclusive must return before Google CSS2");
});

test("prime exclusive uses Fontsource CSS, not Google CSS2", () => {
  const start = loader.indexOf("export function primeGooglePreview(");
  const fn = loader.slice(start, start + 700);
  assert.match(fn, /catalog === "other"/);
  assert.match(fn, /fontsourceCssHrefs/);
});

test("GDI-live preview skips FontFace disk load", () => {
  assert.match(loader, /familyLoaded\(font\.family, probe\)/);
  const local = loader.slice(
    loader.indexOf("async function loadGooglePreviewFromLocal"),
    loader.indexOf("function ensureCatalogCss"),
  );
  assert.match(local, /familyLoaded\(font\.family/);
});

test("FitSpecimen does not subscribe after the face is already live", () => {
  assert.match(card, /if \(seen\) return/);
  assert.match(card, /loadingdone/);
});

test("Google preview hrefs are Google-only (no dual Fontsource fallback)", () => {
  const start = loader.indexOf("function catalogCssHrefs");
  const fn = loader.slice(start, loader.indexOf("function fontsourceCssHref"));
  assert.match(fn, /return \[googlePreviewCssHref\(font, italic\)\];/);
  assert.doesNotMatch(fn, /\[googlePreviewCssHref\(font, italic\), \.\.\.fontsource\]/);
});

