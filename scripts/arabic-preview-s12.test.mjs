// S12 / FORM-S12 §4: Arabic-primary fonts that also carry Latin preview two lines.
// Line 1 is the Arabic pangram (rtl, ar); line 2 is the user's sample at 0.5em
// (ltr, en), only when the face covers Latin. Arabic-only faces show line 1 only;
// Latin-primary faces that also carry Arabic stay Latin, unchanged.
import "./lib-ts-hooks.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ARABIC, BASIC_LATIN, buildSfnt } from "./ttc-fixture.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");
const { parseFontCollectionFromBuffer } = await import("../src/lib/fonts/parse-font.ts");
const { scriptDir, scriptLang, metaSample } = await import("../src/lib/fonts/scripts.ts");
const { previewSample } = await import("../src/lib/fonts/emoji.ts");
const { arabicPreviewLines, ARABIC_PANGRAM, isArabicPrimary } =
  await import("../src/lib/fonts/arabic-preview.ts");
const { googlePreviewTextQuery } = await import("../src/lib/fonts/loader.ts");

const PANGRAM = "نص حكيم له سر قاطع وذو شأن عظيم مكتوب على ثوب أخضر ومغلف بجلد أزرق";
const FOX = "The quick brown fox jumps over the lazy dog";
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const google = (family) => ({ family, source: "google", tags: [] });
const system = (family) => ({ family, source: "system", tags: [] });
async function importAs(family, cps) {
  const bytes = buildSfnt(family, cps);
  const [parsed] = await parseFontCollectionFromBuffer(`${family}.ttf`, bytes.length, ab(bytes));
  return {
    family: parsed.family,
    tags: parsed.tags,
    colorKind: parsed.colorKind,
    script: parsed.script,
    coversLatin: parsed.coversLatin,
    source: "local",
  };
}

test("the Arabic sample is the spec pangram with all 28 base letters", () => {
  assert.equal(ARABIC_PANGRAM, PANGRAM);
  assert.equal(metaSample("arabic"), PANGRAM);
  const base = "ابتثجحخدذرزسشصضطظعغفقكلمنهوي";
  assert.equal(base.length, 28);
  // أ counts as alif.
  const letters = new Set(PANGRAM.replace(/[أإآ]/g, "ا"));
  for (const ch of base) assert.ok(letters.has(ch), `missing ${ch}`);
});

test("the shipped catalog marks the 50 Arab-primary Google families", () => {
  const cat = JSON.parse(read("src/lib/fonts/google-catalog.json"));
  const arab = Object.entries(cat.primaryScript ?? {})
    .filter(([, s]) => s === "Arab")
    .map(([f]) => f);
  assert.equal(arab.length, 50);
  for (const f of [
    "Alexandria",
    "Mada",
    "Harmattan",
    "Kufam",
    "Readex Pro",
    "Vazirmatn",
    "Cairo",
    "Amiri",
  ]) {
    assert.ok(arab.includes(f), f);
  }
  for (const f of ["Rubik", "Changa", "Oi", "Handjet", "Alan Sans"])
    assert.ok(!arab.includes(f), f);
});

test("Arab-primary Google font that covers Latin: pangram rtl, then the user's sample ltr", () => {
  for (const family of ["Alexandria", "Vazirmatn", "Readex Pro", "Cairo"]) {
    const font = google(family);
    assert.equal(isArabicPrimary(font), true, family);
    assert.equal(scriptDir(font), "rtl");
    assert.equal(scriptLang(font), "ar");
    const lines = arabicPreviewLines(font, FOX);
    assert.deepEqual(lines, {
      primary: { text: PANGRAM, dir: "rtl", lang: "ar" },
      secondary: { text: FOX, dir: "ltr", lang: "en" },
    });
  }
});

test("Arabic-only face (cmap has no Latin) shows line 1 only", async () => {
  const font = await importAs("FMArabicOnly", [0x20, 0x2e, ...ARABIC]);
  assert.equal(font.script, "arabic");
  assert.equal(font.coversLatin, false);
  assert.deepEqual(arabicPreviewLines(font, FOX), {
    primary: { text: PANGRAM, dir: "rtl", lang: "ar" },
  });
});

