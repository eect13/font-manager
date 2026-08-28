import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function ScrollArea({
  className,
  children,
  type = "hover",
  viewportClassName,
  ...props
}: ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  viewportClassName?: string;
}) {
  return (
    <ScrollAreaPrimitive.Root
      type={type}
      className={cn("relative overflow-hidden", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        className={cn("h-full w-full rounded-[inherit]", viewportClassName)}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar
        orientation="vertical"
        className="absolute right-1 top-1 bottom-1 z-10 flex w-2 touch-none select-none p-px data-[state=hidden]:pointer-events-none data-[state=hidden]:opacity-0"
      >
        <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-foreground/18 hover:bg-foreground/36" />
      </ScrollAreaPrimitive.Scrollbar>
    </ScrollAreaPrimitive.Root>
  );
}
