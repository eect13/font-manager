import type { FontRecord } from "./types";

export interface FontAxis {
  tag: string;
  name: string;
  min: number;
  max: number;
  def: number;
}

/**
 * Registered (OpenType 1.9) plus common custom axes.
 * `ital` is 0/1. Smooth lean is `slnt` (usually degrees, often negative).
 * `opsz` tracks point size unless overridden.
 */
const AXIS_NAME: Record<string, string> = {
  wght: "Weight",
  wdth: "Width",
  slnt: "Slant",
  opsz: "Optical size",
  ital: "Italic",
  GRAD: "Grade",
  GDEF: "Grade",
  SOFT: "Softness",
  WONK: "Wonky",
  CASL: "Casual",
  CRSV: "Cursive",
  MONO: "Monospace",
  FILL: "Fill",
  XTRA: "X transparent",
  YOPQ: "Y opaque",
  XOPQ: "X opaque",
  YTUC: "Y uppercase",
  YTLC: "Y lowercase",
  YTAS: "Y ascender",
  YTDE: "Y descender",
  YTFI: "Y figures",
  YTOS: "Y overshoot",
  BLED: "Bleed",
  EHLT: "Highlight",
  HEXQ: "Hexq",
};

export function axisLabel(tag: string, name?: string) {
  if (name && name.trim() && name !== tag) return name;
  return AXIS_NAME[tag] ?? tag;
}

/** OpenType registered `ital` is on/off. Do not treat FILL/WONK as switches. */
export function isBinaryAxis(axis: FontAxis) {
  return axis.tag === "ital";
}

export function axisStep(axis: FontAxis) {
  if (isBinaryAxis(axis)) return 1;
  const span = axis.max - axis.min;
  if (axis.tag === "wght") return 1;
  if (axis.tag === "opsz") return span > 50 ? 1 : 0.1;
  if (span <= 1) return 0.01;
  if (span <= 2) return 0.1;
  if (span <= 30) return 0.5;
  return 1;
}

export function clampAxis(axis: FontAxis, n: number) {
  if (!Number.isFinite(n)) return axis.def;
  return Math.min(axis.max, Math.max(axis.min, n));
}

export function axesForFont(font: Pick<FontRecord, "weights" | "variable" | "italic" | "axes">): FontAxis[] {
  if (font.axes && font.axes.length) {
    return font.axes
      .map((axis) =>
        axis.tag === "ital" ? { ...axis, min: 0, max: 1, def: axis.def >= 0.5 ? 1 : 0 } : axis,
      )
      .filter((axis) => isBinaryAxis(axis) || axis.max > axis.min);
  }
  if (!font.variable) return [];
  const weights = font.weights.length ? font.weights : [400];
  const min = Math.min(...weights);
  const max = Math.max(...weights);
  const def = weights.includes(400) ? 400 : clampAxis({ tag: "wght", name: "", min, max, def: min }, 400);
  return [{ tag: "wght", name: "Weight", min: min === max ? 100 : min, max: min === max ? 900 : max, def }];
}

/** fvar default, else Regular (400) if the family has it, else the first listed weight. */
export function defaultWeightForFont(font: Pick<FontRecord, "weights" | "variable" | "italic" | "axes" | "instances">): number {
  const regular = instancesForFont(font).find((inst) => /^(regular|normal|book|roman)$/i.test(inst.name));
  if (typeof regular?.coords.wght === "number") return Math.round(regular.coords.wght);
  const wght = axesForFont(font).find((a) => a.tag === "wght");
  if (wght) return Math.round(wght.def);
  if (font.weights.includes(400)) return 400;
  return font.weights[0] ?? 400;
}

/** Axis defaults from the file (fvar defaultValue / Regular instance). Never force 400 or opsz = preview size. */
export function defaultAxisValues(axes: FontAxis[], instances: NamedInstance[] = []): Record<string, number> {
  const out: Record<string, number> = {};
  for (const axis of axes) out[axis.tag] = axis.def;
  const regular = instances.find((inst) => /^(regular|normal|book|roman)$/i.test(inst.name));
  if (regular) {
    for (const [tag, n] of Object.entries(regular.coords)) {
      if (Number.isFinite(n)) out[tag] = n;
    }
  }
  return out;
}

/** Fill missing tags so sliders never start at 0 and FVS lists the full tuple. */
export function resolvedAxisValues(axes: FontAxis[], values: Record<string, number> = {}, instances: NamedInstance[] = []): Record<string, number> {
  const next = defaultAxisValues(axes, instances);
  for (const [tag, n] of Object.entries(values)) {
    if (Number.isFinite(n)) next[tag] = n;
  }
  return next;
}

function formatAxisValue(axis: FontAxis | undefined, n: number) {
  if (axis && isBinaryAxis(axis)) return n >= 0.5 ? 1 : 0;
  const v = axis ? clampAxis(axis, n) : n;
  if (Number.isInteger(v)) return v;
  const step = axis ? axisStep(axis) : 0.01;
  if (step >= 1) return Math.round(v);
  return Number(v.toFixed(step < 0.1 ? 2 : 1));
}

export function variationCss(values: Record<string, number>, axes: FontAxis[] = []): string {
  const keys = axes.length ? axes.map((a) => a.tag).sort() : Object.keys(values).sort();
  const byTag = new Map(axes.map((a) => [a.tag, a]));
  const parts = keys.map((tag) => {
    const axis = byTag.get(tag);
    const raw = values[tag] ?? axis?.def ?? 0;
    return `"${tag}" ${formatAxisValue(axis, raw)}`;
  });
  return parts.length ? parts.join(", ") : "normal";
}

