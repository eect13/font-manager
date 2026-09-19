import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("preview CSS2 text= includes pangram letters, not Hamburgefonstiv-only", () => {
  const loader = readFileSync(join(root, "src/lib/fonts/loader.ts"), "utf8");
  assert.match(loader, /The quick brown fox jumps over the lazy dog/);
  assert.match(loader, /export function googlePreviewTextQuery/);
  assert.doesNotMatch(
    loader.slice(loader.indexOf("export function googlePreviewTextQuery"), loader.indexOf("export function googlePreviewCssHref")),
    /Hamburgefonstiv/,
  );
});

test("inspector: no waterfall/glyphs strip; in-flow on desktop; glyph map link", () => {
  const inspector = readFileSync(join(root, "src/components/font-studio/font-inspector.tsx"), "utf8");
  assert.doesNotMatch(inspector, /const WATERFALL/);
  assert.doesNotMatch(inspector, /ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz/);
  assert.match(inspector, /to="\/glyphs"/);
  assert.match(inspector, /md:static md:inset-auto md:z-auto md:w-inspector md:shrink-0/);
  assert.match(inspector, /fontSize: "1\.25rem"/);
  assert.doesNotMatch(inspector, /3\.6vw/);
});

test("CSS cache vf3 + pin visible cards; rust folder index", () => {
  const loader = readFileSync(join(root, "src/lib/fonts/loader.ts"), "utf8");
  const card = readFileSync(join(root, "src/components/font-studio/font-card.tsx"), "utf8");
  const rust = readFileSync(join(root, "src-tauri/src/parse.rs"), "utf8");
  const store = readFileSync(join(root, "src/lib/fonts/store.ts"), "utf8");
  const sfnt = readFileSync(join(root, "src/lib/fonts/sfnt.ts"), "utf8");
  assert.match(loader, /css:vf3:/);
  assert.match(loader, /export function pinCss/);
  assert.match(card, /pinCss\(cssKey\)/);
  assert.match(rust, /pub fn index_font_paths/);
  assert.match(store, /importOriginPaths:/);
  assert.match(sfnt, /function readStatAxisNames/);
  assert.match(sfnt, /flags & 1 && t !== "ital"/);
});

test("catalog VF preview uses CSS2 even when badge variable is false", () => {
  const loader = readFileSync(join(root, "src/lib/fonts/loader.ts"), "utf8");
  assert.match(loader, /function previewIsVf/);
  assert.match(loader, /font.variable \|\| font.catalogVariable/);
  assert.match(loader, /AbortSignal\.timeout\(4500\)/);
  assert.match(loader, /fonts\\.googleapis\\.com/);
  assert.match(loader, /function injectLinkCss/);
  assert.match(loader, /link\.onload = done/);
  assert.match(loader, /waitForFamily\(font\.family, probe, 900\)/);
  const card = readFileSync(join(root, "src/components/font-studio/font-card.tsx"), "utf8");
  assert.match(card, /setReady\(true\)/);
  assert.match(card, /loaded \? "opacity-100" : "opacity-80"/);
  assert.doesNotMatch(card, /ready \? "opacity-100" : "opacity-0"/);
  assert.match(card, /loadingdone/);
});
