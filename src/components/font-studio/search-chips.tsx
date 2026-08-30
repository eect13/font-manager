import { useFontStore } from "@/lib/fonts/store";
import type { FontCategory, FontLicense } from "@/lib/fonts/types";
import { CATEGORY_LABEL, LICENSE_LABEL } from "@/lib/fonts/types";
import { cn } from "@/lib/utils";

const CHIPS: { token: string; label: string; scope?: `license:${FontLicense}` | `category:${FontCategory}` }[] = [
  { token: "variable", label: "Variable" },
  { token: "italic", label: "Italic" },
  { token: "license:free", label: LICENSE_LABEL.free, scope: "license:free" },
  { token: "license:personal", label: LICENSE_LABEL.personal, scope: "license:personal" },
  { token: "sans", label: CATEGORY_LABEL.sans, scope: "category:sans" },
  { token: "serif", label: CATEGORY_LABEL.serif, scope: "category:serif" },
  { token: "display", label: CATEGORY_LABEL.display, scope: "category:display" },
  { token: "handwriting", label: CATEGORY_LABEL.handwriting, scope: "category:handwriting" },
  { token: "mono", label: CATEGORY_LABEL.mono, scope: "category:mono" },
  { token: "other", label: CATEGORY_LABEL.other, scope: "category:other" },
  { token: "icons", label: CATEGORY_LABEL.icons, scope: "category:icons" },
];

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

export function SearchChips() {
  const query = useFontStore((s) => s.query);
  const setQuery = useFontStore((s) => s.setQuery);
  const scope = useFontStore((s) => s.scope);
  const setScope = useFontStore((s) => s.setScope);

  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Quick filters">
      {CHIPS.map((chip) => {
        const on = chip.scope ? scope === chip.scope : hasToken(query, chip.token);
        return (
          <button
            key={chip.token}
            type="button"
            aria-pressed={on}
            onClick={() => {
              if (chip.scope) {
                setScope(on && scope === chip.scope ? "all" : chip.scope);
                return;
              }
              setQuery(toggleToken(query, chip.token));
            }}
            className={cn(
              "h-6 rounded-full px-2.5 text-[11px] font-medium transition-colors duration-150",
              on
                ? "bg-primary text-primary-foreground"
                : "bg-secondary text-muted-foreground hover:text-foreground",
            )}
          >
            {chip.label}
          </button>
        );
      })}
    </div>
  );
}
