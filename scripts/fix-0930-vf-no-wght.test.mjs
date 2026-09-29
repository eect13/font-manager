// Card 20: variable families with no wght axis (Agu Display: MORF only) must
// not request css2 ...:wght@100..900 — Google answers HTTP 400 and the card
// stays on the fallback face (review 1 issue 4, loader.ts:379-385).
// Behaviour test: runs the real loader URL builders with stubbed helpers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const loader = readFileSync(join(root, "src/lib/fonts/loader.ts"), "utf8");
const axes = readFileSync(join(root, "src/lib/fonts/axes.ts"), "utf8");

const strip = (s) =>
  stripTypeScriptTypes(s.replaceAll("export function", "function"), { mode: "strip" });
const axesChunk = axes.slice(
  axes.indexOf("export function previewWghtAxis"),
  axes.indexOf("export function", axes.indexOf("export function previewWghtAxis") + 10),
);
const loaderChunk = loader.slice(
  loader.indexOf("function previewIsVf"),
  loader.indexOf("export function googlePreviewMayUseLocalDisk"),
);
const axesForFont = (font) => (font.axes ?? []).filter((a) => a.max > a.min);
const { previewFamilyParam, googlePreviewCssHref } = new Function(
  "axesForFont",
  "scriptSampleText",
  "scriptSubset",
  "isSpecialPreviewFont",
  `${strip(axesChunk)}\n${strip(loaderChunk)}\nreturn { previewFamilyParam, googlePreviewCssHref };`,
)(axesForFont, () => "Aa", () => "latin", () => false);

const agu = { family: "Agu Display", catalogVariable: true, variable: false, weights: [400], italic: false };
const aguMorf = {
  ...agu,
  variable: true,
  axes: [{ tag: "MORF", name: "Morph", min: 0, max: 100, def: 0 }],
};
const inter = {
  family: "Inter",
  catalogVariable: true,
  variable: false,
  italic: true,
  weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
};
const lora = { family: "Lora", catalogVariable: false, variable: false, weights: [400, 700], italic: true };

test("no-wght variable family: no fake wght range in any css2 URL", () => {
  for (const f of [agu, aguMorf]) {
    assert.doesNotMatch(previewFamilyParam(f), /wght@/, "previewFamilyParam");
    assert.doesNotMatch(googlePreviewCssHref(f), /wght@/, "googlePreviewCssHref");
    assert.match(googlePreviewCssHref(f), /family=Agu\+Display&/);
  }
});

test("real wght range and static families keep their URLs", () => {
  assert.match(previewFamilyParam(inter), /ital,wght@0,100\.\.900/);
  assert.match(googlePreviewCssHref(inter), /wght@100\.\.900/);
  assert.equal(previewFamilyParam(lora), "family=Lora:ital,wght@0,400");
  assert.match(googlePreviewCssHref(lora), /family=Lora:wght@400&/);
});
