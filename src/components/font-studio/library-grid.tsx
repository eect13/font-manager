import { useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw, Trash2 } from "lucide-react";
import { FontCard } from "./font-card";
import { UploadsResetDialog } from "./uploads-reset-dialog";
import { Button } from "@/components/ui/button";
import { loadFont } from "@/lib/fonts/loader";
import { allFonts, filterLibrary, sortLibrary, useFontStore } from "@/lib/fonts/store";
import type { Collection } from "@/lib/fonts/types";

const EMPTY_IDS: string[] = [];
const EMPTY_COLS: Collection[] = [];

function scopeNeedsActivated(scope: string) {
  return (
    scope === "activated" ||
    scope.startsWith("license:") ||
    scope.startsWith("category:") ||
    scope.startsWith("tag:")
  );
}

/** One viewport: auto-fill ~17.5rem cards. Rows 3–6 from height (ultrawide + 1440p get more). */
function pageForBox(width: number, height: number, list: boolean) {
  if (list) {
    return Math.max(8, Math.min(20, Math.floor(Math.max(height, 280) / 136)));
  }
  const cols = Math.max(1, Math.floor(Math.max(width, 280) / 280));
  const rows = Math.max(3, Math.min(6, Math.floor(Math.max(height, 360) / 196)));
  const auto = Math.min(160, cols * rows);
  return auto;
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
  const boxRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(24);
  const [chunks, setChunks] = useState(1);
  const [uploadsOpen, setUploadsOpen] = useState(false);

  const fonts = useMemo(
    () =>
      sortLibrary(
        filterLibrary(
          allFonts(localFonts, googleFonts),
          scope,
          query,
          favorites,
          activated,
          collections,
          customTags,
        ),
        preview.sort ?? "name-asc",
      ),
    [localFonts, googleFonts, scope, query, favorites, activated, collections, customTags, preview.sort],
  );

  const filterKey = `${scope}|${query}|${preview.sort}|${googleFonts.length}|${localFonts.length}|${
    scopeNeedsActivated(scope)
      ? activated.length
      : scope === "favorites"
        ? favorites.length
        : collections.length
  }`;

  useEffect(() => {
    setChunks(1);
  }, [filterKey]);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const scroller = box.closest("[data-library-scroll]") as HTMLElement | null;
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const w = (scroller ?? box).clientWidth || window.innerWidth;
        const h = scroller?.clientHeight || Math.max(320, window.innerHeight - 220);
        setPage(pageForBox(w, h, preview.view === "list"));
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(scroller ?? box);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [preview.view]);

  const visible = Math.min(fonts.length, page * chunks);
  const shown = fonts.slice(0, visible);
  const shownIds = shown.map((font) => font.id).join("|");
  const remaining = Math.max(0, fonts.length - shown.length);

  useEffect(() => {
    shown.slice(0, 6).forEach((font) => {
      void loadFont(font);
    });
  }, [shownIds]);

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

  if (fonts.length === 0) {
    return (
      <div ref={boxRef} className="flex flex-1 flex-col">
        {uploadedBar}
        <div className="flex flex-1 flex-col items-center justify-center px-6 py-20 text-center">
          <p className="font-heading text-3xl">Nothing in this drawer</p>
          <p className="mt-2 max-w-sm text-sm text-muted-foreground">
            {scope === "uploaded"
              ? "Drop a folder of TTF, OTF, or WOFF files here, or use Files / Folder in the header."
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
      <div
        className={
          preview.view === "list"
            ? "flex flex-col gap-1.5 p-2.5 md:p-3"
            : "grid grid-cols-[repeat(auto-fill,minmax(17.5rem,1fr))] gap-2 p-2.5 md:p-3"
        }
      >
        {shown.map((font) => (
          <FontCard key={font.id} font={font} preview={preview} layout={preview.view} />
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2 px-4 pb-8 pt-1 text-xs text-muted-foreground">
        <span>
          Showing {shown.length.toLocaleString()} of {fonts.length.toLocaleString()}
        </span>
        {remaining > 0 ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-7 px-2.5"
            onClick={() => setChunks((n) => n + 1)}
          >
            Show {Math.min(page, remaining).toLocaleString()} more
          </Button>
        ) : null}
      </div>
      <UploadsResetDialog open={uploadsOpen} onOpenChange={setUploadsOpen} />
    </div>
  );
}