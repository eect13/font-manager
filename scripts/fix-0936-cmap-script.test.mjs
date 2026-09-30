// Card 36 item 4: the preview sample comes from the characters the font contains
// (cmap), not its name. A renamed Arabic font previews Arabic, right to left.
import "./lib-ts-hooks.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ARABIC, BASIC_LATIN, buildSfnt, range } from "./ttc-fixture.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");
const { parseFontCollectionFromBuffer } = await import("../src/lib/fonts/parse-font.ts");
const { scriptDir, scriptLang } = await import("../src/lib/fonts/scripts.ts");
const { previewSample } = await import("../src/lib/fonts/emoji.ts");
const { windowsColorNote } = await import("../src/lib/fonts/color-font.ts");

const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
async function importAs(family, cps) {
  const bytes = buildSfnt(family, cps);
  const [parsed] = await parseFontCollectionFromBuffer(`${family}.ttf`, bytes.length, ab(bytes));
  // What the store keeps on the record.
  return { family: parsed.family, tags: parsed.tags, colorKind: parsed.colorKind, script: parsed.script, source: "local" };
}
const FOX = "The quick brown fox";

test("renamed Arabic font (Latin-looking name) previews Arabic, dir=rtl, lang=ar", async () => {
  const font = await importAs("FMArabicTest", [...BASIC_LATIN, ...ARABIC]);
  assert.equal(font.script, "arabic");
  assert.equal(scriptDir(font), "rtl");
  assert.equal(scriptLang(font), "ar");
  assert.match(previewSample(font, FOX), /[\u0600-\u06ff]/);
});

test("a Latin font keeps the user's sample and ltr", async () => {
  const font = await importAs("Plain Latin", BASIC_LATIN);
  assert.equal(scriptDir(font), "ltr");
  assert.equal(previewSample(font, FOX), FOX);
});

test("a name that claims Arabic but has only Latin glyphs previews Latin", async () => {
  const font = await importAs("Noto Sans Arabic", BASIC_LATIN);
  assert.equal(font.script, "latin");
  assert.equal(scriptDir(font), "ltr");
  assert.equal(previewSample(font, FOX), FOX);
});

test("Devanagari and Cyrillic-only fonts preview their own script", async () => {
  const deva = await importAs("Renamed Indic", [...BASIC_LATIN, ...range(0x0900, 0x097f)]);
  assert.equal(deva.script, "devanagari");
  assert.match(previewSample(deva, FOX), /[\u0900-\u097f]/);
  const cyr = await importAs("Renamed Cyr", [0x20, ...range(0x0400, 0x04ff)]);
  assert.equal(cyr.script, "cyrillic");
  assert.match(previewSample(cyr, FOX), /[\u0400-\u04ff]/);
});

test("an emoji-only cmap previews emoji", async () => {
  const font = await importAs("Renamed Pictographs", [0x20, 0x23, 0x2a, ...range(0x30, 0x39), ...range(0x1f600, 0x1f64f), ...range(0x1f300, 0x1f5ff), 0x2728, 0x2764, 0x1f44d, 0x1f680, 0x1f308, 0x1f525, 0x1f31f, 0x1f389, 0x1f970]);
  assert.equal(font.script, "emoji");
  assert.match(previewSample(font, FOX), /\u{1f600}/u);
});

test("a pan-script font with Latin stays Latin (no surprise Arabic sample)", async () => {
  const cps = [...BASIC_LATIN, ...ARABIC, ...range(0x0590, 0x05ff), ...range(0x0e00, 0x0e7f), ...range(0x0900, 0x097f)];
  const font = await importAs("Big Unicode", cps);
  assert.equal(previewSample(font, FOX), FOX);
});

test("colour note for uploads does not promise an outline file we don't install", () => {
  for (const kind of ["colrv1", "svg", "cbdt", "colrv0", "sbix"]) {
    const note = windowsColorNote(kind, "local");
    assert.doesNotMatch(note, /we (also )?install/i, `${kind}: ${note}`);
    assert.ok(note.length > 20);
  }
  assert.match(windowsColorNote("colrv1", "google"), /outline/i);
});

test("an OpenType-SVG card shows the existing outline Badge hint", () => {
  const card = read("src/components/font-studio/font-card.tsx");
  assert.match(card, /colorKind === "svg"/);
  assert.match(card, /svgHint/);
});
