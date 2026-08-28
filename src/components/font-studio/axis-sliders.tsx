import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  axisLabel,
  axisStep,
  instanceMatches,
  isBinaryAxis,
  type FontAxis,
  type NamedInstance,
} from "@/lib/fonts/axes";
import { cn } from "@/lib/utils";

export function AxisSliders({
  axes,
  values,
  onChange,
  instances = [],
}: {
  axes: FontAxis[];
  values: Record<string, number>;
  onChange: (tag: string, value: number) => void;
  instances?: NamedInstance[];
}) {
  if (!axes.length) return null;
  return (
    <div className="space-y-3">
      {instances.length ? (
        <div className="flex flex-wrap gap-1">
          {instances.map((inst, i) => (
            <button
              key={`${inst.name}-${i}`}
              type="button"
              className={cn(
                "h-7 rounded-md px-2 text-xs",
                instanceMatches(inst, values) ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground",
              )}
              onClick={() => {
                for (const [tag, n] of Object.entries(inst.coords)) onChange(tag, n);
              }}
            >
              {inst.name}
            </button>
          ))}
        </div>
      ) : null}
      {axes.map((axis) => {
        const value = values[axis.tag] ?? axis.def;
        const span = axis.max - axis.min;
        if (!(span > 0) && !isBinaryAxis(axis)) return null;
        if (isBinaryAxis(axis)) {
          const on = value >= (axis.min + axis.max) / 2;
          return (
            <div key={axis.tag} className="flex h-8 items-center justify-between gap-2">
              <Label className="text-xs font-medium">
                {axisLabel(axis.tag, axis.name)}
                <span className="ml-1 font-mono text-[10px] uppercase text-muted-foreground">{axis.tag}</span>
              </Label>
              <Switch
                checked={on}
                aria-label={axisLabel(axis.tag, axis.name)}
                onCheckedChange={(next) => onChange(axis.tag, next ? axis.max : axis.min)}
              />
            </div>
          );
        }
        const step = axisStep(axis);
        return (
          <div key={axis.tag} className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-xs font-medium">
                {axisLabel(axis.tag, axis.name)}
                <span className="ml-1 font-mono text-[10px] uppercase text-muted-foreground">{axis.tag}</span>
              </Label>
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {step < 1 ? Number(value.toFixed(1)) : Math.round(value)}
              </span>
            </div>
            <Slider
              min={axis.min}
              max={axis.max}
              step={step}
              value={[value]}
              aria-label={axisLabel(axis.tag, axis.name)}
              onValueChange={([n]) => onChange(axis.tag, n ?? axis.def)}
            />
          </div>
        );
      })}
    </div>
  );
}
