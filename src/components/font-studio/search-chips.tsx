import { X } from "lucide-react";
import { useFontStore } from "@/lib/fonts/store";
import type { LibraryFacet } from "@/lib/fonts/types";
import { CATEGORY_LABEL, LICENSE_LABEL, isFacetScope } from "@/lib/fonts/types";
import { cn } from "@/lib/utils";

function hasToken(query: string, token: string) {
  return query
    .toLowerCase()
    .split(/\s+/)
    .includes(token.toLowerCase());
}

function toggleToken(query: string, token: string) {
  const parts = query.trim().split(/\s+/).filter(Boolean);
  const key = token.toLowerCase();
  const next = parts.filter((p) => p.toLowerCase() !== key);
  if (next.length === parts.length) next.push(token);
  return next.join(" ");
}

function facetLabel(facet: LibraryFacet) {
  if (facet.startsWith("license:")) return LICENSE_LABEL[facet.slice(8) as keyof typeof LICENSE_LABEL] ?? facet;
  if (facet.startsWith("category:")) return CATEGORY_LABEL[facet.slice(9) as keyof typeof CATEGORY_LABEL] ?? facet;
  if (facet.startsWith("tag:")) return facet.slice(4);
  return facet;
}

const TOGGLES = [
  { token: "variable", label: "Variable" },
  { token: "italic", label: "Italic" },
] as const;

/** Only chips that are on — Variable / Italic live in the sidebar, not as a static second filter row. */
export function SearchChips() {
  const query = useFontStore((s) => s.query);
  const setQuery = useFontStore((s) => s.setQuery);
  const facet = useFontStore((s) => s.facet);
  const setFacet = useFontStore((s) => s.setFacet);

  const activeToggles = TOGGLES.filter((chip) => hasToken(query, chip.token));
  const facetOn = isFacetScope(facet);
  if (!activeToggles.length && !facetOn) return null;

  return (
    <div className="flex gap-1 overflow-x-auto" role="group" aria-label="Active filters">
      {activeToggles.map((chip) => (
        <button
          key={chip.token}
          type="button"
          aria-pressed
          onClick={() => setQuery(toggleToken(query, chip.token))}
          className={cn(
            "inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-primary px-2.5 text-[11px] font-medium text-primary-foreground",
          )}
        >
          {chip.label}
          <X className="size-3" />
        </button>
      ))}
      {facetOn ? (
        <button
          type="button"
          aria-pressed
          onClick={() => setFacet("")}
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-primary px-2.5 text-[11px] font-medium text-primary-foreground"
        >
          {facetLabel(facet)}
          <X className="size-3" />
        </button>
      ) : null}
    </div>
  );
}
