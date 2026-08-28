import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

type SliderProps = Omit<ComponentProps<"input">, "value" | "onChange" | "type"> & {
  value?: number[];
  defaultValue?: number[];
  onValueChange?: (value: number[]) => void;
};

export function Slider({
  className,
  min = 0,
  max = 100,
  step = 1,
  value,
  defaultValue,
  onValueChange,
  disabled,
  "aria-label": ariaLabel,
  ...props
}: SliderProps) {
  const lo = Number(min);
  const hi = Number(max);
  const current = value?.[0] ?? defaultValue?.[0] ?? lo;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
    return <div className={cn("h-6 w-full rounded-full bg-border", className)} aria-hidden />;
  }
  return (
    <input
      {...props}
      type="range"
      min={lo}
      max={hi}
      step={step}
      value={current}
      disabled={disabled}
      aria-label={ariaLabel}
      draggable={false}
      onPointerDown={(e) => {
        e.stopPropagation();
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      }}
      onPointerMove={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDragStart={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onValueChange?.([n]);
      }}
      className={cn(
        "fm-weight-slider h-8 w-full cursor-pointer appearance-none bg-transparent accent-primary disabled:opacity-40",
        className,
      )}
    />
  );
}
