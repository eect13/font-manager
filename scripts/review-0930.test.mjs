import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const store = readFileSync(join(root, "src/lib/fonts/store.ts"), "utf8");
const dup = readFileSync(join(root, "src/components/font-studio/duplicate-finder.tsx"), "utf8");
const os = readFileSync(join(root, "src/lib/fonts/os-activate.ts"), "utf8");
const loader = readFileSync(join(root, "src/lib/fonts/loader.ts"), "utf8");
const api = readFileSync(join(root, "src/lib/fonts/google-api.ts"), "utf8");
const shell = readFileSync(join(root, "src/components/font-studio/app-shell.tsx"), "utf8");
const card = readFileSync(join(root, "src/components/font-studio/font-card.tsx"), "utf8");
const chips = readFileSync(join(root, "src/components/font-studio/search-chips.tsx"), "utf8");
const play = readFileSync(join(root, "src/components/font-studio/playground.tsx"), "utf8");

function axesForFont(font) {
  if (font.axes && font.axes.length) return font.axes.filter((axis) => axis.max > axis.min);
  return [];
}
function scriptSampleText() {
  return "Aa";
}
function scriptSubset() {
  return "latin";
}
function isSpecialPreviewFont() {
  return false;
}

const chunk = loader.slice(
  loader.indexOf("export function css2WghtSpan"),
  loader.indexOf("export function googlePreviewMayUseLocalDisk"),
);
const js = stripTypeScriptTypes(chunk.replaceAll("export function", "function"), { mode: "strip" });
const { css2WghtSpan, googlePreviewCssHref } = new Function(
  "axesForFont",
  "scriptSampleText",
  "scriptSubset",
  "isSpecialPreviewFont",
  `${js}\nreturn { css2WghtSpan, googlePreviewCssHref };`,
)(axesForFont, scriptSampleText, scriptSubset, isSpecialPreviewFont);

test("persist writes wait until hydrated so /duplicates cannot wipe the library", () => {
  assert.match(store, /let persistReady = false/);
  const setItem = store.slice(store.indexOf("setItem:"), store.indexOf("removeItem:"));
  assert.match(setItem, /if \(!persistReady\) return/);
  const hydratedAt = store.indexOf("setHydrated: (value) =>");
  const setHydrated = store.slice(hydratedAt, store.indexOf("setGoogleFonts:", hydratedAt));
  const flag = setHydrated.indexOf("persistReady = true");
  const write = setHydrated.indexOf("set({ hydrated: value })");
  assert.ok(flag >= 0 && write > flag, "flag must flip before the hydrated set() persists");

  const hideEffect = dup.slice(dup.lastIndexOf("useEffect(() => {"));
  const guard = hideEffect.indexOf("if (!hydrated) return;");
  const wipe = hideEffect.indexOf("duplicateHideIds: []");
  assert.ok(guard >= 0 && wipe > guard, "auto-hide effect must not write before rehydrate");
  assert.match(hideEffect, /\[hydrated, autoHide, groups\]/);
});

test("website Deactivate confirms Off instead of a Windows unload toast", () => {
  const fn = os.slice(
    os.indexOf("export async function uninstallFontOnSystem"),
    os.indexOf("function invokeError"),
  );
  assert.match(fn, /await syncFontsOnSystem\(\[font\], false\)/);
  assert.doesNotMatch(fn, /if \(!\(await inDesktopShell\(\)\)\) return;/);
  const web = os.slice(os.indexOf("export async function syncFontsOnSystem"));
  assert.match(web, /confirmDeactivated\(fonts\.map\(\(f\) => f\.id\)\)/);
});

test("CSS2 omits a fake wght range when the family has no wght axis", () => {
  const agu = {
    family: "Agu Display",
    catalogVariable: true,
    variable: false,
    weights: [400],
    italic: false,
  };
  assert.equal(css2WghtSpan(agu), null);
  const aguHref = googlePreviewCssHref(agu);
  assert.match(aguHref, /family=Agu\+Display&/);
  assert.doesNotMatch(aguHref, /wght@/);

  const morf = {
    family: "Agu Display",
    catalogVariable: true,
    variable: true,
    weights: [400],
    axes: [{ tag: "MORF", name: "Morph", min: 0, max: 100, def: 0 }],
  };
  assert.equal(css2WghtSpan(morf), null);
  assert.doesNotMatch(googlePreviewCssHref(morf), /wght@/);

  const inter = {
    family: "Inter",
    catalogVariable: true,
    variable: false,
    italic: true,
    weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
  };
  assert.deepEqual(css2WghtSpan(inter), { min: 100, max: 900 });
  assert.match(googlePreviewCssHref(inter), /wght@100\.\.900/);

  const lora = { family: "Lora", catalogVariable: false, variable: false, weights: [400, 700], italic: true };
  assert.equal(css2WghtSpan(lora), null);
  assert.match(googlePreviewCssHref(lora), /wght@400/);
  assert.doesNotMatch(googlePreviewCssHref(lora), /100\.\.900/);

  const param = loader.slice(
    loader.indexOf("function previewFamilyParam"),
    loader.indexOf("export function googlePreviewTextQuery"),
  );
  assert.match(param, /css2WghtSpan\(font\)/);
  assert.doesNotMatch(param, /\?\? 100/);
  assert.doesNotMatch(param, /100\.\.900/);
});

test("browser catalog does not fetch fonts.google.com metadata", () => {
  const fn = api.slice(api.indexOf("async function fetchGoogleDirectory"), api.indexOf("export async function refreshGoogleCatalog"));
  assert.match(fn, /return GOOGLE_DIRECTORY/);
  assert.doesNotMatch(fn, /fetch\(/);
});

test("320 header wraps, library has an h1, cards and playground are named", () => {
  assert.match(shell, /grid-cols-\[auto_minmax\(0,1fr\)\]/);
  assert.match(shell, /col-span-2 flex items-center justify-end gap-0\.5 sm:hidden/);
  assert.match(shell, /pathname === "\/" \?/);
  assert.match(shell, /<h1 className="truncate font-heading/);

  const article = card.slice(card.indexOf("<article"), card.indexOf("aria-label={`Open"));
  assert.doesNotMatch(article, /role="button"/);
  assert.doesNotMatch(article, /onClick=/);
  assert.match(card, /aria-label=\{`Open \$\{font\.fullName \|\| font\.family\}`\}/);
  assert.equal((card.match(/size-6 shrink-0 items-center justify-center rounded border/g) || []).length, 3);

  assert.match(chips, /<span className="tabular-nums text-foreground">\{n\.toLocaleString\(\)\}<\/span>/);
  assert.doesNotMatch(chips, /tabular-nums[^"\n]*opacity-70/);

  assert.match(play, /aria-label="Pairing preview"/);
  assert.match(play, /aria-label="Heading sample"/);
  assert.match(play, /aria-label="Body sample"/);
  assert.match(play, /focus-visible:ring-2 focus-visible:ring-ring/);
  assert.match(play, /aria-label=\{`\$\{label\} size`\}/);
});
