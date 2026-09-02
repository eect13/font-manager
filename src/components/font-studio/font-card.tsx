import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent, type RefObject } from "react";
import { GripVertical, Heart, Italic, Power } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { cssFamilyStack, loadFont, loadItalicFace } from "@/lib/fonts/loader";
import { isDesktopShellSync } from "@/lib/desktop/open-fonts";
import { axesForFont, defaultWeightForFont, hasRealItalic, isItalicOnlyFace, italicPreviewStyle, previewAxisValues, variationStyle } from "@/lib/fonts/axes";
import { previewSample } from "@/lib/fonts/emoji";
import { scriptDir, scriptLang } from "@/lib/fonts/scripts";
import { useFontStore } from "@/lib/fonts/store";
import { useLiveAxes } from "@/lib/fonts/live-axes";
import type { FontRecord, PreviewSettings } from "@/lib/fonts/types";
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

function paintWeight(el: HTMLElement, weight: number, fvs?: string) {
  const w = String(Math.round(weight));
  el.style.fontWeight = w;
  if (fvs && fvs !== "normal") el.style.fontVariationSettings = fvs;
  else el.style.removeProperty("font-variation-settings");
  el.dataset.wght = w;
}

/** Shrink-to-fit listens to size/family/copy — never to weight, or heavier glyphs get smaller and cancel the axis. */
const FitSpecimen = memo(function FitSpecimen({
  ready,
  className,
  style,
  dir,
  lang,
  weight,
  fvs,
  children,
  specRef,
}: {
  ready: boolean;
  className?: string;
  style: CSSProperties;
  dir?: string;
  lang?: string;
  weight?: number;
  fvs?: string;
  children: string;
  specRef: RefObject<HTMLParagraphElement | null>;
}) {
  const maxSize = typeof style.fontSize === "number" ? style.fontSize : Number.parseFloat(String(style.fontSize ?? 36));
  const fittedPx = useRef(0);

  useLayoutEffect(() => {
    const el = specRef.current;
    if (!el || weight == null) return;
    paintWeight(el, weight, fvs || undefined);
    if (fittedPx.current > 0) el.style.fontSize = `${fittedPx.current}px`;
  }, [specRef, weight, fvs]);

  useLayoutEffect(() => {
    const el = specRef.current;
    if (!el || !ready) return;
    let size = Number.isFinite(maxSize) && maxSize > 0 ? maxSize : 36;
    el.style.fontSize = `${size}px`;
    const pane = el.parentElement;
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
    fittedPx.current = size;
  }, [ready, children, maxSize, style.fontFamily, style.fontStyle, specRef]);

  return (
    <p
      ref={specRef}
      className={className}
      dir={dir}
      lang={lang}
      data-wght={weight != null ? String(Math.round(weight)) : undefined}
      style={style}
    >
      {children}
    </p>
  );
});

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
  const specRef = useRef<HTMLParagraphElement>(null);
  const [ready, setReady] = useState(false);
  const [italicOn, setItalicOn] = useState(isItalicOnlyFace(font) || Boolean(preview.italic));
  const [axisHeld, setAxisHeld] = useState(false);
  const vfPrimed = useRef(false);
  const activated = useFontStore((s) => s.activatedSet.has(font.id));
  const pending = useFontStore((s) => s.pendingSet.has(font.id));
  const favorite = useFontStore((s) => s.favorites.includes(font.id));
  const hasCollections = useFontStore((s) => s.collections.length > 0);
  const toggleActivated = useFontStore((s) => s.toggleActivated);
  const toggleFavorite = useFontStore((s) => s.toggleFavorite);
  const selectFont = useFontStore((s) => s.selectFont);
  const setPreviewAxis = useFontStore((s) => s.setPreviewAxis);
  const storedAxes = useLiveAxes(font.id);
  const cardWeight = storedAxes?.wght ?? defaultWeightForFont(font);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = el.closest("[data-library-scroll]") as HTMLElement | null;
    let timeout = 0;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        if (font.source === "system") {
          setReady(true);
          io.disconnect();
          return;
        }
        void loadFont(font, font.variable ? "full" : "preview").finally(() => setReady(true));
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
    if (isItalicOnlyFace(font)) {
      setItalicOn(true);
      return;
    }
    setItalicOn(Boolean(preview.italic));
  }, [preview.italic, font.id, font.italic, font.variable, font.source, font.fileName, font.fullName]);

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
  const axisValues = font.variable ? previewAxisValues(font, storedAxes, cardWeight, italicOn) : null;
  const vs = axisValues ? variationStyle(axisValues, axes) : null;
  const specimenDir = scriptDir(font.family);
  const specimenLang = scriptLang(font.family);
  const paintFvs = vs?.fontVariationSettings ?? italicCss.fontVariationSettings;
  const paintWeightN = vs?.fontWeight ?? (font.variable ? cardWeight : defaultWeightForFont(font));
  const specimenStyle: CSSProperties = {
    fontFamily: stack,
    fontSize: layout === "list" ? Math.min(preview.fontSize, 48) : preview.fontSize,
    lineHeight: preview.lineHeight,
    letterSpacing: `${preview.letterSpacing}em`,
    fontStyle: italicCss.fontStyle ?? vs?.fontStyle,
    fontWeight: paintWeightN,
    fontVariationSettings: paintFvs,
    fontStretch: vs?.fontStretch,
    fontSynthesis: italicCss.fontSynthesis,
    fontOpticalSizing: font.variable ? "auto" : undefined,
    ...(font.colorKind && font.colorKind !== "none"
      ? { fontPalette: "normal", fontVariantEmoji: "emoji" as const }
      : {}),
  };

  function applyAxis(tag: string, n: number) {
    if (!Number.isFinite(n)) return;
    if (tag === "wght") {
      const el = specRef.current;
      if (el) {
        const next = { ...(axisValues ?? { wght: n }), wght: n };
        paintWeight(el, n, variationStyle(next, axes).fontVariationSettings);
      }
    }
    setPreviewAxis(font.id, tag, n);
    if (font.variable && !vfPrimed.current) {
      vfPrimed.current = true;
      void loadFont(font, "full");
    }
  }

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
        onValueChange={([n]) => applyAxis("wght", n)}
      />
    </div>
  ) : null;

  const italicBtn = isItalicOnlyFace(font) ? (
    <button
      type="button"
      title="Italic file"
      aria-label="Italic file"
      aria-pressed
      className="relative z-20 inline-flex size-5 shrink-0 items-center justify-center rounded border border-current bg-current/15"
    >
      <Italic className="size-3" />
    </button>
  ) : (
    <button
      type="button"
      title={italicOn ? "Preview roman" : "Preview italic"}
      aria-label={italicOn ? "Preview roman" : "Preview italic"}
      aria-pressed={italicOn}
      onPointerDown={isolate}
      onClick={(e) => {
        isolate(e);
        const next = !italicOn;
        setItalicOn(next);
        const ital = axes.find((a) => a.tag === "ital");
        const slnt = axes.find((a) => a.tag === "slnt");
        if (ital) applyAxis("ital", next ? 1 : 0);
        if (slnt) {
          applyAxis(
            "slnt",
            next ? (slnt.min < 0 ? slnt.min : slnt.max) : slnt.min <= 0 && slnt.max >= 0 ? 0 : slnt.def,
          );
        }
      }}
      className={cn(
        "relative z-20 inline-flex size-5 shrink-0 items-center justify-center rounded border",
        italicOn ? "border-current bg-current/15" : "border-current/30",
      )}
    >
      <Italic className="size-3" />
    </button>
  );

  const specimen = (
    <FitSpecimen
      ready={ready}
      specRef={specRef}
      weight={paintWeightN}
      fvs={typeof paintFvs === "string" ? paintFvs : undefined}
      className={cn(
        "fm-spec fm-spec-fit w-full transition-opacity duration-200",
        italicOn ? "fm-spec-italic" : "fm-spec-roman",
        font.variable ? "fm-spec-variable" : "fm-spec-static",
        italicOn && hasRealItalic(font) && Boolean(font.axes?.some((a) => a.tag === "ital" || a.tag === "slnt"))
          ? "fm-spec-real"
          : null,
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
            <span className="min-w-0 truncate text-sm font-medium">{font.fullName || font.family}</span>
            {italicBtn}
            {font.source === "local" && <Badge variant="outline" className="ml-auto">Local</Badge>}
          </div>
          {specimenPane}
        </>
      ) : (
        <>
          {specimenPane}
          <div className={cn("fm-card-meta flex h-11 w-full min-w-0 shrink-0 items-center gap-1.5 border-t px-3", metaTone)}>
            <span className="min-w-0 truncate text-sm font-medium">{font.fullName || font.family}</span>
            {italicBtn}
            <span className="ml-auto flex min-w-0 items-center gap-1.5">
              {wghtAxis ? (
                <span className="font-mono text-[10px] tabular-nums opacity-0 transition-opacity group-hover:opacity-55">
                  {Math.round(cardWeight)}
                </span>
              ) : null}
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
        {font.source === "system" ? (
          <span
            title="System font — already installed. Read-only."
            className="flex size-8 items-center justify-center rounded-full bg-background/80 text-[10px] font-medium uppercase tracking-wide text-muted-foreground backdrop-blur-sm"
          >
            OS
          </span>
        ) : (
        <button
          type="button"
          title={
            activated
              ? "Deactivate — hide from other apps, keep files"
              : pending
                ? "Queued"
                : isDesktopShellSync()
                  ? "Activate"
                  : "Mark on. Word and Adobe only see session fonts in the desktop app."
          }
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
        )}
      </div>
    </article>
  );
});
