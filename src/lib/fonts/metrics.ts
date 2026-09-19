/** SuperSearch metrics from OS/2 + head — never glyf raster (20k-safe). */

import { previewWghtAxis } from "./axes.ts";
import { isWoff2OnlyVariableFamily } from "./heal-catalog.ts";
import { fontLicense, licenseSearchHay } from "./license.ts";
import type { FontMetrics, FontRecord } from "./types.ts";

export type { FontMetrics };

export type SearchClause =
  | { kind: "hay"; value: string }
  | { kind: "range"; field: "xh" | "contrast" | "weight" | "width"; min: number; max: number }
  | { kind: "axis"; tag: string; min: number; max: number }
  | { kind: "flag"; flag: "variable" | "italic" }
  | { kind: "tag"; value: string }
  | { kind: "license"; value: string }
  | { kind: "name"; value: string };

export const SEARCH_PRESETS: { id: string; label: string; token: string; hint: string; group?: string }[] = [
  { id: "xh-high", label: "High x-height", token: "xh:0.52-1", hint: "OS/2 sxHeight / UPM", group: "xh" },
  { id: "xh-low", label: "Low x-height", token: "xh:0-0.45", hint: "Smaller lowercase", group: "xh" },
  { id: "ctr-high", label: "High contrast", token: "contrast:high", hint: "PANOSE, not a stem raster", group: "contrast" },
  { id: "ctr-low", label: "Low contrast", token: "contrast:low", hint: "Even stroke", group: "contrast" },
  { id: "heavy", label: "Heavy", token: "weight:700-1000", hint: "Weight class or wght axis", group: "weight" },
  { id: "light", label: "Light", token: "weight:100-350", hint: "Thin–light", group: "weight" },
  { id: "condensed", label: "Condensed", token: "width:condensed", hint: "Width class 1–4 or wdth", group: "width" },
  { id: "expanded", label: "Expanded", token: "width:expanded", hint: "Width class 6–9", group: "width" },
  { id: "opsz-text", label: "Text opsz", token: "opsz:6-18", hint: "Caption–text optical size", group: "opsz" },
  { id: "opsz-display", label: "Display opsz", token: "opsz:36-144", hint: "Display optical size", group: "opsz" },
  { id: "variable", label: "Variable", token: "variable", hint: "Catalog VF or on-disk fvar" },
  { id: "italic", label: "Italic", token: "italic", hint: "Italic faces" },
];

const WDTH_STOPS = [50, 62.5, 75, 87.5, 100, 112.5, 125, 150, 200];

