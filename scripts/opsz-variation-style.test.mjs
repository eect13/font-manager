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
