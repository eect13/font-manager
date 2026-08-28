import { memo, useEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from "react";
import { GripVertical, Heart, Italic, Power } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { LicenseBadge } from "./license-badge";
import { cssFamilyStack, loadFont, loadItalicFace } from "@/lib/fonts/loader";
import { axesForFont, defaultAxisValues, defaultWeightForFont, hasRealItalic, italicPreviewStyle, variationStyle } from "@/lib/fonts/axes";
import { previewSample } from "@/lib/fonts/emoji";
import { colorKindLabel } from "@/lib/fonts/color-font";
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

function FitSpecimen({
  ready,
  className,
  style,
  dir,
  lang,
  children,
}: {
  ready: boolean;
  className?: string;
  style: CSSProperties;
  dir?: string;
  lang?: string;
  children: string;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  const maxSize = typeof style.fontSize === "number" ? style.fontSize : Number.parseFloat(String(style.fontSize ?? 36));

  useEffect(() => {
    const el = ref.current;
    if (!el || !ready) return;
    const pane = el.parentElement;
    const fit = () => {
      let size = Number.isFinite(maxSize) && maxSize > 0 ? maxSize : 36;
      el.style.fontSize = `${size}px`;
      let budget = el.clientHeight;
      if (pane) {
        const cs = getComputedStyle(pane);
        budget =
          pane.clientHeight - (Number.parseFloat(cs.paddingTop) || 0) - (Number.parseFloat(cs.paddingBottom) || 0);
      }
      let guard = 0;
      while (el.scrollHeight > budget + 1 && size > 13 && guard < 14) {
        size *= 0.86;
        el.style.fontSize = `${size}px`;
        guard += 1;
      }
    };
    fit();
  }, [ready, children, maxSize, style.fontFamily, style.fontWeight, style.fontVariationSettings, style.fontStyle]);

  return (
    <p ref={ref} className={className} dir={dir} lang={lang} style={style}>
      {children}
    </p>
  );
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
  const [axisHeld, setAxisHeld] = useState(false);
  const vfPrimed = useRef(false);
  const activated = useFontStore((s) => s.activatedSet.has(font.id));
  const pending = useFontStore((s) => s.pendingSet.has(font.id));
  const favorite = useFontStore((s) => s.favorites.includes(font.id));
  const hasCollections = useFontStore((s) => s.collections.length > 0);
  const toggleActivated = useFontStore((s) => s.toggleActivated);
  const toggleFavorite = useFontStore((s) => s.toggleFavorite);
  const selectFont = useFontStore((s) => s.selectFont);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = el.closest("[data-library-scroll]") as HTMLElement | null;
    let timeout = 0;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        void loadFont(font).finally(() => setReady(true));
        timeout = window.setTimeout(() => setReady(true), 240);
        io.disconnect();
      },
      { root, rootMargin: "320px" },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      window.clearTimeout(timeout);
    };
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
  const vs = axisValues ? variationStyle(axisValues, axes) : null;
  const specimenDir = scriptDir(font.family);
  const specimenLang = scriptLang(font.family);
  const specimenStyle: CSSProperties = {
    fontFamily: stack,
    fontSize: layout === "list" ? Math.min(preview.fontSize, 48) : preview.fontSize,
    lineHeight: preview.lineHeight,
    letterSpacing: `${preview.letterSpacing}em`,
    fontStyle: italicCss.fontStyle ?? vs?.fontStyle,
    fontWeight: vs?.fontWeight ?? (font.variable ? cardWeight : undefined),
    fontVariationSettings: vs?.fontVariationSettings ?? italicCss.fontVariationSettings,
    fontStretch: vs?.fontStretch,
    fontSynthesis: italicCss.fontSynthesis,
  };

  const axisPop = wghtAxis ? (
    <div
      data-no-drag
      data-open={axisHeld ? "true" : undefined}
      className="fm-axis-pop absolute inset-x-3 bottom-2 z-30 flex items-center gap-2 rounded-md px-2 py-0.5"
      onPointerDown={(e) => {
        isolate(e);
        setAxisHeld(true);
      }}
      onPointerUpCapture={() => setAxisHeld(false)}
      onPointerCancel={() => setAxisHeld(false)}
      onMouseDown={isolate}
      onClick={isolate}
      onDragStart={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <span className="w-7 shrink-0 text-center font-mono text-[10px] tabular-nums opacity-55">
        {Math.round(cardWeight)}
      </span>
      <Slider
        min={wghtAxis.min}
        max={wghtAxis.max}
        step={1}
        value={[cardWeight]}
        aria-label={`${font.family} weight`}
        onValueChange={([n]) => {
          if (!Number.isFinite(n)) return;
          setCardWeight(n);
          if (font.variable && !vfPrimed.current) {
            vfPrimed.current = true;
            void loadFont(font, "full");
          }
        }}
      />
    </div>
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
        "relative z-20 inline-flex size-5 shrink-0 items-center justify-center rounded border",
        italicOn ? "border-current bg-current/15" : "border-current/30",
      )}
    >
      <Italic className="size-3" />
    </button>
  ) : null;

  const colorNote = font.colorKind && font.colorKind !== "none" ? colorKindLabel(font.colorKind) : "";

  const specimen = (
    <FitSpecimen
      ready={ready}
      className={cn(
        "fm-spec fm-spec-fit w-full transition-opacity duration-200",
        italicOn ? "fm-spec-italic" : "fm-spec-roman",
        font.variable ? "fm-spec-variable" : "fm-spec-static",
        align,
        ready ? "opacity-100" : "opacity-0",
      )}
      dir={specimenDir}
      lang={specimenLang}
      style={specimenStyle}
    >
      {previewSample(font, preview.sampleText)}
    </FitSpecimen>
  );

  const specimenPane = (
    <div className={cn("fm-spec-pane px-4", layout === "list" ? "py-2" : "py-3")}>
      {specimen}
      {axisPop}
    </div>
  );

  return (
    <article
      ref={ref}
      role="button"
      tabIndex={0}
      onClick={() => selectFont(font.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          selectFont(font.id);
        }
      }}
      className={cn(
        "fm-font-card group relative w-full cursor-pointer overflow-hidden rounded-xl text-left shadow-border",
        layout === "list" ? "flex h-[9.5rem] flex-col" : "flex h-[14.5rem] flex-col",
        THEME[preview.theme],
      )}
    >
      {hasCollections ? (
        <button
          type="button"
          draggable
          title="Drag to a collection"
          aria-label="Drag to a collection"
          className="absolute left-1 top-1/2 z-30 flex size-7 -translate-y-1/2 cursor-grab items-center justify-center rounded-md bg-background/80 text-muted-foreground opacity-0 backdrop-blur-sm group-hover:opacity-100 active:cursor-grabbing"
          onPointerDown={isolate}
          onClick={(e) => e.stopPropagation()}
          onDragStart={(e) => {
            e.stopPropagation();
            e.dataTransfer.setData("application/x-font-id", font.id);
            e.dataTransfer.setData("text/plain", font.id);
            e.dataTransfer.effectAllowed = "copy";
          }}
        >
          <GripVertical className="size-3.5" />
        </button>
      ) : null}

      {layout === "list" ? (
        <>
          <div className={cn("fm-card-meta flex h-11 w-full min-w-0 shrink-0 items-center gap-1.5 border-b px-3 pr-20", metaTone)}>
            <span className="min-w-0 truncate text-sm font-medium">{font.family}</span>
            {wghtAxis ? (
              <span className="hidden font-mono text-[10px] tabular-nums opacity-55 sm:inline">{Math.round(cardWeight)}</span>
            ) : null}
            <span className="hidden text-xs uppercase tracking-wide opacity-70 sm:inline">
              {CATEGORY_LABEL[font.category]}
            </span>
            <span className="hidden truncate text-xs opacity-70 md:inline">
              {font.variable ? "Variable" : `${font.weights.length} wts`}
              {font.italic ? " · Italic" : ""}
            </span>
            {italicBtn}
            <LicenseBadge license={fontLicense(font)} licenseName={font.licenseName} className="ml-auto opacity-100" />
            {font.source === "local" && <Badge variant="outline">Local</Badge>}
          </div>
          {specimenPane}
        </>
      ) : (
        <>
          {specimenPane}
          <div className={cn("fm-card-meta flex h-11 w-full min-w-0 shrink-0 items-center gap-1.5 border-t px-3", metaTone)}>
            <span className="min-w-0 truncate text-sm font-medium">{font.family}</span>
            {wghtAxis ? (
              <span className="font-mono text-[10px] tabular-nums opacity-55">{Math.round(cardWeight)}</span>
            ) : null}
            {italicBtn}
            <span className="ml-auto flex min-w-0 items-center gap-1.5">
              <span className="hidden truncate text-xs uppercase tracking-wide opacity-70 sm:inline">
                {CATEGORY_LABEL[font.category]}
              </span>
              <span className="hidden truncate text-xs opacity-70 sm:inline">
                {font.variable ? "Variable" : `${font.weights.length} wts`}
                {font.italic ? " · Italic" : ""}
              </span>
              {colorNote ? (
                <span className="hidden truncate text-[10px] uppercase tracking-wide opacity-70 md:inline" title={colorNote}>
                  Color
                </span>
              ) : null}
              <LicenseBadge license={fontLicense(font)} licenseName={font.licenseName} className="opacity-100" />
              {font.source === "local" && <Badge variant="outline">Local</Badge>}
            </span>
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
