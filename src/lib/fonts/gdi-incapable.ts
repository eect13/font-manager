/**
 * Mirror of Rust `KNOWN_GDI_SESSION_INCAPABLE` + `SOFT_GDI_TRY_ADD_FIRST` in activate.rs.
 * Hard allowlist = true Add=0 class (Gidugu): Settled seed + Activate All skip + early-skip.
 * Soft emoji (`SOFT_GDI_TRY_ADD_FIRST`) try Add first; Settled only after Add=0 — never hard-skip.
 * Tip tests assert TS soft family names === Rust `SOFT_GDI_TRY_ADD_FIRST` table (exact parity).
 */
export type KnownGdiIncapableEntry = {
  /** Display family name (case-insensitive match). */
  family: string;
  /** Fontsource package slug; defaults to kebab of family if omitted in Rust. */
  fsSlug: string;
  /** Legacy FS subset plan (1.0.188: download removed; used for remnant purge). */
  subsets: readonly string[];
};

/** Hard allowlist only (Gidugu-class). Keep in sync with Rust `KNOWN_GDI_SESSION_INCAPABLE`. */
export const KNOWN_GDI_SESSION_INCAPABLE: readonly KnownGdiIncapableEntry[] = [
  { family: "Gidugu", fsSlug: "gidugu", subsets: ["telugu", "latin"] },
];

/**
 * Soft: try Add first; Settled + calm toast only after Add=0 + provenance.
 * Not boot-seeded. Activate All skips via session refuse / provenanced Settled
 * (never bare `.complete`). Soft early-skip only after this-session refuse.
 * Keep in sync with Rust `SOFT_GDI_TRY_ADD_FIRST` (same names + order).
 */
export const SOFT_GDI_TRY_ADD_FIRST: readonly KnownGdiIncapableEntry[] = [
  { family: "Noto Color Emoji", fsSlug: "noto-color-emoji", subsets: ["emoji"] },
  { family: "Noto Emoji", fsSlug: "noto-emoji", subsets: ["emoji"] },
];

export function isKnownGdiSessionIncapable(family: string): boolean {
  const key = family.trim().toLowerCase();
  if (!key) return false;
  return KNOWN_GDI_SESSION_INCAPABLE.some((e) => e.family.toLowerCase() === key);
}

export function isSoftGdiTryAddFirst(family: string): boolean {
  const key = family.trim().toLowerCase();
  if (!key) return false;
  return SOFT_GDI_TRY_ADD_FIRST.some((e) => e.family.toLowerCase() === key);
}

/**
 * First settled name on hard OR soft settle-capable lists (toast preview honesty).
 * Soft included so preview cannot prefer hard-only and lie about emoji Settled.
 */
export function firstSettledAllowlistedFamily(settledNames: readonly string[]): string | undefined {
  for (const n of settledNames) {
    if (isKnownGdiSessionIncapable(n) || isSoftGdiTryAddFirst(n)) return n.trim();
  }
  return undefined;
}
