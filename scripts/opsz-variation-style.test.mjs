import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 1.0.174: opsz must ride in font-variation-settings (no numeric CSS opsz).
 * Mirrors src/lib/fonts/axes.ts variationStyle / variationCss contract.
 */

const HIGH_LEVEL_AXES = new Set(["wght", "wdth", "slnt", "ital"]);

function clampAxis(axis, n) {
  if (!Number.isFinite(n)) return axis.def;
  return Math.min(axis.max, Math.max(axis.min, n));
}

function formatAxisValue(axis, n) {
  const v = axis ? clampAxis(axis, n) : n;
  if (Number.isInteger(v)) return v;
  return Number(v.toFixed(1));
}

function variationCss(values, axes = []) {
  const keys = axes.length ? axes.map((a) => a.tag).sort() : Object.keys(values).sort();
  const byTag = new Map(axes.map((a) => [a.tag, a]));
  const parts = keys.map((tag) => {
    const axis = byTag.get(tag);
    const raw = values[tag] ?? axis?.def ?? 0;
    return `"${tag}" ${formatAxisValue(axis, raw)}`;
  });
  return parts.length ? parts.join(", ") : "normal";
}

function variationStyle(values, axes = []) {
  const wght = values.wght;
  const ital = values.ital;
  const slnt = values.slnt;
  const wdth = values.wdth;
  const customAxes = axes.filter((axis) => !HIGH_LEVEL_AXES.has(axis.tag));
  const customValues = {};
  for (const [tag, n] of Object.entries(values)) {
    if (!HIGH_LEVEL_AXES.has(tag) && Number.isFinite(n)) customValues[tag] = n;
  }
  const fvs =
    customAxes.length || Object.keys(customValues).length
      ? variationCss(customValues, customAxes)
      : "normal";
  const opszInFvs = fvs.includes('"opsz"');
  return {
    fontVariationSettings: fvs,
    fontWeight: typeof wght === "number" ? Math.round(clampAxis({ tag: "wght", min: 1, max: 1000, def: 400 }, wght)) : undefined,
    fontStretch: typeof wdth === "number" ? `${wdth}%` : undefined,
    fontStyle:
      typeof ital === "number" && ital >= 0.5
        ? "italic"
        : typeof slnt === "number" && slnt !== 0
          ? `oblique ${Number((-slnt).toFixed(1))}deg`
          : "normal",
    ...(opszInFvs ? { fontOpticalSizing: "none" } : {}),
  };
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const axesSrc = readFileSync(join(root, "src/lib/fonts/axes.ts"), "utf8");

test("axes.ts: opsz is not in HIGH_LEVEL_AXES", () => {
  const m = axesSrc.match(/const HIGH_LEVEL_AXES = new Set\(\[([^\]]+)\]\)/);
  assert.ok(m, "HIGH_LEVEL_AXES declaration");
  assert.equal(m[1].includes('"opsz"') || m[1].includes("'opsz'"), false);
  assert.match(m[1], /"wght"/);
});

test("variationStyle with opsz axis includes opsz in fontVariationSettings", () => {
  const axes = [
    { tag: "wght", name: "Weight", min: 100, max: 900, def: 400 },
    { tag: "opsz", name: "Optical size", min: 8, max: 144, def: 14 },
  ];
  const style = variationStyle({ wght: 500, opsz: 36 }, axes);
  assert.match(style.fontVariationSettings, /"opsz"\s+36/);
  assert.equal(style.fontWeight, 500);
  assert.equal(style.fontOpticalSizing, "none");
  assert.equal(style.fontVariationSettings.includes('"wght"'), false);
});

test("variationStyle without opsz leaves optical sizing unset", () => {
  const axes = [{ tag: "wght", name: "Weight", min: 100, max: 900, def: 400 }];
  const style = variationStyle({ wght: 400 }, axes);
  assert.equal(style.fontVariationSettings, "normal");
  assert.equal(style.fontOpticalSizing, undefined);
});

