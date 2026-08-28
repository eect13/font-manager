import { LICENSE_HINT, LICENSE_LABEL, type FontLicense } from "@/lib/fonts/types";
import { cn } from "@/lib/utils";

const TONE: Record<FontLicense, string> = {
  free: "bg-success/15 text-success",
  freeware: "bg-accent text-foreground",
  personal: "bg-secondary text-foreground",
  commercial: "bg-primary/15 text-primary",
  unknown: "border border-border text-muted-foreground",
};

export function LicenseBadge({
  license,
  licenseName,
  className,
}: {
  license: FontLicense;
  licenseName?: string;
  className?: string;
}) {
  return (
    <span
      title={licenseName || LICENSE_HINT[license]}
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        TONE[license],
        className,
      )}
    >
      {LICENSE_LABEL[license]}
    </span>
  );
}
