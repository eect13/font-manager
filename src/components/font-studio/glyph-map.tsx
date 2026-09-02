import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { CircleHelp, Copy, Delete, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FontPicker } from "./font-picker";
import { HelpTip } from "./help-tip";
import { cssFamilyStack } from "@/lib/fonts/loader";
import { copyText } from "@/lib/copy-text";
import { notifyIfUnusual, colorKindOf, shouldWarnColor } from "@/lib/fonts/color-font";
import {
  filterGlyphs,
  glyphDisplay,
  glyphLabel,
  loadGlyphAtlas,
  peekGlyphAtlas,
  unicodeHex,
  type GlyphAtlas,
  type GlyphBlock,
  type GlyphEntry,
} from "@/lib/fonts/glyph-map";
import { allFonts, findFont, useFontStore } from "@/lib/fonts/store";
import { cn } from "@/lib/utils";

function pageForGlyphs(width: number, height: number) {
  const cell = 48;
  const cols = Math.max(4, Math.floor(Math.max(width, 200) / cell));
  const rows = Math.max(4, Math.floor(Math.max(height, 220) / cell));
  return Math.max(24, Math.min(120, cols * rows));
}

export function GlyphMap() {
  const localFonts = useFontStore((s) => s.localFonts);
  const googleFonts = useFontStore((s) => s.googleFonts);
  const activatedSet = useFontStore((s) => s.activatedSet);
  const activated = useMemo(
    () =>
      allFonts(localFonts, googleFonts)
        .filter((font) => activatedSet.has(font.id))
        .sort((a, b) => a.family.localeCompare(b.family)),
    [localFonts, googleFonts, activatedSet],
  );
  const [fontId, setFontId] = useState(activated[0]?.id ?? "");
  const [atlas, setAtlas] = useState<GlyphAtlas | null>(() => (fontId ? peekGlyphAtlas(fontId) : null));
  const [busy, setBusy] = useState(false);
  const [blockLabel, setBlockLabel] = useState("Basic Latin");
  const [selected, setSelected] = useState<GlyphEntry | null>(null);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [copied, setCopied] = useState("");
  const [grouped, setGrouped] = useState(true);
  const [page, setPage] = useState(48);
  const [chunks, setChunks] = useState(1);
  const gridRef = useRef<HTMLDivElement>(null);

  const font = findFont(fontId, localFonts, googleFonts);

  useEffect(() => {
    if (fontId.startsWith("s:")) return;
    if (!activated.length) {
      setFontId("");
      return;
    }
    if (!activatedSet.has(fontId)) setFontId(activated[0]!.id);
  }, [activated, activatedSet, fontId]);

  useEffect(() => {
    if (!font) {
      return;
    }
    const cached = peekGlyphAtlas(font.id);
    if (cached) {
      setAtlas(cached);
      setBusy(false);
      setBlockLabel((label) => cached.blocks.some((b) => b.label === label) ? label : cached.blocks[0]?.label ?? "Basic Latin");
      setSelected((cur) => {
        if (cur && cached.glyphs.some((g) => g.cp === cur.cp)) return cur;
        return cached.blocks[0]?.glyphs[0] ?? cached.glyphs[0] ?? null;
      });
      return;
    }
    let cancelled = false;
    setBusy(true);
    void loadGlyphAtlas(font)
      .then((next) => {
        if (cancelled) return;
        setAtlas(next);
        setBlockLabel((label) => next.blocks.some((b) => b.label === label) ? label : next.blocks[0]?.label ?? "Basic Latin");
        setSelected((cur) => cur ?? next.blocks[0]?.glyphs[0] ?? next.glyphs[0] ?? null);
        notifyIfUnusual(font, "glyphs");
        if (!next.glyphs.length && shouldWarnColor(colorKindOf(font))) {
          toast.message(`${font.family} didn’t expose a cmap`, {
            description: "COLRv1 / OpenType-SVG often need the outline fallback. Activate so Documents has Noto Emoji, then open Glyphs again.",
          });
        }
      })
      .catch(() => {
        if (!cancelled) setAtlas({ glyphs: [], byFont: [], blocks: [], fromFile: false, faceName: "" });
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [font?.id]);

  const searchHits = useMemo(
    () => (deferredQuery.trim() && atlas ? filterGlyphs(atlas.glyphs, deferredQuery, grouped ? "unicode" : "font") : null),
    [atlas, deferredQuery, grouped],
  );
  const activeBlock: GlyphBlock | null = useMemo(() => {
    if (!atlas || !grouped) return null;
    return atlas.blocks.find((b) => b.label === blockLabel) ?? atlas.blocks[0] ?? null;
  }, [atlas, blockLabel, grouped]);
  const cells = useMemo(() => {
    if (searchHits) return searchHits;
    if (grouped) return activeBlock?.glyphs ?? [];
    return atlas?.byFont ?? [];
  }, [searchHits, grouped, activeBlock, atlas]);

  const filterKey = `${fontId}|${grouped}|${deferredQuery}|${blockLabel}`;

  useEffect(() => {
    setChunks(1);
  }, [filterKey]);

  useEffect(() => {
    const box = gridRef.current;
    if (!box) return;
    const scroller = box.closest("[data-radix-scroll-area-viewport]") as HTMLElement | null;
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const w = (scroller ?? box).clientWidth || 480;
        const h = scroller?.clientHeight || Math.max(280, window.innerHeight - 280);
        setPage(pageForGlyphs(w, h));
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(scroller ?? box);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [fontId, grouped]);

  function append(entry: GlyphEntry) {
    setCopied((s) => s + entry.char);
    setSelected(entry);
  }

  async function copyField() {
    const text = copied || selected?.char || "";
    if (!text) {
      toast.message("Nothing to copy", { description: "Click a glyph, then Select or Copy." });
      return;
    }
    try {
      await copyText(text);
      toast.success(text.length === 1 ? `Copied ${unicodeHex(text.codePointAt(0)!)}` : `Copied ${text.length} characters`);
    } catch {
      toast.error("Clipboard blocked", { description: "Select the field and press Ctrl+C." });
    }
  }

  if (!activated.length) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-20 text-center">
        <p className="font-heading text-3xl">Character Map</p>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          Activate a typeface in the library, then open Glyphs to browse every character like Windows Character Map.
        </p>
      </div>
    );
  }

  const stack = font ? cssFamilyStack(font) : undefined;
  const glyphFace = atlas?.faceName
    ? `"${atlas.faceName.replace(/["\\]/g, "")}"`
    : stack;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-end gap-3 border-b border-border p-3 md:px-4">
        <div className="min-w-56 flex-1">
          <Label className="mb-1.5 block">Font</Label>
          <FontPicker value={fontId} onChange={setFontId} label="Font" prefetchAtlas pageSize={48} />
        </div>
        <div className="min-w-48 flex-1">
          <Label className="mb-1.5 block">Search</Label>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Character, name, or U+0041"
            className="h-11"
          />
        </div>
        <div className="flex flex-col gap-1 pb-0.5">
          <Label>View</Label>
          <div className="flex h-11 rounded-md border border-border p-0.5">
            <button
              type="button"
              onClick={() => setGrouped(true)}
              className={cn(
                "rounded-sm px-3 text-xs",
                grouped ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              Blocks
            </button>
            <button
              type="button"
              onClick={() => setGrouped(false)}
              className={cn(
                "rounded-sm px-3 text-xs",
                !grouped ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              Whole font
            </button>
          </div>
        </div>
        <p className="flex items-center gap-1 pb-2 text-xs text-muted-foreground">
          {busy
            ? "Reading cmap…"
            : atlas
              ? `${atlas.glyphs.length.toLocaleString()} glyphs${atlas.fromFile ? "" : " (from rendered font)"}`
              : ""}
          {atlas && !busy ? (
            <HelpTip
              wide
              label="Hollow square (tofu) = this codepoint is in the file, but this window has nothing to draw (empty outline or color-only). It still counts in the total. We do not fill it with Noto or Segoe — that would fake a glyph. To view it for real: Activate the family, click the cell, Copy, then paste into Word or Notepad."
            >
              <button
                type="button"
                className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
                aria-label="About empty glyph boxes"
              >
                <CircleHelp className="size-3" />
              </button>
            </HelpTip>
          ) : null}
        </p>
      </div>

      <div className="flex min-h-0 flex-1">
        {!deferredQuery.trim() && grouped ? (
          <ScrollArea className="hidden w-52 shrink-0 border-r border-border md:block">
            <nav className="flex flex-col py-2 pr-1">
              {(atlas?.blocks ?? []).map((block) => (
                <button
                  key={block.label}
                  type="button"
                  onClick={() => setBlockLabel(block.label)}
                  className={cn(
                    "px-3 py-1.5 text-left text-xs hover:bg-accent",
                    block.label === activeBlock?.label
                      ? "bg-accent font-medium text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  <span className="block truncate">{block.label}</span>
                  <span className="tabular-nums opacity-70">{block.glyphs.length}</span>
                </button>
              ))}
            </nav>
          </ScrollArea>
        ) : null}

        <ScrollArea className="min-w-0 flex-1">
          <div ref={gridRef} className="grid grid-cols-[repeat(auto-fill,minmax(2.75rem,1fr))] gap-px p-2">
            {cells.slice(0, page * chunks).map((entry) => (
              <button
                key={`${entry.gid}-${entry.cp}`}
                type="button"
                title={`${unicodeHex(entry.cp)} ${glyphLabel(entry)}`}
                aria-label={`${unicodeHex(entry.cp)} ${glyphLabel(entry)}`}
                onClick={() => setSelected(entry)}
                onDoubleClick={() => append(entry)}
                className={cn(
                  "flex aspect-square items-center justify-center rounded-md text-xl hover:bg-accent",
                  selected?.cp === entry.cp ? "bg-primary text-primary-foreground" : "bg-card",
                )}
                style={{ fontFamily: glyphFace, fontSynthesis: "none" }}
              >
                {glyphDisplay(entry)}
              </button>
            ))}
          </div>
          {cells.length > page * chunks ? (
            <div className="flex flex-wrap items-center justify-center gap-2 px-3 pb-4 text-xs text-muted-foreground">
              <span>
                Showing {(page * chunks).toLocaleString()} of {cells.length.toLocaleString()}
              </span>
              <Button size="sm" variant="secondary" className="h-7 px-2.5" onClick={() => setChunks((n) => n + 1)}>
                Show {Math.min(page, cells.length - page * chunks).toLocaleString()} more
              </Button>
            </div>
          ) : cells.length ? (
            <p className="px-3 pb-4 text-center text-xs text-muted-foreground">
              Showing {cells.length.toLocaleString()} of {cells.length.toLocaleString()}
            </p>
          ) : null}
          {!busy && atlas && cells.length === 0 ? (
            <p className="px-6 py-16 text-center text-sm text-muted-foreground">
              {atlas.glyphs.length
                ? "No glyphs match that search."
                : "Couldn’t read this file. Activate Google families (so TTF/OTF/WOFF land in Documents) or re-upload TTF, OTF, WOFF, WOFF2, or TTC."}
            </p>
          ) : null}
        </ScrollArea>

        <aside className="flex w-full shrink-0 flex-col border-t border-border p-3 lg:w-64 lg:border-l lg:border-t-0 lg:p-4">
          <p
            className="flex h-28 items-center justify-center rounded-lg border border-border bg-card text-6xl"
            style={{ fontFamily: glyphFace, fontSynthesis: "none" }}
          >
            {selected ? glyphDisplay(selected) : " "}
          </p>
          {selected ? (
            <dl className="mt-3 space-y-1 text-xs">
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Unicode</dt>
                <dd className="font-mono">{unicodeHex(selected.cp)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Decimal</dt>
                <dd className="font-mono">{selected.cp}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">HTML</dt>
                <dd className="font-mono">{`&#x${selected.cp.toString(16)};`}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Glyph</dt>
                <dd className="font-mono">{selected.gid}</dd>
              </div>
              <p className="pt-1 text-muted-foreground">{glyphLabel(selected)}</p>
            </dl>
          ) : null}
          <div className="mt-auto space-y-2 pt-4">
            <Label>Characters to copy</Label>
            <Input
              value={copied}
              onChange={(e) => setCopied(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void copyField();
                }
              }}
              className="font-mono"
              aria-label="Characters to copy"
            />
            <div className="flex flex-wrap gap-1">
              <Button size="sm" onClick={() => selected && append(selected)} disabled={!selected}>
                <Plus />
                Select
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void copyField()} disabled={!copied && !selected}>
                <Copy />
                Copy
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCopied("")} disabled={!copied}>
                <Delete />
                Clear
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Click a cell, then Copy (or Select to build a string). Blocks = Unicode groups. Whole font = every glyph in font order, ungrouped.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
