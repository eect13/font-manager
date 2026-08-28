import { useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, Copy } from "lucide-react";
import { toast } from "sonner";
import { copyText } from "@/lib/copy-text";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { FontPicker } from "./font-picker";
import { googleFontId } from "@/lib/fonts/catalog";
import { cssFamilyStack, loadFont, loadFontWeight } from "@/lib/fonts/loader";
import { synthesisForFont } from "@/lib/fonts/synthesis";
import { allFonts, findFont, useFontStore } from "@/lib/fonts/store";
import { axesForFont, defaultAxisValues, defaultWeightForFont, instancesForFont, resolvedAxisValues, variationCss, variationStyle } from "@/lib/fonts/axes";
import { AxisSliders } from "./axis-sliders";
import { cn } from "@/lib/utils";

const HEADING_SAMPLE = "Display the story, then set the body.";
const BODY_SAMPLE =
  "A pairing works when contrast is clear and rhythm agrees. Try a display serif against a quiet sans, or a geometric headline with a humanist paragraph. Adjust size until the two speak in one voice.";

export function Playground() {
  const localFonts = useFontStore((s) => s.localFonts);
  const googleFonts = useFontStore((s) => s.googleFonts);
  const activatedSet = useFontStore((s) => s.activatedSet);
  const activatedFonts = useMemo(
    () =>
      allFonts(localFonts, googleFonts)
        .filter((font) => activatedSet.has(font.id))
        .sort((a, b) => a.family.localeCompare(b.family)),
    [localFonts, googleFonts, activatedSet],
  );
  const [leftId, setLeftId] = useState(googleFontId("Playfair Display"));
  const [rightId, setRightId] = useState(googleFontId("Source Sans 3"));
  const [leftSize, setLeftSize] = useState(48);
  const [rightSize, setRightSize] = useState(18);
  const [leftWeight, setLeftWeight] = useState(700);
  const [rightWeight, setRightWeight] = useState(400);
  const [leftAxes, setLeftAxes] = useState<Record<string, number>>({});
  const [rightAxes, setRightAxes] = useState<Record<string, number>>({});
  const [heading, setHeading] = useState(HEADING_SAMPLE);
  const [body, setBody] = useState(BODY_SAMPLE);
  const [invert, setInvert] = useState(false);

  const left = findFont(leftId, localFonts, googleFonts);
  const right = findFont(rightId, localFonts, googleFonts);

  useEffect(() => {
    if (!activatedFonts.length) return;
    if (!activatedSet.has(leftId)) setLeftId(activatedFonts[0]!.id);
    if (!activatedSet.has(rightId)) {
      setRightId((activatedFonts[1] ?? activatedFonts[0])!.id);
    }
  }, [activatedFonts, activatedSet, leftId, rightId]);

  useEffect(() => {
    if (left) {
      void loadFont(left, "full");
      setLeftAxes(defaultAxisValues(axesForFont(left), instancesForFont(left)));
      setLeftWeight(defaultWeightForFont(left));
    }
  }, [leftId]);
  useEffect(() => {
    if (right) {
      void loadFont(right, "full");
      setRightAxes(defaultAxisValues(axesForFont(right), instancesForFont(right)));
      setRightWeight(defaultWeightForFont(right));
    }
  }, [rightId]);

  const css = useMemo(() => {
    if (!left || !right) return "";
    const leftAxesResolved = resolvedAxisValues(axesForFont(left), { ...leftAxes, wght: leftAxes.wght ?? leftWeight });
    const rightAxesResolved = resolvedAxisValues(axesForFont(right), { ...rightAxes, wght: rightAxes.wght ?? rightWeight });
    const leftVar = variationCss(leftAxesResolved, axesForFont(left));
    const rightVar = variationCss(rightAxesResolved, axesForFont(right));
    return `h1 {\n  font-family: ${cssFamilyStack(left)};\n  font-weight: ${Math.round(leftAxesResolved.wght ?? leftWeight)};\n  font-size: ${leftSize}px;\n  font-variation-settings: ${leftVar};\n}\n\np {\n  font-family: ${cssFamilyStack(right)};\n  font-weight: ${Math.round(rightAxesResolved.wght ?? rightWeight)};\n  font-size: ${rightSize}px;\n  font-variation-settings: ${rightVar};\n}`;
  }, [left, right, leftSize, rightSize, leftWeight, rightWeight, leftAxes, rightAxes]);

  function swap() {
    setLeftId(rightId);
    setRightId(leftId);
    setLeftSize(rightSize);
    setRightSize(leftSize);
    setLeftWeight(rightWeight);
    setRightWeight(leftWeight);
  }

  const surface = invert ? "bg-ink text-paper" : "bg-paper text-ink";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="grid shrink-0 gap-4 border-b border-border p-4 md:grid-cols-[1fr_auto_1fr] md:p-6">
        <PaneControls
          label="Heading"
          fontId={leftId}
          onFont={setLeftId}
          size={leftSize}
          onSize={setLeftSize}
          weight={leftWeight}
          onWeight={setLeftWeight}
          weights={left?.weights ?? [400, 700]}
          font={left}
          axes={left ? axesForFont(left) : []}
          instances={left ? instancesForFont(left) : []}
          axisValues={leftAxes}
          onAxis={(tag, value) => {
            setLeftAxes((prev) => ({ ...prev, [tag]: value }));
            if (tag === "wght") {
              setLeftWeight(Math.round(value));
              if (left) void loadFontWeight(left, Math.round(value));
            }
          }}
        />
        <div className="flex items-end justify-center">
          <Button variant="ghost" size="icon" aria-label="Swap fonts" onClick={swap}>
            <ArrowLeftRight />
          </Button>
        </div>
        <PaneControls
          label="Body"
          fontId={rightId}
          onFont={setRightId}
          size={rightSize}
          onSize={setRightSize}
          weight={rightWeight}
          onWeight={setRightWeight}
          weights={right?.weights ?? [400, 700]}
          font={right}
          axes={right ? axesForFont(right) : []}
          instances={right ? instancesForFont(right) : []}
          axisValues={rightAxes}
          onAxis={(tag, value) => {
            setRightAxes((prev) => ({ ...prev, [tag]: value }));
            if (tag === "wght") {
              setRightWeight(Math.round(value));
              if (right) void loadFontWeight(right, Math.round(value));
            }
          }}
        />
      </div>

      <div className="fm-scroll grid min-h-0 flex-1 gap-px overflow-auto bg-border lg:grid-cols-2">
        <article className={cn("fm-scroll min-h-0 overflow-y-auto overscroll-contain p-6 md:p-10", surface)}>
          <textarea
            value={heading}
            onChange={(e) => setHeading(e.target.value)}
            className="fm-scroll w-full resize-none bg-transparent outline-none"
            rows={3}
            style={{
              fontFamily: left ? cssFamilyStack(left) : undefined,
              fontSize: leftSize,
              lineHeight: 1.15,
              fontWeight: leftAxes.wght ?? leftWeight,
              fontSynthesis: left ? synthesisForFont(left, { weight: leftAxes.wght ?? leftWeight }) : "weight",
              ...(left?.variable
                ? variationStyle({ ...leftAxes, wght: leftAxes.wght ?? leftWeight }, axesForFont(left))
                : {}),
            }}
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className="fm-scroll mt-4 w-full resize-none bg-transparent outline-none"
            rows={8}
            style={{
              fontFamily: right ? cssFamilyStack(right) : undefined,
              fontSize: rightSize,
              lineHeight: 1.55,
              fontWeight: rightAxes.wght ?? rightWeight,
              fontSynthesis: right ? synthesisForFont(right, { weight: rightAxes.wght ?? rightWeight }) : "weight",
              ...(right?.variable
                ? variationStyle({ ...rightAxes, wght: rightAxes.wght ?? rightWeight }, axesForFont(right))
                : {}),
            }}
          />
        </article>
        <article className={cn("fm-scroll min-h-0 overflow-y-auto overscroll-contain p-6 md:p-10", invert ? "bg-paper text-ink" : "bg-ink text-paper")}>
          <p
            className="leading-tight"
            style={{
              fontFamily: left ? cssFamilyStack(left) : undefined,
              fontSize: Math.max(28, leftSize * 0.7),
              fontWeight: leftAxes.wght ?? leftWeight,
              fontSynthesis: left ? synthesisForFont(left, { weight: leftAxes.wght ?? leftWeight }) : "weight",
              ...(left?.variable
                ? variationStyle({ ...leftAxes, wght: leftAxes.wght ?? leftWeight }, axesForFont(left))
                : {}),
            }}
          >
            {heading}
          </p>
          <p
            className="mt-4 max-w-prose"
            style={{
              fontFamily: right ? cssFamilyStack(right) : undefined,
              fontSize: rightSize,
              lineHeight: 1.55,
              fontWeight: rightAxes.wght ?? rightWeight,
              fontSynthesis: right ? synthesisForFont(right, { weight: rightAxes.wght ?? rightWeight }) : "weight",
              ...(right?.variable
                ? variationStyle({ ...rightAxes, wght: rightAxes.wght ?? rightWeight }, axesForFont(right))
                : {}),
            }}
          >
            {body}
          </p>
        </article>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-border px-4 py-3 md:px-6">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setInvert((v) => !v)}
        >
          Flip paper
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            try {
              await copyText(css);
              toast.success("Pairing CSS copied");
            } catch {
              toast.error("Clipboard blocked — select and press Ctrl+C");
            }
          }}
        >
          <Copy />
          Copy pairing CSS
        </Button>
        <p className="text-xs text-muted-foreground">
          {left?.family} + {right?.family}
        </p>
      </div>
    </div>
  );
}

