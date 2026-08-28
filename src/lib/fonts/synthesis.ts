import type { FontRecord } from "./types";
import { realItalicAxes } from "./axes";

export type SynthesisToken = "weight" | "style" | "small-caps" | "position";

export function fontSynthesisValue(tokens: SynthesisToken[] | "none"): string {
  if (tokens === "none" || tokens.length === 0) return "none";
  return [...new Set(tokens)].join(" ");
}

export function synthesisForFont(
  font: Pick<FontRecord, "variable" | "italic" | "axes" | "weights" | "otFeatures">,
  opts: { italicOn?: boolean; weight?: number; smcp?: boolean } = {},
): string {
  const tokens: SynthesisToken[] = [];
  const { ital, slnt } = realItalicAxes(font);
  if (opts.italicOn && !ital && !slnt && !font.variable) tokens.push("style");
  if (font.variable) {
    if (opts.smcp && !(font.otFeatures ?? []).includes("smcp")) tokens.push("small-caps");
    return fontSynthesisValue(tokens);
  }
  const asked = opts.weight ?? 400;
  const native = font.weights.includes(asked);
  if (!native || asked !== 400) tokens.push("weight");
  if (opts.smcp && !(font.otFeatures ?? []).includes("smcp")) tokens.push("small-caps");
  return fontSynthesisValue(tokens);
}
