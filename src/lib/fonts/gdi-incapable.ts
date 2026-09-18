/**
 * Mirror of Rust `KNOWN_GDI_SESSION_INCAPABLE` in activate.rs.
 * Settled / toast-exempt / Fontsource-offer UX — append here when Rust allowlist grows.
 */
export type KnownGdiIncapableEntry = {
  /** Display family name (case-insensitive match). */
  family: string;
  /** Fontsource package slug; defaults to kebab of family if omitted in Rust. */
  fsSlug: string;
  /** Subsets tried for opt-in Fontsource GDI offer (order = preference). */
  subsets: readonly string[];
};

/** Source of truth for UI: keep in sync with `family_known_gdi_session_incapable` allowlist. */
export const KNOWN_GDI_SESSION_INCAPABLE: readonly KnownGdiIncapableEntry[] = [
  { family: "Gidugu", fsSlug: "gidugu", subsets: ["telugu", "latin"] },
];

export function isKnownGdiSessionIncapable(family: string): boolean {
  const key = family.trim().toLowerCase();
  if (!key) return false;
  return KNOWN_GDI_SESSION_INCAPABLE.some((e) => e.family.toLowerCase() === key);
}

/** First settled name that is on the known-GDI-incapable allowlist (for toast Try Fontsource). */
export function firstSettledAllowlistedFamily(settledNames: readonly string[]): string | undefined {
  for (const n of settledNames) {
    if (isKnownGdiSessionIncapable(n)) return n.trim();
  }
  return undefined;
}