test("upload whose name says Arabic and whose cmap covers Arabic and Latin gets both lines", async () => {
  const font = await importAs("Studio Naskh", [...BASIC_LATIN, ...ARABIC]);
  assert.equal(font.script, "arabic");
  assert.equal(font.coversLatin, true);
  assert.equal(arabicPreviewLines(font, FOX)?.secondary?.text, FOX);
});

test("upload whose name matches but has no Arabic glyphs stays Latin", async () => {
  const font = await importAs("Arabica Sans", BASIC_LATIN);
  assert.equal(arabicPreviewLines(font, FOX), null);
  assert.equal(previewSample(font, FOX), FOX);
  assert.equal(scriptDir(font), "ltr");
});

test("system face named for Arabic previews Arabic; Latin unknown, so line 1 only", () => {
  const font = system("Traditional Arabic");
  assert.equal(isArabicPrimary(font), true);
  assert.equal(scriptDir(font), "rtl");
  assert.deepEqual(arabicPreviewLines(font, FOX), {
    primary: { text: PANGRAM, dir: "rtl", lang: "ar" },
  });
});

test("Latin-primary faces that also carry Arabic stay Latin-only, unchanged", async () => {
  for (const font of [
    google("Rubik"),
    google("Changa"),
    google("Oi"),
    google("Handjet"),
    google("Alan Sans"),
    system("Cascadia Code"),
    system("Arial"),
    system("Tahoma"),
    system("Segoe UI"),
  ]) {
    assert.equal(isArabicPrimary(font), false, font.family);
    assert.equal(arabicPreviewLines(font, FOX), null, font.family);
    assert.equal(previewSample(font, FOX), FOX, font.family);
    assert.equal(scriptDir(font), "ltr", font.family);
  }
  const poppinsLike = await importAs("Plain Sans", [...BASIC_LATIN, ...ARABIC]);
  assert.equal(arabicPreviewLines(poppinsLike, FOX), null);
  assert.equal(previewSample(poppinsLike, FOX), FOX);
});

test("a user sample that already has Arabic is shown alone, rtl", () => {
  const mine = "سلام عليكم";
  assert.deepEqual(arabicPreviewLines(google("Alexandria"), mine), {
    primary: { text: mine, dir: "rtl", lang: "ar" },
  });
});

test("Google text= query for an Arab-primary font carries both lines' glyphs (cap 100)", () => {
  const q = decodeURIComponent(googlePreviewTextQuery(google("Alexandria")));
  const latin = "The quick brown fox jumps over the lazy dog ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789";
  for (const ch of new Set(PANGRAM)) assert.ok(q.includes(ch), `arabic ${ch}`);
  for (const ch of new Set(latin)) assert.ok(q.includes(ch), `latin ${ch}`);
  assert.ok(q.length <= 100);
  assert.match(read("src/lib/fonts/loader.ts"), /out\.length >= 100/);
  // Latin-primary fonts keep the Latin pangram only.
  assert.doesNotMatch(
    decodeURIComponent(googlePreviewTextQuery(google("Rubik"))),
    /[\u0600-\u06ff]/,
  );
});

test("card and inspector render line 2 at 0.5em, ltr/en, after the rtl line", () => {
  for (const rel of [
    "src/components/font-studio/font-card.tsx",
    "src/components/font-studio/font-inspector.tsx",
  ]) {
    const src = read(rel);
    assert.match(src, /arabicPreviewLines\(/, rel);
    assert.match(src, /<ArabicPreviewText\b/, rel);
  }
  const comp = read("src/components/font-studio/arabic-preview-text.tsx");
  assert.match(comp, /dir=\{lines\.secondary\.dir\}/);
  assert.match(comp, /lang=\{lines\.secondary\.lang\}/);
  assert.match(comp, /fontSize: "0\.5em"/);
});