/**
 * High-level CSS for registered axes + font-variation-settings for the full tuple.
 * font-weight/style keep GDI-ish apps and older Chromium in sync with wght/ital.
 */
export function variationStyle(
  values: Record<string, number>,
  axes: FontAxis[] = [],
): {
  fontVariationSettings: string;
  fontWeight?: number;
  fontStyle?: string;
  fontStretch?: string;
} {
  const wght = values.wght;
  const ital = values.ital;
  const slnt = values.slnt;
  const wdth = values.wdth;
  return {
    fontVariationSettings: variationCss(values, axes),
    fontWeight: typeof wght === "number" ? Math.round(clampAxis({ tag: "wght", name: "", min: 1, max: 1000, def: 400 }, wght)) : undefined,
    fontStretch: typeof wdth === "number" ? `${wdth}%` : undefined,
    fontStyle:
      typeof ital === "number" && ital >= 0.5
        ? "italic"
        : typeof slnt === "number" && slnt !== 0
          ? `oblique ${Number((-slnt).toFixed(1))}deg`
          : "normal",
  };
}

export interface NamedInstance {
  name: string;
  coords: Record<string, number>;
}

const WEIGHT_INSTANCE: Record<number, string> = {
  100: "Thin",
  200: "ExtraLight",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "SemiBold",
  700: "Bold",
  800: "ExtraBold",
  900: "Black",
};

export function instancesForFont(
  font: Pick<FontRecord, "weights" | "variable" | "italic" | "axes" | "instances">,
): NamedInstance[] {
  if (font.instances?.length) return font.instances;
  if (!font.variable) return [];
  const axes = axesForFont(font);
  const wght = axes.find((a) => a.tag === "wght");
  if (!wght) return [];
  const weights = font.weights.length ? font.weights : [wght.def];
  return weights.map((w) => ({
    name: WEIGHT_INSTANCE[w] ?? String(w),
    coords: { wght: w },
  }));
}

export function instanceMatches(instance: NamedInstance, values: Record<string, number>) {
  return Object.entries(instance.coords).every(([tag, n]) => Math.abs((values[tag] ?? 0) - n) < 0.51);
}

/** Roman (upright) axis tuple — zeros ital/slnt so VF preview is not stuck italic. */
export function previewAxisValues(
  font: Pick<FontRecord, "weights" | "variable" | "italic" | "axes" | "instances">,
  stored: Record<string, number> | undefined,
  weight: number,
  italicOn: boolean,
): Record<string, number> {
  const axes = axesForFont(font);
  const values: Record<string, number> = {
    ...defaultAxisValues(axes, instancesForFont(font)),
    ...(stored ?? {}),
    wght: weight,
  };
  const ital = axes.find((a) => a.tag === "ital");
  const slnt = axes.find((a) => a.tag === "slnt");
  if (italicOn) {
    if (ital) values.ital = 1;
    else if (slnt) values.slnt = slnt.min < 0 ? slnt.min : slnt.max;
  } else {
    if (ital) values.ital = 0;
    if (slnt && slnt.min <= 0 && slnt.max >= 0) values.slnt = 0;
    else if (slnt) values.slnt = slnt.def;
  }
  return values;
}

export function realItalicAxes(font: Pick<FontRecord, "axes">) {
  const axes = font.axes ?? [];
  return {
    ital: axes.find((a) => a.tag === "ital"),
    slnt: axes.find((a) => a.tag === "slnt"),
  };
}

/** True ital/slnt from the file’s fvar, or a real italic face (not browser slant). */
export function hasRealItalic(font: Pick<FontRecord, "italic" | "axes">) {
  const { ital, slnt } = realItalicAxes(font);
  return Boolean(ital || slnt || font.italic);
}

/** Library-card italic: real ital/slnt or a true italic file. Never fake-oblique a variable font. */
export function italicPreviewStyle(font: Pick<FontRecord, "variable" | "italic" | "axes" | "weights">, on: boolean) {
  if (!on) {
    return {
      fontStyle: "normal" as const,
      fontVariationSettings: undefined as string | undefined,
      fontSynthesis: "none" as const,
    };
  }
  const { ital, slnt } = realItalicAxes(font);
  if (ital) {
    const values = defaultAxisValues(axesForFont(font));
    values.ital = 1;
    return {
      fontStyle: "italic" as const,
      fontVariationSettings: variationCss(values, axesForFont(font)),
      fontSynthesis: "none" as const,
    };
  }
  if (slnt) {
    const values = defaultAxisValues(axesForFont(font));
    const lean = slnt.min < 0 ? slnt.min : slnt.max;
    values.slnt = lean;
    return {
      fontStyle: `oblique ${Number((-lean).toFixed(1))}deg` as const,
      fontVariationSettings: variationCss(values, axesForFont(font)),
      fontSynthesis: "none" as const,
    };
  }
  if (font.italic) {
    return {
      fontStyle: "italic" as const,
      fontVariationSettings: font.variable
        ? variationCss(defaultAxisValues(axesForFont(font)), axesForFont(font))
        : undefined,
      fontSynthesis: font.variable ? ("none" as const) : ("style" as const),
    };
  }
  if (font.variable) {
    return {
      fontStyle: "normal" as const,
      fontVariationSettings: undefined,
      fontSynthesis: "none" as const,
    };
  }
  return {
    fontStyle: "italic" as const,
    fontVariationSettings: undefined,
    fontSynthesis: "style" as const,
  };
}
