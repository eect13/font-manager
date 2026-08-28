import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function HelpTip({
  label,
  children,
  side = "bottom",
  wide = false,
}: {
  label: string;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  wide?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} className={cn(wide && "max-w-64 px-2.5 py-1.5 leading-relaxed")}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}