import type { FontCategory, FontRecord } from "./types";
import { scriptOf, scriptSampleText, scriptStack } from "./scripts";

function isEmoji(font: Pick<FontRecord, "family" | "tags">) {
  return /emoji/i.test(font.family) || (font.tags ?? []).includes("emoji");
}

/** CSS generic last so missing glyphs (cmap miss) fall through. Category pick avoids a serif fox on a sans card. */
const STACK: Record<FontCategory, string> = {
  sans: '"Segoe UI", system-ui, sans-serif',
  serif: '"Times New Roman", Georgia, serif',
  display: '"Segoe UI", system-ui, sans-serif',
  handwriting: '"Segoe Script", "Comic Sans MS", cursive',
  mono: 'ui-monospace, "Cascadia Mono", Consolas, monospace',
};

export function scriptSample(font: Pick<FontRecord, "family" | "tags">): string | null {
  return scriptSampleText(font.family);
}

export function previewFallbackSample(
  font: Pick<FontRecord, "family" | "tags" | "colorKind">,
  sample: string,
) {
  if (isEmoji(font) || font.colorKind === "colrv1" || font.colorKind === "cbdt") {
    return scriptSampleText(font.family) ?? "😀 🥰 🎉";
  }
  return scriptSample(font) ?? sample;
}

export function cssFamilyStack(font: Pick<FontRecord, "family" | "cssFamily" | "category" | "tags">): string {
  const family = font.cssFamily || font.family;
  if (isEmoji(font)) {
    return `"${family}", "Segoe UI Emoji", "Noto Color Emoji", "Apple Color Emoji", sans-serif`;
  }
  const script = scriptStack(family);
  if (script && scriptOf(family) !== "latin") {
    return `"${family}", ${script}`;
  }
  return `"${family}", ${STACK[font.category] ?? STACK.sans}`;
}