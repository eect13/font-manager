/** Catalog IDB schema. v1 accepted on read; always write v2. */
export const CATALOG_CACHE_VERSION = 2 as const;

export function isWoff2OnlyVariableFamily(family: string) {
  const t = family.trim().toLowerCase();
  return t === "material symbols" || t.startsWith("material symbols ");
}

/** IDB catalog never owns the Variable badge. Heal facet from bundled snapshot. */
export function healCachedCatalogFont(
  font: { family: string; catalogVariable?: boolean; variable?: boolean },
  bundled: { catalogVariable?: boolean } | undefined,
): { catalogVariable: boolean; variable: false } {
  return {
    variable: false,
    catalogVariable:
      !isWoff2OnlyVariableFamily(font.family) &&
      Boolean(font.catalogVariable || bundled?.catalogVariable),
  };
}