function PaneControls({
  label,
  fontId,
  onFont,
  size,
  onSize,
  weight,
  onWeight,
  weights,
  font,
  axes,
  instances = [],
  axisValues,
  onAxis,
}: {
  label: string;
  fontId: string;
  onFont: (id: string) => void;
  size: number;
  onSize: (n: number) => void;
  weight: number;
  onWeight: (n: number) => void;
  weights: number[];
  font?: ReturnType<typeof findFont>;
  axes: ReturnType<typeof axesForFont>;
  instances?: ReturnType<typeof instancesForFont>;
  axisValues: Record<string, number>;
  onAxis: (tag: string, value: number) => void;
}) {
  return (
    <div className="space-y-3">
      <Label>{label}</Label>
      <FontPicker value={fontId} onChange={onFont} label={label} />
      <div className="flex items-center gap-3">
        <span className="w-10 text-xs tabular-nums text-muted-foreground">{size}</span>
        <Slider min={12} max={96} value={[size]} onValueChange={([v]) => { if (typeof v === "number") onSize(v); }} />
      </div>
      {axes.length ? (
        <AxisSliders axes={axes} values={axisValues} onChange={onAxis} instances={instances} />
      ) : (
      <div className="flex flex-wrap gap-1">
        {weights.map((w) => (
          <button
            key={w}
            type="button"
            onClick={() => {
              onWeight(w);
              if (font) void loadFontWeight(font, w);
            }}
            className={cn(
              "h-8 min-w-10 rounded-md px-2 font-mono text-xs tabular-nums",
              weight === w ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground",
            )}
          >
            {w}
          </button>
        ))}
      </div>
      )}
    </div>
  );
}

