/**
 * PANOSE 1.0 in OS/2 (10 bytes). Dafont / FontLab dumps often leave
 * Family Kind = Latin Text with Serif Style = Any, or a dummy Cove template —
 * those must be treated as empty, not as real serif/sans.
 */
import type { FontCategory } from "./types";

export type PanoseKind = "any" | "nofit" | "text" | "script" | "decorative" | "symbol";

const KIND: PanoseKind[] = ["any", "nofit", "text", "script", "decorative", "symbol"];

export interface PanoseReading {
  kind: PanoseKind;
  category: FontCategory | null;
  tags: string[];
  empty: boolean;
  /** Filled serif/proportion or a real script/symbol kind — safe to use as category. */
  confident: boolean;
}

function digit(panose: number[], i: number) {
  const n = panose[i] ?? 0;
  return Number.isFinite(n) ? n & 0xff : 0;
}

export function readPanose(panose?: number[]): PanoseReading {
  const tags: string[] = [];
  const blank = (kind: PanoseKind): PanoseReading => ({
    kind,
    category: null,
    tags,
    empty: true,
    confident: false,
  });
  if (!panose?.length) return blank("any");
  const family = digit(panose, 0);
  const kind = KIND[family] ?? "any";
  if (family <= 1) return blank(kind);

  if (kind === "script") {
    return { kind, category: "handwriting", tags: ["script"], empty: false, confident: true };
  }
  if (kind === "symbol") {
    return { kind, category: "display", tags: ["symbols"], empty: false, confident: true };
  }
  if (kind === "decorative") {
    return { kind, category: "display", tags, empty: false, confident: false };
  }

  const serif = digit(panose, 1);
  const proportion = digit(panose, 3);
  const contrast = digit(panose, 4);

  if (serif <= 1 && (proportion <= 1 || proportion === 4)) {
    return blank("text");
  }

  let category: FontCategory | null = null;
  if (serif >= 11 && serif <= 15) {
    category = "sans";
    if (serif === 15) tags.push("rounded");
  } else if (serif >= 2 && serif <= 10) {
    category = "serif";
    if (serif === 6) tags.push("slab");
    else if (serif <= 5) tags.push("editorial");
    if (contrast >= 7) tags.push("didone");
  }

  if (proportion === 9) {
    category = "mono";
    tags.push("coding");
  }
  if (proportion === 6 || proportion === 8) tags.push("condensed");

  return {
    kind,
    category,
    tags,
    empty: category == null,
    confident: category != null && serif >= 2,
  };
}
