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
  other: '"Segoe UI", system-ui, sans-serif',
  icons: '"Segoe UI Symbol", "Segoe UI", sans-serif',
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

/** CSS family for the specimen. Local files get a private name so sibling cuts
 *  (Helvetica Light vs Narrow Bold) cannot steal each other's glyphs. */
export function previewFaceName(font: {
  id?: string;
  source?: string;
  cssFamily?: string;
  family: string;
}): string {
  if (font.source === "local" && font.id) return `fm-${font.id}`;
  return font.cssFamily || font.family;
}

export function cssFamilyStack(
  font: Pick<FontRecord, "family" | "cssFamily" | "category" | "tags"> & {
    id?: string;
    source?: string;
  },
): string {
  const face = previewFaceName(font);
  const named = font.family;
  if (isEmoji(font)) {
    return `"${face}", "Segoe UI Emoji", "Noto Color Emoji", "Apple Color Emoji", sans-serif`;
  }
  const script = scriptStack(named);
  if (script && scriptOf(named) !== "latin") {
    return `"${face}", ${script}`;
  }
  return `"${face}", ${STACK[font.category] ?? STACK.sans}`;
}