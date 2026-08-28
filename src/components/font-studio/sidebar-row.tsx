import { MoreHorizontal } from "lucide-react";
import { useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const MAIN =
  "flex h-8 min-w-0 w-full items-center gap-2 rounded-md py-0 pl-2.5 pr-2.5 text-left text-sm transition-colors duration-150";
const COUNT = "min-w-10 shrink-0 text-right tabular-nums text-xs text-muted-foreground";

export function sidebarMainClass(active: boolean) {
  return cn(
    MAIN,
    active
      ? "bg-accent text-foreground"
      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
  );
}

export function SidebarCount({
  value,
  hidden,
  fadeOnHover,
}: {
  value: number;
  hidden?: boolean;
  fadeOnHover?: boolean;
}) {
  return (
    <span
      className={cn(
        COUNT,
        fadeOnHover && "transition-opacity duration-150 group-hover:opacity-0",
        hidden && "opacity-0",
      )}
    >
      {value.toLocaleString()}
    </span>
  );
}

export function SidebarOverflowMenu({
  label,
  open,
  onOpenChange,
  children,
}: {
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${label} menu`}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute top-0 right-2.5 z-20 flex h-8 w-10 items-center justify-center rounded-md text-muted-foreground opacity-0 pointer-events-none transition-opacity duration-150 hover:text-foreground group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 data-[state=open]:pointer-events-auto data-[state=open]:opacity-100"
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onCloseAutoFocus={(e) => e.preventDefault()}>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function SidebarRow({
  active,
  onClick,
  icon,
  label,
  count,
  menu,
  mainProps,
}: {
  active: boolean;
  onClick?: () => void;
  icon: ReactNode;
  label: string;
  count?: number;
  menu?: ReactNode;
  mainProps?: ButtonHTMLAttributes<HTMLButtonElement>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div
      className="group relative flex w-full min-w-0 items-center"
      onContextMenu={
        menu
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              setMenuOpen(true);
            }
          : undefined
      }
    >
      <button
        type="button"
        {...mainProps}
        onClick={onClick}
        className={cn(sidebarMainClass(active), mainProps?.className)}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {typeof count === "number" && (
          <SidebarCount value={count} fadeOnHover={Boolean(menu)} hidden={menuOpen} />
        )}
      </button>
      {menu ? (
        <SidebarOverflowMenu label={label} open={menuOpen} onOpenChange={setMenuOpen}>
          {menu}
        </SidebarOverflowMenu>
      ) : null}
    </div>
  );
}
