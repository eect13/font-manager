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

function cssFaceName(font: FontRecord): string {
  const named =
    font.fullName && font.fullName !== font.family ? font.fullName : font.cssFamily || font.family;
  return named.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function faceFormat(fileName: string): string {
  const n = fileName.toLowerCase();
  if (n.endsWith(".otf")) return "opentype";
  if (n.endsWith(".woff2")) return "woff2";
  if (n.endsWith(".woff")) return "woff";
  return "truetype";
}

export function exportLocalFaces(fonts: FontRecord[]): string {
  const locals = fonts.filter((f) => f.source === "local");
  if (!locals.length) return "";
  return locals
    .map((font) => {
      const family = cssFaceName(font);
      const weight = font.weights[0] ?? 400;
      const style = font.italic ? "italic" : "normal";
      const file = font.fileName || `${family}.ttf`;
      const format = faceFormat(file);
      return `@font-face {
  font-family: "${family}";
  src: url("/fonts/${file}") format("${format}");
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
