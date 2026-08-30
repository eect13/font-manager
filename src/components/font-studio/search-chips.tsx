import { useMemo } from "react";
import { fontLicense } from "@/lib/fonts/license";
import { allFonts, tagsFor, useFontStore } from "@/lib/fonts/store";
import type { FontCategory, FontLicense, LibraryScope } from "@/lib/fonts/types";
import {
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  LICENSE_LABEL,
  LICENSE_OPTIONS,
  TAG_ORDER,
} from "@/lib/fonts/types";
import { cn } from "@/lib/utils";

type Chip = { token: string; label: string; scope?: LibraryScope };

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
  const localFonts = useFontStore((s) => s.localFonts);
  const googleFonts = useFontStore((s) => s.googleFonts);
  const customTags = useFontStore((s) => s.customTags);

  const chips = useMemo(() => {
    const list = allFonts(localFonts, googleFonts);
    const license: Record<FontLicense, number> = {
      free: 0,
      freeware: 0,
      personal: 0,
      commercial: 0,
      unknown: 0,
    };
    const category: Record<FontCategory, number> = {
      sans: 0,
      serif: 0,
      display: 0,
      handwriting: 0,
      mono: 0,
      other: 0,
      icons: 0,
    };
    const tags = new Map<string, number>();
    let variable = 0;
    let italic = 0;
    for (const font of list) {
      license[fontLicense(font)] += 1;
      category[font.category] += 1;
      if (font.variable) variable += 1;
      if (font.italic) italic += 1;
      for (const tag of tagsFor(font, customTags)) {
        if ((TAG_ORDER as readonly string[]).includes(tag)) {
          tags.set(tag, (tags.get(tag) ?? 0) + 1);
        }
      }
    }
    const out: Chip[] = [];
    if (variable) out.push({ token: "variable", label: "Variable" });
    if (italic) out.push({ token: "italic", label: "Italic" });
    for (const id of LICENSE_OPTIONS) {
      if (license[id] > 0) {
        out.push({ token: `license:${id}`, label: LICENSE_LABEL[id], scope: `license:${id}` });
      }
    }
    for (const id of CATEGORY_ORDER) {
      if (category[id] > 0) {
        out.push({ token: `category:${id}`, label: CATEGORY_LABEL[id], scope: `category:${id}` });
      }
    }
    for (const tag of TAG_ORDER) {
      if ((tags.get(tag) ?? 0) > 0) {
        out.push({ token: `tag:${tag}`, label: tag, scope: `tag:${tag}` });
      }
    }
    return out;
  }, [localFonts, googleFonts, customTags]);

  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Quick filters">
      {chips.map((chip) => {
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
