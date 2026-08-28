import type { FontRecord } from "./types";
import { cssFamilyStack, googleCssUrls } from "./loader";

export function exportGoogleImport(fonts: FontRecord[]): string {
  return googleCssUrls(fonts)
    .map((url) => `@import url('${url}');`)
    .join("\n");
}

export function exportLinkTag(fonts: FontRecord[]): string {
  return googleCssUrls(fonts)
    .map((url) => `<link rel="stylesheet" href="${url}" />`)
    .join("\n");
}

export function exportFontFamilies(fonts: FontRecord[]): string {
  return fonts
    .map((font) => {
      const stack = cssFamilyStack(font);
      return `/* ${font.family} */\nfont-family: ${stack};`;
    })
    .join("\n\n");
}

export function exportLocalFaces(fonts: FontRecord[]): string {
  const locals = fonts.filter((f) => f.source === "local");
  if (!locals.length) return "";
  return locals
    .map((font) => {
      const family = font.cssFamily || font.family;
      const weight = font.weights[0] ?? 400;
      const style = font.italic ? "italic" : "normal";
      const file = font.fileName || `${family}.woff2`;
      return `@font-face {
  font-family: "${family}";
  src: url("/fonts/${file}") format("woff2");
  font-weight: ${weight};
  font-style: ${style};
  font-display: swap;
}`;
    })
    .join("\n\n");
}

export function exportTailwind(fonts: FontRecord[]): string {
  const entries = fonts.map((font) => {
    const key = font.family
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    return `  --font-${key}: ${cssFamilyStack(font)};`;
  });
  return `@theme {\n${entries.join("\n")}\n}`;
}

export function exportBundle(fonts: FontRecord[]): string {
  const parts = [
    "/* Font Manager export */",
    exportGoogleImport(fonts),
    exportLocalFaces(fonts),
    exportFontFamilies(fonts),
  ].filter(Boolean);
  return parts.join("\n\n");
}