function clamp01(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function panoseContrast(panose?: number[]): number | undefined {
  if (!panose?.length) return undefined;
  const family = (panose[0] ?? 0) & 0xff;
  const contrast = (panose[4] ?? 0) & 0xff;
  if (family !== 2) return undefined;
  if (contrast <= 1) return undefined;
  return clamp01((contrast - 2) / 7);
}

/** Map fvar `wdth` percent onto OS/2 usWidthClass 1–9. */
export function wdthToClass(n: number): number {
  if (!Number.isFinite(n)) return 5;
  let best = 5;
  let dist = Infinity;
  for (let i = 0; i < WDTH_STOPS.length; i += 1) {
    const d = Math.abs(n - WDTH_STOPS[i]!);
    if (d < dist) {
      dist = d;
      best = i + 1;
    }
  }
  return best;
}

export function metricsFromTables(input: {
  upem?: number;
  weightClass?: number;
  widthClass?: number;
  xHeight?: number;
  capHeight?: number;
  panose?: number[];
}): FontMetrics {
  const upem = input.upem && input.upem > 0 ? input.upem : 1000;
  const weightClass =
    input.weightClass && input.weightClass >= 1 && input.weightClass <= 1000 ? Math.round(input.weightClass) : 400;
  const widthClass =
    input.widthClass && input.widthClass >= 1 && input.widthClass <= 9 ? Math.round(input.widthClass) : 5;
  const xHeight = input.xHeight && input.xHeight > 0 ? input.xHeight : undefined;
  const capHeight = input.capHeight && input.capHeight > 0 ? input.capHeight : undefined;
  const xh = xHeight ? clamp01(xHeight / upem) : undefined;
  const contrast = panoseContrast(input.panose);
  return { upem, weightClass, widthClass, xHeight, capHeight, contrast, xh };
}

export function mergeMetrics(prev: FontMetrics | undefined, next: FontMetrics): FontMetrics {
  return {
    upem: next.upem || prev?.upem || 1000,
    weightClass: next.weightClass || prev?.weightClass || 400,
    widthClass: next.widthClass || prev?.widthClass || 5,
    xHeight: next.xHeight ?? prev?.xHeight,
    capHeight: next.capHeight ?? prev?.capHeight,
    contrast: next.contrast ?? prev?.contrast,
    xh: next.xh ?? prev?.xh,
  };
}

function isVariableFamily(font: FontRecord) {
  if (isWoff2OnlyVariableFamily(font.family)) return false;
  return Boolean(font.variable || font.catalogVariable);
}

function tagsOf(font: FontRecord, customTags: Record<string, string[]>): string[] {
  const extra = customTags[font.id] ?? [];
  return Array.from(new Set([...(font.tags ?? []), ...extra]));
}

function hayFor(font: FontRecord, tags: string[]): string {
  return [
    font.family,
    font.fullName ?? "",
    font.source,
    font.category,
    ...tags,
    font.variable || font.catalogVariable ? "variable" : "",
    font.italic ? "italic" : "",
    font.fileName ?? "",
    licenseSearchHay(font),
    ...(font.axes ?? []).map((a) => a.tag),
  ]
    .join(" ")
    .toLowerCase();
}

export function metricsFor(font: FontRecord): FontMetrics {
  if (font.metrics) return font.metrics;
  const tags = font.tags ?? [];
  let widthClass = 5;
  if (tags.includes("condensed")) widthClass = 3;
  else if (tags.includes("expanded") || tags.includes("wide")) widthClass = 7;
  const ws = font.weights?.filter((n) => Number.isFinite(n) && n > 0) ?? [];
  const weightClass = ws.includes(400) ? 400 : ws[0] ?? 400;
  return { upem: 1000, weightClass, widthClass };
}

const WEIGHT_NAME: Record<string, [number, number]> = {
  thin: [100, 200],
  hairline: [100, 200],
  extralight: [200, 300],
  ultralight: [200, 300],
  light: [200, 350],
  regular: [350, 500],
  book: [350, 500],
  medium: [500, 600],
  semibold: [600, 750],
  demibold: [600, 750],
  bold: [600, 850],
  extrabold: [800, 1000],
  ultrabold: [800, 1000],
  black: [800, 1000],
  heavy: [800, 1000],
};

const WIDTH_NAME: Record<string, [number, number]> = {
  condensed: [1, 4],
  compact: [1, 4],
  narrow: [1, 4],
  normal: [5, 5],
  regular: [5, 5],
  expanded: [6, 9],
  extended: [6, 9],
  wide: [6, 9],
};

const CONTRAST_NAME: Record<string, [number, number]> = {
  none: [0, 0.2],
  low: [0, 0.4],
  medium: [0.35, 0.7],
  high: [0.65, 1],
};

const AXIS_TAG = /^(wght|wdth|opsz|slnt|ital|grad|soft|casl|wonk|crsv|mono|fill|xopq|yopq|xtra|ytuc|ytlc|ytas|ytde)$/i;

function parseBoundPair(
  raw: string,
  names: Record<string, [number, number]> | undefined,
  scaleIfUnit: boolean,
): [number, number] | null {
  if (names) {
    const named = names[raw];
    if (named) return named;
  }
  const m = raw.match(/^(-?\d+(?:\.\d+)?)(?:\.\.(-?\d+(?:\.\d+)?))?(?:-(-?\d+(?:\.\d+)?))?$/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[3] != null ? Number(m[3]) : m[2] != null ? Number(m[2]) : a;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  let min = Math.min(a, b);
  let max = Math.max(a, b);
  if (scaleIfUnit && max <= 1) {
    min *= 1000;
    max *= 1000;
  }
  return [min, max];
}

export function parseSearchQuery(query: string): SearchClause[] {
  const q = query.trim();
  if (!q) return [];
  const tokens = q.split(/\s+/);
  const out: SearchClause[] = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    const colon = lower.indexOf(":");
    if (colon <= 0) {
      if (lower === "variable") out.push({ kind: "flag", flag: "variable" });
      else if (lower === "italic") out.push({ kind: "flag", flag: "italic" });
      else out.push({ kind: "hay", value: lower });
      continue;
    }
    const key = lower.slice(0, colon);
    const val = lower.slice(colon + 1);
    if (!val) {
      out.push({ kind: "hay", value: lower });
      continue;
    }
    if (key === "tag") {
      out.push({ kind: "tag", value: val });
      continue;
    }
    if (key === "license") {
      out.push({ kind: "license", value: val });
      continue;
    }
    if (key === "name") {
      out.push({ kind: "name", value: val });
      continue;
    }
    if (key === "variable" && (val === "1" || val === "true" || val === "yes")) {
      out.push({ kind: "flag", flag: "variable" });
      continue;
    }
    if (key === "italic" && (val === "1" || val === "true" || val === "yes")) {
      out.push({ kind: "flag", flag: "italic" });
      continue;
    }
    if (key === "xh" || key === "xheight" || key === "x-height") {
      const pair = parseBoundPair(val, undefined, false);
      out.push(pair ? { kind: "range", field: "xh", min: pair[0], max: pair[1] } : { kind: "hay", value: lower });
      continue;
    }
    if (key === "contrast" || key === "ctr") {
      const pair = parseBoundPair(val, CONTRAST_NAME, false);
      out.push(pair ? { kind: "range", field: "contrast", min: pair[0], max: pair[1] } : { kind: "hay", value: lower });
      continue;
    }
    if (key === "width") {
      const pair = parseBoundPair(val, WIDTH_NAME, false);
      out.push(pair ? { kind: "range", field: "width", min: pair[0], max: pair[1] } : { kind: "hay", value: lower });
      continue;
    }
    if (key === "weight") {
      const pair = parseBoundPair(val, WEIGHT_NAME, true);
      out.push(pair ? { kind: "range", field: "weight", min: pair[0], max: pair[1] } : { kind: "hay", value: lower });
      continue;
    }
    if (key === "axis") {
      const eq = val.indexOf("=");
      const tag = (eq > 0 ? val.slice(0, eq) : val.slice(0, 4)).toLowerCase();
      const rest = eq > 0 ? val.slice(eq + 1) : "";
      const pair = parseBoundPair(rest || "0-1000", undefined, false);
      if (tag && pair) out.push({ kind: "axis", tag, min: pair[0], max: pair[1] });
      else out.push({ kind: "hay", value: lower });
      continue;
    }
    if (AXIS_TAG.test(key) || (key.length === 4 && /^[a-z]{4}$/.test(key))) {
      const pair = parseBoundPair(val, key === "wght" ? WEIGHT_NAME : undefined, key === "wght");
      if (pair) out.push({ kind: "axis", tag: key, min: pair[0], max: pair[1] });
      else out.push({ kind: "hay", value: lower });
      continue;
    }
    out.push({ kind: "hay", value: lower });
  }
  return out;
}

function overlaps(aMin: number, aMax: number, bMin: number, bMax: number) {
  return aMax + 1e-4 >= bMin && bMax + 1e-4 >= aMin;
}

function weightSpan(font: FontRecord, metrics: FontMetrics): [number, number] {
  const wght = previewWghtAxis(font);
  if (wght) return [wght.min, wght.max];
  const ws = font.weights?.length ? font.weights : [metrics.weightClass];
  return [Math.min(...ws), Math.max(...ws)];
}

function widthSpan(font: FontRecord, metrics: FontMetrics): [number, number] {
  const wdth = (font.axes ?? []).find((a) => a.tag === "wdth");
  if (wdth && wdth.max > wdth.min) {
    return [wdthToClass(wdth.min), wdthToClass(wdth.max)].sort((a, b) => a - b) as [number, number];
  }
  return [metrics.widthClass, metrics.widthClass];
}

export function fontMatchesSearch(
  font: FontRecord,
  clauses: SearchClause[],
  customTags: Record<string, string[]>,
): boolean {
  if (!clauses.length) return true;
  const metrics = metricsFor(font);
  const tags = tagsOf(font, customTags);
  const needsHay = clauses.some((c) => c.kind === "hay");
  return matchClauses(font, clauses, metrics, tags, needsHay ? hayFor(font, tags) : "");
}

function matchClauses(
  font: FontRecord,
  clauses: SearchClause[],
  metrics: FontMetrics,
  tags: string[],
  hay: string,
): boolean {
  return clauses.every((clause) => {
    switch (clause.kind) {
      case "hay":
        return hay.includes(clause.value);
      case "name":
        return (
          font.family.toLowerCase().includes(clause.value) ||
          (font.fullName ?? "").toLowerCase().includes(clause.value)
        );
      case "tag":
        return tags.some((t) => t.toLowerCase() === clause.value);
      case "license":
        return fontLicense(font) === clause.value;
      case "flag":
        return clause.flag === "variable" ? isVariableFamily(font) : Boolean(font.italic);
      case "range": {
        if (clause.field === "xh") {
          if (metrics.xh == null) return false;
          return metrics.xh >= clause.min && metrics.xh <= clause.max;
        }
        if (clause.field === "contrast") {
          if (metrics.contrast == null) return false;
          return metrics.contrast >= clause.min && metrics.contrast <= clause.max;
        }
        if (clause.field === "weight") {
          const [min, max] = weightSpan(font, metrics);
          return overlaps(min, max, clause.min, clause.max);
        }
        const [min, max] = widthSpan(font, metrics);
        return overlaps(min, max, clause.min, clause.max);
      }
      case "axis": {
        const real = (font.axes ?? []).find((a) => a.tag.toLowerCase() === clause.tag);
        if (real) return overlaps(real.min, real.max, clause.min, clause.max);
        if (clause.tag === "wght") {
          const inferred = previewWghtAxis(font);
          if (inferred) return overlaps(inferred.min, inferred.max, clause.min, clause.max);
          const [min, max] = weightSpan(font, metrics);
          return overlaps(min, max, clause.min, clause.max);
        }
        return false;
      }
      default:
        return true;
    }
  });
}

export function contrastLabel(contrast?: number): string | null {
  if (contrast == null) return null;
  if (contrast >= 0.65) return "high";
  if (contrast >= 0.35) return "medium";
  return "low";
}

export function formatXh(xh?: number): string | null {
  if (xh == null) return null;
  return xh.toFixed(2);
}

export function widthClassLabel(n?: number): string | null {
  if (!n || n < 1 || n > 9) return null;
  return (
    [
      "Ultra condensed",
      "Extra condensed",
      "Condensed",
      "Semi condensed",
      "Normal",
      "Semi expanded",
      "Expanded",
      "Extra expanded",
      "Ultra expanded",
    ][n - 1] ?? null
  );
}

export function toggleSearchToken(query: string, token: string): string {
  const parts = query.trim().split(/\s+/).filter(Boolean);
  const hit = parts.findIndex((p) => p.toLowerCase() === token.toLowerCase());
  if (hit >= 0) parts.splice(hit, 1);
  else parts.push(token);
  return parts.join(" ");
}

/** Toggle a SuperSearch preset; sibling chips in the same group replace each other. */
export function toggleSearchPreset(query: string, token: string): string {
  const preset = SEARCH_PRESETS.find((p) => p.token.toLowerCase() === token.toLowerCase());
  const siblings = SEARCH_PRESETS.filter((p) => p.group && p.group === preset?.group).map((p) => p.token.toLowerCase());
  const parts = query.trim().split(/\s+/).filter(Boolean);
  const key = token.toLowerCase();
  const had = parts.some((p) => p.toLowerCase() === key);
  const next = parts.filter((p) => p.toLowerCase() !== key && !siblings.includes(p.toLowerCase()));
  if (!had) next.push(token);
  return next.join(" ");
}

export function queryHasToken(query: string, token: string): boolean {
  return query
    .trim()
    .split(/\s+/)
    .some((p) => p.toLowerCase() === token.toLowerCase());
}

export function queryTokenCount(query: string): number {
  return parseSearchQuery(query).length;
}

/** Counts per SuperSearch preset in this drawer (no hay). Hide 0-count chips.
 *  Metrics + tags once per font — 12× fontMatchesSearch would hitch 20k. */
export function countSearchPresets(
  fonts: FontRecord[],
  customTags: Record<string, string[]>,
): Record<string, number> {
  const parsed = SEARCH_PRESETS.map((p) => {
    const clauses = parseSearchQuery(p.token);
    return { id: p.id, clauses, needsHay: clauses.some((c) => c.kind === "hay") };
  });
  const counts: Record<string, number> = {};
  for (const p of parsed) counts[p.id] = 0;
  const anyHay = parsed.some((p) => p.needsHay);
  for (const font of fonts) {
    const metrics = metricsFor(font);
    const tags = tagsOf(font, customTags);
    const hay = anyHay ? hayFor(font, tags) : "";
    for (const p of parsed) {
      if (matchClauses(font, p.clauses, metrics, tags, p.needsHay ? hay : "")) {
        counts[p.id] += 1;
      }
    }
  }
  return counts;
}
