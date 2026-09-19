/** Collection JSON v1 — family names, no account, no watch paths. */

export type CollectionSyncV1 = {
  v: 1;
  app: "font-manager";
  exportedAt: number;
  collections: { name: string; parent: string | null; families: string[] }[];
  favorites?: string[];
  tags?: Record<string, string[]>;
};

export function parseCollectionSync(raw: unknown): CollectionSyncV1 | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<CollectionSyncV1> & { collections?: unknown };
  if (row.v !== 1 || row.app !== "font-manager" || !Array.isArray(row.collections)) return null;
  const collections: CollectionSyncV1["collections"] = [];
  for (const c of row.collections) {
    if (!c || typeof c !== "object" || typeof (c as { name?: unknown }).name !== "string") continue;
    const rec = c as { name: string; parent?: unknown; families?: unknown };
    const families = Array.isArray(rec.families)
      ? rec.families.filter((n): n is string => typeof n === "string" && Boolean(n.trim()))
      : [];
    const parent = typeof rec.parent === "string" && rec.parent.trim() ? rec.parent.trim() : null;
    collections.push({ name: rec.name.trim() || "Untitled collection", parent, families });
  }
  const favorites = Array.isArray(row.favorites)
    ? row.favorites.filter((n): n is string => typeof n === "string" && Boolean(n.trim()))
    : undefined;
  const tags =
    row.tags && typeof row.tags === "object"
      ? Object.fromEntries(
          Object.entries(row.tags).filter(
            (entry): entry is [string, string[]] =>
              typeof entry[0] === "string" && Array.isArray(entry[1]) && entry[1].every((t) => typeof t === "string"),
          ),
        )
      : undefined;
  return {
    v: 1,
    app: "font-manager",
    exportedAt: typeof row.exportedAt === "number" ? row.exportedAt : Date.now(),
    collections,
    ...(favorites?.length ? { favorites } : {}),
    ...(tags && Object.keys(tags).length ? { tags } : {}),
  };
}
