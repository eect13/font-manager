import { useEffect, useMemo, useState, type UIEvent } from "react";
import { ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cssFamilyStack, loadFont } from "@/lib/fonts/loader";
import { loadGlyphAtlas } from "@/lib/fonts/glyph-map";
import { allFonts, findFont, tagsFor, useFontStore } from "@/lib/fonts/store";
import { isFontsourceOnly, isGoogleCatalog } from "@/lib/fonts/catalog";
import type { FontRecord } from "@/lib/fonts/types";
import { CATEGORY_LABEL } from "@/lib/fonts/types";
import { cn } from "@/lib/utils";

export function FontPicker({
  value,
  onChange,
  label,
  prefetchAtlas = false,
  pageSize = 0,
}: {
  value: string;
  onChange: (id: string) => void;
  label: string;
  prefetchAtlas?: boolean;
  /** 0 = list every activated match (playground). Glyphs passes a page for huge libraries. */
  pageSize?: number;
}) {
  const localFonts = useFontStore((s) => s.localFonts);
  const googleFonts = useFontStore((s) => s.googleFonts);
  const systemFonts = useFontStore((s) => s.systemFonts);
  const activatedSet = useFontStore((s) => s.activatedSet);
  const customTags = useFontStore((s) => s.customTags);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(pageSize || Number.POSITIVE_INFINITY);

  const fonts = useMemo(
    () => [...systemFonts, ...allFonts(localFonts, googleFonts)],
    [systemFonts, localFonts, googleFonts],
  );
  const selected = findFont(value, localFonts, googleFonts);

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    const match = (f: FontRecord) => {
      if (f.source !== "system" && !activatedSet.has(f.id)) return false;
      if (!query) return true;
      if (f.family.toLowerCase().includes(query)) return true;
      if (f.fullName?.toLowerCase().includes(query)) return true;
      if (f.category.includes(query)) return true;
      if (CATEGORY_LABEL[f.category]?.toLowerCase().includes(query)) return true;
      return tagsFor(f, customTags).some((tag) => tag.includes(query));
    };
    const hits = fonts.filter(match);
    hits.sort((a, b) => (a.fullName || a.family).localeCompare(b.fullName || b.family));
    return hits;
  }, [fonts, q, activatedSet, customTags]);

  const visible = useMemo(() => {
    const cap = pageSize > 0 ? shown : filtered.length;
    const slice = filtered.slice(0, Math.min(filtered.length, cap));
    if (selected && (selected.source === "system" || activatedSet.has(selected.id)) && !slice.some((f) => f.id === selected.id)) {
      return [selected, ...slice];
    }
    return slice;
  }, [filtered, shown, pageSize, selected, activatedSet]);

  const groups = useMemo(() => {
    const windows = visible.filter((f) => f.source === "system");
    const uploaded = visible.filter((f) => f.source === "local");
    const fontsource = visible.filter(isFontsourceOnly);
    const gfonts = visible.filter(isGoogleCatalog);
    return [
      { label: "System", items: windows },
      { label: "Fontsource", items: fontsource },
      { label: "Google Fonts", items: gfonts },
      { label: "Uploaded", items: uploaded },
    ].filter((g) => g.items.length);
  }, [visible]);

  useEffect(() => {
    setShown(pageSize > 0 ? pageSize : Number.POSITIVE_INFINITY);
  }, [q, open, pageSize]);

  function warm(font: FontRecord) {
    void loadFont(font);
    if (prefetchAtlas) {
      void loadGlyphAtlas(font);
    }
  }

  function pick(font: FontRecord) {
    onChange(font.id);
    setOpen(false);
    warm(font);
  }

  function onListScroll(event: UIEvent<HTMLDivElement>) {
    if (pageSize <= 0) return;
    const t = event.target as HTMLElement;
    if (!t || t.scrollHeight - t.scrollTop - t.clientHeight > 64) return;
    setShown((n) => Math.min(filtered.length, (Number.isFinite(n) ? n : pageSize) + pageSize));
  }

  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="h-11 w-full justify-between font-normal">
          <span className="truncate" style={{ fontFamily: selected ? cssFamilyStack(selected) : undefined }}>
            {selected?.fullName || selected?.family || label}
          </span>
          <ChevronsUpDown className="size-4 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(92vw,360px)] p-2" align="start">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search typefaces…"
          className="mb-2 h-9"
        />
        <ScrollArea className="h-72" onScrollCapture={onListScroll}>
          <div className="flex flex-col gap-2">
            {groups.length === 0 && (
              <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                {q.trim() ? "No matches" : "Activate a catalog face in the library. System fonts list here in the desktop app."}
              </p>
            )}
            {groups.map((group) => (
              <div key={group.label}>
                <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  {group.label}
                </p>
                {group.items.map((font) => (
                  <button
                    key={font.id}
                    type="button"
                    onMouseEnter={() => warm(font)}
                    onClick={() => pick(font)}
                    className={cn(
                      "flex w-full items-baseline justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                      font.id === value && "bg-accent",
                    )}
                  >
                    <span className="truncate" style={{ fontFamily: cssFamilyStack(font) }}>
                      {font.fullName || font.family}
                    </span>
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {font.source === "local" ? "file" : font.source === "system" ? "System" : CATEGORY_LABEL[font.category]}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}