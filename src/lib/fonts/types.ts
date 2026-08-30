export type FontCategory = "sans" | "serif" | "display" | "handwriting" | "mono";
export type FontSource = "google" | "local" | "system";
export type FontLicense = "free" | "freeware" | "personal" | "commercial" | "unknown";
export type PreviewTheme = "paper" | "ink" | "newsprint" | "blueprint";
export type LibraryView = "grid" | "list";
export type PreviewAlign = "left" | "center" | "right";
export type LibrarySort = "name-asc" | "name-desc" | "popular" | "recent";
export type LibraryScope =
  | "all"
  | "activated"
  | "favorites"
  | "uploaded"
  | "google"
  | "system"
  | `collection:${string}`
  | `category:${FontCategory}`
  | `tag:${string}`
  | `license:${FontLicense}`;

export interface FontRecord {
  id: string;
  family: string;
  source: FontSource;
  category: FontCategory;
  weights: number[];
  italic: boolean;
  variable: boolean;
  tags: string[];
  popularity: number;
  license: FontLicense;
  licenseName?: string;
  licenseUserSet?: boolean;
  /** OpenType fvar axes when known (uploads) or inferred (Google). */
  axes?: { tag: string; name: string; min: number; max: number; def: number }[];
  /** OpenType GSUB/GPOS feature tags when parsed from the file. */
  otFeatures?: string[];
  /** Named instances from fvar/STAT (Regular, Bold, …). */
  instances?: { name: string; coords: Record<string, number> }[];
  /** gvar, CFF2, or WOFF2 wrapper. */
  varStorage?: string;
  /* local-only */
  fileName?: string;
  fileSize?: number;
  checksum?: string;
  version?: string;
  glyphCount?: number;
  cssFamily?: string;
  addedAt?: number;
  kerningKey?: string;
  /** Detected OpenType color tables, if any. */
  colorKind?: "none" | "colrv0" | "colrv1" | "svg" | "cbdt" | "sbix";
  /** Absolute path when this face comes from a watched folder (file stays put). */
  originPath?: string;
}

export interface Collection {
  id: string;
  name: string;
  fontIds: string[];
  createdAt: number;
  parentId: string | null;
  /** Absolute folder on disk. Nested files stay in place; we only index them. */
  watchPath?: string;
  /** Activate new files found in watchPath (FontBase auto-activate). */
  autoActivate?: boolean;
}

export interface PreviewSettings {
  sampleText: string;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  theme: PreviewTheme;
  view: LibraryView;
  sort: LibrarySort;
  align: PreviewAlign;
  italic: boolean;
}

export interface DuplicateGroup {
  key: string;
  reason: "checksum" | "binary" | "family-weight";
  fonts: FontRecord[];
  diffBytes?: number;
}

export const CATEGORY_LABEL: Record<FontCategory, string> = {
  sans: "Sans",
  serif: "Serif",
  display: "Display",
  handwriting: "Script",
  mono: "Mono",
};

export const LICENSE_OPTIONS: FontLicense[] = ["free", "freeware", "personal", "commercial", "unknown"];

export const LICENSE_LABEL: Record<FontLicense, string> = {
  free: "Open",
  freeware: "Freeware",
  personal: "Personal",
  commercial: "Commercial",
  unknown: "Unknown",
};

export const LICENSE_HINT: Record<FontLicense, string> = {
  free: "Open license (OFL, Apache, MIT) — you may use it commercially.",
  freeware: "Free to use, but closed source — check the author before commercial work.",
  personal: "Free for personal use only — not for commercial work.",
  commercial: "Paid or foundry license — you need a valid license to use it.",
  unknown: "No license was found in the file; treat it as closed source until you confirm.",
};

export const SORT_LABEL: Record<LibrarySort, string> = {
  "name-asc": "A–Z",
  "name-desc": "Z–A",
  popular: "Popular",
  recent: "Recent",
};

export const ALIGN_LABEL: Record<PreviewAlign, string> = {
  left: "Align left",
  center: "Align center",
  right: "Align right",
};

export const SAMPLE_PRESETS = [
  "The quick brown fox jumps over the lazy dog",
  "Hamburgefonstiv",
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  "abcdefghijklmnopqrstuvwxyz",
  "0123456789 &@$#%?!",
  "Pack my box with five dozen liquor jugs",
  "😀 🥰 🎉 ✨ 🌟 🔥 ❤️ 👍 🚀 🌈",
] as const;

export const DEFAULT_PREVIEW: PreviewSettings = {
  sampleText: SAMPLE_PRESETS[0],
  fontSize: 36,
  lineHeight: 1.3,
  letterSpacing: 0,
  theme: "paper",
  view: "grid",
  sort: "name-asc",
  align: "left",
  italic: false,
};
