import { useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw, Trash2 } from "lucide-react";
import { FontCard } from "./font-card";
import { UploadsResetDialog } from "./uploads-reset-dialog";
import { Button } from "@/components/ui/button";
import { primeGooglePreview } from "@/lib/fonts/loader";
import { allFonts, filterLibrary, sortLibrary, useFontStore } from "@/lib/fonts/store";
import type { Collection, FontRecord } from "@/lib/fonts/types";

const EMPTY_IDS: string[] = [];
const EMPTY_COLS: Collection[] = [];
const EMPTY_FONTS: FontRecord[] = [];

const COL_MIN = 280;
const GAP = 8;
const GRID_H = 232;
const LIST_H = 152;

function scopeNeedsActivated(scope: string) {
  return scope === "activated";
}

function useScroller() {
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 960, height: 640, scrollTop: 0 });

  useEffect(() => {
    const boxEl = boxRef.current;
    if (!boxEl) return;
    const scroller = (boxEl.closest("[data-library-scroll]") as HTMLElement | null) ?? boxEl;
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        setBox({
          width: scroller.clientWidth || window.innerWidth,
          height: scroller.clientHeight || Math.max(320, window.innerHeight - 220),
          scrollTop: scroller.scrollTop,
        });
      });
    };
    measure();
    const onScroll = () => measure();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(scroller);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(raf);
      scroller.removeEventListener("scroll", onScroll);
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  return { boxRef, box };
}

export function LibraryGrid() {
  const localFonts = useFontStore((s) => s.localFonts);
  const googleFonts = useFontStore((s) => s.googleFonts);
  const scope = useFontStore((s) => s.scope);
  const query = useFontStore((s) => s.query);
  const customTags = useFontStore((s) => s.customTags);
  const preview = useFontStore((s) => s.preview);
  const activated = useFontStore((s) => (scopeNeedsActivated(s.scope) ? s.activated : EMPTY_IDS));
  const favorites = useFontStore((s) => (s.scope === "favorites" ? s.favorites : EMPTY_IDS));
  const collections = useFontStore((s) =>
    s.scope.startsWith("collection:") ? s.collections : EMPTY_COLS,
  );
  const systemFonts = useFontStore((s) => (s.scope === "system" ? s.systemFonts : EMPTY_FONTS));
  const { boxRef, box } = useScroller();
  const [uploadsOpen, setUploadsOpen] = useState(false);
  const list = preview.view === "list";
  const sortMode =
    scope === "system" && (preview.sort ?? "name-asc") === "popular" ? "name-asc" : (preview.sort ?? "name-asc");

  const fonts = useMemo(
    () =>
      sortLibrary(
        filterLibrary(
          scope === "system" ? systemFonts : allFonts(localFonts, googleFonts),
          scope,
          query,
          favorites,
          activated,
          collections,
          customTags,
        ),
        sortMode,
      ),
    [localFonts, googleFonts, systemFonts, scope, query, favorites, activated, collections, customTags, sortMode],
  );

  const inner = Math.max(280, box.width - 24);
  const cols = list ? 1 : Math.max(1, Math.floor((inner + GAP) / (COL_MIN + GAP)));
  const rowH = list ? LIST_H : GRID_H;
  const stride = rowH + GAP;
  const rows = Math.max(1, Math.ceil(fonts.length / cols));
  const totalH = fonts.length ? rows * rowH + Math.max(0, rows - 1) * GAP + 24 : 0;
  const overscan = 2;
  const startRow = Math.max(0, Math.floor(box.scrollTop / stride) - overscan);
  const endRow = Math.min(rows, Math.ceil((box.scrollTop + box.height) / stride) + overscan);
  const start = startRow * cols;
  const end = Math.min(fonts.length, endRow * cols);
  const shown = fonts.slice(start, end);
  const offsetY = startRow * stride;
  const prefetchEnd = Math.min(fonts.length, end + cols * 3);
  const primeIds = fonts
    .slice(start, prefetchEnd)
    .map((font) => font.id)
    .join("|");

  useEffect(() => {
    void primeGooglePreview(fonts.slice(start, prefetchEnd));
  }, [primeIds]);

  const uploadedBar =
    scope === "uploaded" ? (
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2 md:px-4">
        <p className="text-sm text-muted-foreground">
          {localFonts.length
            ? `${localFonts.length.toLocaleString()} uploaded typeface${localFonts.length === 1 ? "" : "s"}`
            : "No uploaded typefaces"}
        </p>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-7 px-2.5"
            onClick={() => setUploadsOpen(true)}
          >
            <RotateCcw />
            Reset library
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            className="h-7 px-2.5"
            disabled={!localFonts.length}
            onClick={() => setUploadsOpen(true)}
          >
            <Trash2 />
            Clear uploads
          </Button>
        </div>
      </div>
    ) : null;

  const systemBar =
    scope === "system" ? (
      <div className="border-b border-border px-3 py-2 md:px-4">
        <p className="text-sm text-muted-foreground">
          Fonts already in Windows (Arial, Calibri, Segoe, …). View and favorite them here. Font Manager will not uninstall or deactivate them.
        </p>
      </div>
    ) : null;

  if (fonts.length === 0) {
    return (
      <div ref={boxRef} className="flex flex-1 flex-col">
        {uploadedBar}
        {systemBar}
        <div className="flex flex-1 flex-col items-center justify-center px-6 py-20 text-center">
          <p className="font-heading text-3xl">Nothing in this drawer</p>
          <p className="mt-2 max-w-sm text-sm text-muted-foreground">
            {scope === "uploaded"
              ? "Drop a folder of TTF, OTF, or WOFF files here, or use Files / Folder in the header."
              : scope === "system"
                ? "Open the desktop app to list Arial, Calibri, and the rest of C:\\Windows\\Fonts. This website cannot read that folder."
              : scopeNeedsActivated(scope)
                ? "This filter only lists activated typefaces. Open All typefaces, or click Activated."
                : "Try another filter, or use Folder to add a whole directory of TTF, OTF, or WOFF files."}
          </p>
        </div>
        <UploadsResetDialog open={uploadsOpen} onOpenChange={setUploadsOpen} />
      </div>
    );
  }

  return (
    <div ref={boxRef} className="flex flex-col">
      {uploadedBar}
      {systemBar}
      <div className="relative w-full" style={{ height: totalH }}>
        <div
          className={list ? "flex flex-col gap-2 p-2.5 md:p-3" : "grid gap-2 p-2.5 md:p-3"}
          style={
            list
              ? { transform: `translateY(${offsetY}px)` }
              : {
                  transform: `translateY(${offsetY}px)`,
                  gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                }
          }
        >
          {shown.map((font) => (
            <FontCard key={font.id} font={font} preview={preview} layout={preview.view} />
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2 px-4 pb-8 pt-1 text-xs text-muted-foreground">
        <span>
          {fonts.length.toLocaleString()} typeface{fonts.length === 1 ? "" : "s"} · scroll to browse
        </span>
      </div>
      <UploadsResetDialog open={uploadsOpen} onOpenChange={setUploadsOpen} />
    </div>
  );
}
