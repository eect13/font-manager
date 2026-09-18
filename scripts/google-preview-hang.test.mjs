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

test("prime CSS batch is latin static only", () => {
  assert.match(loader, /export function primeGooglePreviewAllows/);
  assert.match(loader, /scriptSubset\(font\.family\) === "latin"/);
  assert.match(loader, /!font\.variable/);
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

test("latin static on-disk preview is allowed; CJK/VF is not", () => {
  assert.match(loader, /export function googlePreviewMayUseLocalDisk/);
  assert.match(loader, /loadGooglePreviewFromLocal/);
  assert.match(loader, /unifont\|cjk\|emoji/);
});
