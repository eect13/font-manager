import { memo, useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { Heart, Italic, Power } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { LicenseBadge } from "./license-badge";
import { cssFamilyStack, loadFont, loadItalicFace } from "@/lib/fonts/loader";
import { axesForFont, defaultAxisValues, defaultWeightForFont, hasRealItalic, italicPreviewStyle, variationCss } from "@/lib/fonts/axes";
import { previewSample } from "@/lib/fonts/emoji";
import { scriptDir, scriptLang } from "@/lib/fonts/scripts";
import { fontLicense } from "@/lib/fonts/license";
import { useFontStore } from "@/lib/fonts/store";
import type { FontRecord, PreviewSettings } from "@/lib/fonts/types";
import { CATEGORY_LABEL } from "@/lib/fonts/types";
import { cn } from "@/lib/utils";

const ALIGN: Record<NonNullable<PreviewSettings["align"]>, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

const THEME: Record<PreviewSettings["theme"], string> = {
  paper: "bg-paper text-ink",
  ink: "bg-ink text-paper",
  newsprint: "bg-newsprint text-newsprint-fg",
  blueprint: "bg-blueprint text-blueprint-fg",
};

function isolate(e: MouseEvent | PointerEvent) {
  e.stopPropagation();
}

export const FontCard = memo(function FontCard({
  font,
  preview,
  layout,
}: {
  font: FontRecord;
  preview: PreviewSettings;
  layout: "grid" | "list";
}) {
  const ref = useRef<HTMLElement>(null);
  const [ready, setReady] = useState(false);
  const [italicOn, setItalicOn] = useState(Boolean(preview.italic) && font.italic);
  const [cardWeight, setCardWeight] = useState(() => defaultWeightForFont(font));
  const activated = useFontStore((s) => s.activatedSet.has(font.id));
  const pending = useFontStore((s) => s.pendingSet.has(font.id));
  const favorite = useFontStore((s) => s.favorites.includes(font.id));
  const toggleActivated = useFontStore((s) => s.toggleActivated);
  const toggleFavorite = useFontStore((s) => s.toggleFavorite);
  const selectFont = useFontStore((s) => s.selectFont);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = el.closest("[data-library-scroll]") as HTMLElement | null;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        void loadFont(font).then(() => setReady(true));
        io.disconnect();
      },
      { root, rootMargin: "80px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [font.id]);

  useEffect(() => {
    setItalicOn(Boolean(preview.italic) && hasRealItalic(font));
  }, [preview.italic]);

  useEffect(() => {
    setCardWeight(defaultWeightForFont(font));
  }, [font.id]);

  useEffect(() => {
    if (!italicOn) return;
    void loadItalicFace(font);
  }, [italicOn, font.id]);

  const stack = cssFamilyStack(font);
  const axes = axesForFont(font);
  const wghtAxis = axes.find((a) => a.tag === "wght");
  const align = ALIGN[preview.align ?? "left"];
  const metaTone =
    preview.theme === "paper" || preview.theme === "newsprint"
      ? "border-ink/10 bg-ink/5"
      : "border-paper/10 bg-paper/5";
  const italicCss = italicPreviewStyle(font, italicOn);
  const axisValues = font.variable
    ? { ...defaultAxisValues(axes), wght: cardWeight, ...(italicOn && axes.some((a) => a.tag === "ital") ? { ital: 1 } : {}) }
    : null;
  const specimenDir = scriptDir(font.family);
  const specimenLang = scriptLang(font.family);
  const specimenStyle = {
    fontFamily: stack,
    fontSize: layout === "list" ? Math.min(preview.fontSize, 48) : preview.fontSize,
    lineHeight: preview.lineHeight,
    letterSpacing: `${preview.letterSpacing}em`,
    fontStyle: italicCss.fontStyle,
    fontWeight: font.variable ? cardWeight : undefined,
    fontVariationSettings: axisValues ? variationCss(axisValues, axes) : italicCss.fontVariationSettings,
    fontSynthesis: italicCss.fontSynthesis,
  };

  const weightSlider = wghtAxis ? (
    <input
      type="range"
      min={wghtAxis.min}
      max={wghtAxis.max}
      step={1}
      value={cardWeight}
      aria-label={`${font.family} weight`}
      onPointerDown={isolate}
      onClick={isolate}
      onChange={(e) => {
        const n = Number(e.target.value);
        setCardWeight(n);
        if (font.variable) void loadFont(font, "full");
      }}
      className="relative z-20 h-1 w-full cursor-pointer accent-current"
    />
  ) : null;

  const italicBtn = hasRealItalic(font) ? (
    <button
      type="button"
      title={italicOn ? "Preview roman" : "Preview italic"}
      aria-label={italicOn ? "Preview roman" : "Preview italic"}
      aria-pressed={italicOn}
      onPointerDown={isolate}
      onClick={(e) => {
        isolate(e);
        setItalicOn((v) => !v);
      }}
      className={cn(
        "relative z-20 inline-flex size-6 items-center justify-center rounded border text-[10px]",
        italicOn ? "border-current bg-current/15" : "border-current/30",
      )}
    >
      <Italic className="size-3" />
    </button>
  ) : null;

  return (
    <article
      ref={ref}
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-font-id", font.id);
        e.dataTransfer.setData("text/plain", font.id);
        e.dataTransfer.effectAllowed = "copy";
      }}
      onClick={() => selectFont(font.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          selectFont(font.id);
        }
      }}
      className={cn(
        "group relative w-full cursor-pointer overflow-hidden rounded-xl text-left shadow-border transition-[box-shadow,transform] duration-200 ease-out hover:shadow-border-hover",
        layout === "list" ? "flex h-[8.5rem] flex-col" : "flex h-[12rem] flex-col",
        THEME[preview.theme],
      )}
    >
      {layout === "list" ? (
        <>
          <div className={cn("flex w-full min-w-0 items-center gap-2 border-b px-4 py-1.5 pr-20", metaTone)}>
            <span className="truncate text-sm font-medium">{font.family}</span>
            <span className="hidden text-xs uppercase tracking-wide opacity-70 sm:inline">
              {CATEGORY_LABEL[font.category]}
            </span>
            <span className="hidden text-xs opacity-70 md:inline">
              {font.variable ? "Variable" : `${font.weights.length} wts`}
              {font.italic ? " · Italic" : ""}
            </span>
            {italicBtn}
            <LicenseBadge license={fontLicense(font)} licenseName={font.licenseName} className="ml-auto opacity-100" />
            {font.source === "local" && <Badge variant="outline">Local</Badge>}
          </div>
          {weightSlider ? <div className="px-4 pb-1">{weightSlider}</div> : null}
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden px-4 py-3">
            <p
              className={cn(
                "fm-spec w-full break-words transition-opacity duration-200",
                italicOn ? "fm-spec-italic" : "fm-spec-roman",
                font.variable ? "fm-spec-variable" : "fm-spec-static",
                align,
                ready ? "opacity-100" : "opacity-40",
              )}
              dir={specimenDir}
              lang={specimenLang}
              style={specimenStyle}
            >
              {previewSample(font, preview.sampleText)}
            </p>
          </div>
        </>
      ) : (
        <>
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden px-4 py-3">
            <p
              className={cn(
                "fm-spec w-full break-words line-clamp-3 transition-opacity duration-200",
                italicOn ? "fm-spec-italic" : "fm-spec-roman",
                font.variable ? "fm-spec-variable" : "fm-spec-static",
                align,
                ready ? "opacity-100" : "opacity-40",
              )}
              dir={specimenDir}
              lang={specimenLang}
              style={specimenStyle}
            >
              {previewSample(font, preview.sampleText)}
            </p>
          </div>
          <div className={cn("flex flex-col gap-0.5 border-t px-3 py-1.5", metaTone)}>
            <div className="flex w-full min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium">{font.family}</span>
              <span className="ml-auto hidden text-xs uppercase tracking-wide opacity-70 sm:inline">
                {CATEGORY_LABEL[font.category]}
              </span>
            </div>
            <div className="flex w-full items-center gap-1.5 text-xs opacity-70">
              <span>
                {font.variable ? "Variable" : `${font.weights.length} wts`}
                {font.italic ? " · Italic" : ""}
              </span>
              {italicBtn}
              <LicenseBadge
                license={fontLicense(font)}
                licenseName={font.licenseName}
                className="ml-auto opacity-100"
              />
              {font.source === "local" && <Badge variant="outline">Local</Badge>}
            </div>
            {weightSlider}
          </div>
        </>
      )}

      <div className="absolute right-1.5 top-1.5 z-20 flex gap-1">
        <button
          type="button"
          title={favorite ? "Remove from favorites" : "Add to favorites"}
          aria-label={favorite ? "Remove favorite" : "Favorite"}
          onPointerDown={isolate}
          onClick={(e) => {
            isolate(e);
            toggleFavorite(font.id);
          }}
          className={cn(
            "flex size-8 items-center justify-center rounded-full bg-background/80 text-foreground backdrop-blur-sm",
            favorite && "text-destructive",
          )}
        >
          <Heart className={cn("size-3.5", favorite && "fill-current")} />
        </button>
        <button
          type="button"
          title={activated ? "Deactivate — hide from other apps, keep files" : pending ? "Queued" : "Activate"}
          aria-label={activated ? "Deactivate" : pending ? "Queued" : "Activate"}
          onPointerDown={isolate}
          onClick={(e) => {
            isolate(e);
            toggleActivated(font.id);
          }}
          className={cn(
            "flex size-8 items-center justify-center rounded-full bg-background/80 text-foreground backdrop-blur-sm",
            activated && "bg-primary text-primary-foreground",
            pending && !activated && "animate-pulse bg-primary/40 text-primary-foreground",
          )}
        >
          <Power className="size-3.5" />
        </button>
      </div>
    </article>
  );
});
