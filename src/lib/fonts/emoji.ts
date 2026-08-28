import type { FontRecord } from "./types";
import { previewFallbackSample } from "./fallback";

export const EMOJI_SAMPLE = "😀 🥰 🎉 ✨ 🌟 🔥 ❤️ 👍 🚀 🌈";

export function isEmojiFamily(name: string) {
  return /emoji/i.test(name);
}

export function isEmojiFont(font: Pick<FontRecord, "family" | "tags">) {
  return isEmojiFamily(font.family) || (font.tags ?? []).includes("emoji");
}

export function previewSample(font: Pick<FontRecord, "family" | "tags" | "colorKind">, sample: string) {
  return previewFallbackSample(font, sample);
}