test("card path: stripping opsz keeps auto-compatible FVS", () => {
  const axes = [
    { tag: "wght", name: "Weight", min: 100, max: 900, def: 400 },
    { tag: "opsz", name: "Optical size", min: 8, max: 144, def: 14 },
  ];
  const values = { wght: 400, opsz: 14 };
  const userOpsz = false;
  const styleAxes = userOpsz ? axes : axes.filter((a) => a.tag !== "opsz");
  const styleValues = Object.fromEntries(Object.entries(values).filter(([tag]) => tag !== "opsz"));
  const style = variationStyle(styleValues, styleAxes);
  assert.equal(style.fontVariationSettings.includes('"opsz"'), false);
  assert.equal(style.fontOpticalSizing, undefined);
});

const versionSrc = readFileSync(join(root, "src/version.ts"), "utf8");
const inspectorSrc = readFileSync(join(root, "src/components/font-studio/font-inspector.tsx"), "utf8");
const playgroundSrc = readFileSync(join(root, "src/components/font-studio/playground.tsx"), "utf8");
const cardSrc = readFileSync(join(root, "src/components/font-studio/font-card.tsx"), "utf8");

test("version.ts APP_VERSION is 1.0.206", () => {
  assert.match(versionSrc, /export const APP_VERSION = "1\.0\.206"/);
});

test("italicPreviewStyle does not emit full-axis FVS (no variationCss call)", () => {
  const fn = axesSrc.match(/export function italicPreviewStyle[\s\S]*?\n\}/);
  assert.ok(fn, "italicPreviewStyle function");
  assert.equal(fn[0].includes("variationCss("), false);
  assert.match(fn[0], /fontVariationSettings:\s*undefined/);
});

test("inspector: variable FVS prefers axisStyle, not italicCss", () => {
  assert.match(
    inspectorSrc,
    /fontVariationSettings:\s*font\.variable\s*\?\s*axisStyle\.fontVariationSettings/,
  );
  assert.equal(inspectorSrc.includes("italicCss.fontVariationSettings ?? axisStyle.fontVariationSettings"), false);
  assert.match(inspectorSrc, /fontOpticalSizing:\s*font\.variable \? axisStyle\.fontOpticalSizing/);
});

test("playground: both panes spread leftVarStyle/rightVarStyle from variationStyle", () => {
  assert.match(playgroundSrc, /const leftVarStyle = left\?\.variable/);
  assert.match(playgroundSrc, /const rightVarStyle = right\?\.variable/);
  assert.match(playgroundSrc, /variationStyle\(/);
  const spreads = playgroundSrc.match(/\.\.\.\(leftVarStyle \?\? \{\}\)/g) || [];
  const spreadsR = playgroundSrc.match(/\.\.\.\(rightVarStyle \?\? \{\}\)/g) || [];
  assert.equal(spreads.length, 2, "left pane edit+preview");
  assert.equal(spreadsR.length, 2, "right pane edit+preview");
});

test("card keeps auto until storedAxes.opsz override", () => {
  assert.match(cardSrc, /userOpsz = typeof storedAxes\?\.opsz === "number"/);
  assert.match(cardSrc, /fontOpticalSizing:\s*vs\?\.fontOpticalSizing \?\? \(catalogVf \? "auto"/);
});

test("wght stays high-level: opsz+wght together does not put wght in FVS", () => {
  const axes = [
    { tag: "wght", name: "Weight", min: 100, max: 900, def: 400 },
    { tag: "wdth", name: "Width", min: 75, max: 125, def: 100 },
    { tag: "slnt", name: "Slant", min: -15, max: 0, def: 0 },
    { tag: "ital", name: "Italic", min: 0, max: 1, def: 0 },
    { tag: "opsz", name: "Optical size", min: 8, max: 144, def: 14 },
  ];
  const style = variationStyle({ wght: 700, wdth: 90, slnt: -10, ital: 1, opsz: 48 }, axes);
  assert.match(style.fontVariationSettings, /"opsz"\s+48/);
  for (const tag of ["wght", "wdth", "slnt", "ital"]) {
    assert.equal(style.fontVariationSettings.includes(`"${tag}"`), false, tag);
  }
  assert.equal(style.fontWeight, 700);
  assert.equal(style.fontStretch, "90%");
  assert.equal(style.fontStyle, "italic");
  assert.equal(style.fontOpticalSizing, "none");
});
