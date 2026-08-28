import { AlignCenter, AlignLeft, AlignRight, ArrowDownAZ, Check, Italic, LayoutGrid, List, Type } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { HelpTip } from "./help-tip";
import { ALIGN_LABEL, SAMPLE_PRESETS, SORT_LABEL, type LibrarySort, type PreviewAlign, type PreviewTheme } from "@/lib/fonts/types";
import { useFontStore } from "@/lib/fonts/store";
import { cn } from "@/lib/utils";

const THEMES: { id: PreviewTheme; label: string; hint: string }[] = [
  { id: "paper", label: "Paper", hint: "Light paper specimen" },
  { id: "ink", label: "Ink", hint: "Inverted ink on black" },
  { id: "newsprint", label: "News", hint: "Warm newsprint" },
  { id: "blueprint", label: "Print", hint: "Blueprint proof" },
];

const SORTS: LibrarySort[] = ["name-asc", "name-desc", "popular", "recent"];

const ALIGNS: { id: PreviewAlign; icon: typeof AlignLeft }[] = [
  { id: "left", icon: AlignLeft },
  { id: "center", icon: AlignCenter },
  { id: "right", icon: AlignRight },
];

export function PreviewToolbar() {
  const preview = useFontStore((s) => s.preview);
  const setPreview = useFontStore((s) => s.setPreview);
  const sort = preview.sort ?? "name-asc";
  const align = preview.align ?? "left";

  return (
    <div className="flex flex-col gap-1.5 border-b border-border bg-background/90 px-3 py-1.5 backdrop-blur-sm md:px-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="flex min-w-[180px] flex-1 items-center gap-2">
          <Type className="size-4 shrink-0 text-muted-foreground" />
          <Input
            value={preview.sampleText}
            onChange={(e) => setPreview({ sampleText: e.target.value })}
            placeholder="Type to preview…"
            className="h-8 bg-card"
            aria-label="Preview text"
          />
        </div>
        <div
          className="flex w-36 shrink-0 items-center gap-1.5"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <span className="w-6 shrink-0 text-right text-xs tabular-nums text-muted-foreground" title="Preview size">
            {preview.fontSize}
          </span>
          <Slider
            min={14}
            max={96}
            step={1}
            value={[preview.fontSize]}
            onValueChange={([fontSize]) => {
              if (typeof fontSize === "number") setPreview({ fontSize });
            }}
            aria-label="Font size"
          />
        </div>
        <Button
          type="button"
          size="icon-sm"
          variant={preview.italic ? "secondary" : "ghost"}
          aria-pressed={Boolean(preview.italic)}
          aria-label="Preview italic"
          title="Preview italic"
          onClick={() => setPreview({ italic: !preview.italic })}
        >
          <Italic />
        </Button>
        <div
          className="flex w-32 shrink-0 items-center gap-1.5"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <span className="w-6 shrink-0 text-right text-xs tabular-nums text-muted-foreground" title="Line height">
            {preview.lineHeight.toFixed(1)}
          </span>
          <Slider
            min={0.9}
            max={2}
            step={0.05}
            value={[preview.lineHeight]}
            onValueChange={([lineHeight]) => {
              if (typeof lineHeight === "number") setPreview({ lineHeight });
            }}
            aria-label="Line height"
          />
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {THEMES.map((theme) => (
            <HelpTip key={theme.id} label={theme.hint}>
              <button
                type="button"
                onClick={() => setPreview({ theme: theme.id })}
                className={cn(
                  "h-7 rounded-full px-2.5 text-xs font-medium transition-colors duration-150",
                  preview.theme === theme.id
                    ? "bg-primary text-primary-foreground"
                    : "bg-secondary text-muted-foreground hover:text-foreground",
                )}
              >
                {theme.label}
              </button>
            </HelpTip>
          ))}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <div
            role="group"
            aria-label="Preview alignment"
            className="mr-0.5 flex items-center rounded-md bg-secondary p-0.5"
          >
            {ALIGNS.map((item) => {
              const Icon = item.icon;
              return (
                <HelpTip key={item.id} label={ALIGN_LABEL[item.id]}>
                  <Button
                    size="icon-sm"
                    variant={align === item.id ? "default" : "ghost"}
                    className="size-7"
                    aria-label={ALIGN_LABEL[item.id]}
                    aria-pressed={align === item.id}
                    onClick={() => setPreview({ align: item.id })}
                  >
                    <Icon />
                  </Button>
                </HelpTip>
              );
            })}
          </div>
          <HelpTip label="Sort library">
            <span className="inline-flex">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="ghost" className="h-7 px-2" aria-label={`Sort ${SORT_LABEL[sort]}`}>
                    <ArrowDownAZ />
                    <span className="hidden sm:inline">{SORT_LABEL[sort]}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Sort</DropdownMenuLabel>
                  {SORTS.map((id) => (
                    <DropdownMenuItem key={id} onSelect={() => setPreview({ sort: id })}>
                      <span className="flex-1">{SORT_LABEL[id]}</span>
                      {sort === id && <Check className="size-3.5" />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          </HelpTip>
          <HelpTip label="Grid view">
            <Button
              size="icon-sm"
              variant={preview.view === "grid" ? "secondary" : "ghost"}
              className="size-7"
              aria-label="Grid view"
              onClick={() => setPreview({ view: "grid" })}
            >
              <LayoutGrid />
            </Button>
          </HelpTip>
          <HelpTip label="List view">
            <Button
              size="icon-sm"
              variant={preview.view === "list" ? "secondary" : "ghost"}
              className="size-7"
              aria-label="List view"
              onClick={() => setPreview({ view: "list" })}
            >
              <List />
            </Button>
          </HelpTip>
        </div>
      </div>
      <div className="flex gap-1 overflow-x-auto">
        {SAMPLE_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => setPreview({ sampleText: preset })}
            className={cn(
              "shrink-0 rounded-full px-2 py-0.5 text-[11px] transition-colors duration-150",
              preview.sampleText === preset
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {preset.length > 28 ? `${preset.slice(0, 22)}…` : preset}
          </button>
        ))}
      </div>
    </div>
  );
}
