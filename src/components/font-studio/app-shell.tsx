import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { Code2, Copy, FolderUp, Grid3x3, Library, Menu, Search, SplitSquareHorizontal, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CollectionDialog } from "./collection-dialog";
import { CssExportDialog } from "./css-export-dialog";
import { DownloadBar } from "./download-bar";
import { FontInspector } from "./font-inspector";
import { Sidebar } from "./sidebar";
import { TabPanes } from "./tab-panes";
import { ThemeToggle } from "./theme-toggle";
import { HelpTip } from "./help-tip";
import { runFontImport } from "./import-fonts";
import { pickFontFiles, pickFontFolder } from "@/lib/desktop/open-fonts";
import { useHydrateFonts } from "@/lib/fonts/hydrate";
import { useFontStore } from "@/lib/fonts/store";
import { cn } from "@/lib/utils";
import { APP_NAME, APP_VERSION } from "@/version";

const NAV = [
  { to: "/", label: "Library", icon: Library, match: (p: string) => p === "/", beta: false },
  {
    to: "/playground",
    label: "Playground",
    icon: SplitSquareHorizontal,
    match: (p: string) => p.startsWith("/playground"),
    beta: false,
  },
  {
    to: "/duplicates",
    label: "Duplicates",
    icon: Copy,
    match: (p: string) => p.startsWith("/duplicates"),
    beta: false,
  },
  {
    to: "/glyphs",
    label: "Glyphs",
    icon: Grid3x3,
    match: (p: string) => p.startsWith("/glyphs"),
    beta: false,
  },
] as const;

export function AppShell({ children: _children }: { children: ReactNode }) {
  useHydrateFonts();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const query = useFontStore((s) => s.query);
  const setQuery = useFontStore((s) => s.setQuery);
  const searchRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [collectionOpen, setCollectionOpen] = useState(false);
  const [cssOpen, setCssOpen] = useState(false);
  const [inputsReady, setInputsReady] = useState(false);
  const openNewCollection = useCallback(() => setCollectionOpen(true), []);
  const openNewCollectionMobile = useCallback(() => {
    setMobileNav(false);
    setCollectionOpen(true);
  }, []);

  useEffect(() => {
    setInputsReady(true);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "/" && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function addFiles() {
    try {
      const picked = await pickFontFiles();
      if (picked === "web") {
        fileRef.current?.click();
        return;
      }
      if (picked.length) void runFontImport(picked);
    } catch {
      fileRef.current?.click();
    }
  }

  async function addFolder() {
    try {
      const picked = await pickFontFolder();
      if (picked === "web") {
        folderRef.current?.click();
        return;
      }
      if (picked?.files.length) {
        void runFontImport(picked.files, { collectionName: picked.name });
      }
    } catch {
      folderRef.current?.click();
    }
  }

  return (
    <TooltipProvider delayDuration={220}>
      <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
        <header className="grid grid-cols-[auto_1fr_auto] items-center gap-2 border-b border-border px-2 py-1.5 md:grid-cols-[17rem_1fr_auto] md:pl-0 md:pr-3">
          <div className="flex items-center gap-1.5 pl-2 md:pl-3">
            <Button
              size="icon-sm"
              variant="ghost"
              className="md:hidden"
              aria-label="Open menu"
              onClick={() => setMobileNav(true)}
            >
              <Menu />
            </Button>
            <Link to="/" className="flex items-baseline gap-2 no-underline">
              <span className="font-heading text-xl leading-none tracking-tight text-foreground">
                {APP_NAME}
              </span>
              <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                {APP_VERSION}
              </span>
            </Link>
          </div>

          <HelpTip label="Search family, tag, or license:personal — press /">
            <div className="relative min-w-0">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name, tag, license:personal…"
                className="h-8 bg-card pl-8"
                aria-label="Search typefaces"
              />
            </div>
          </HelpTip>

          <div className="hidden min-w-0 items-center gap-0.5 sm:flex">
            <nav className="mr-1.5 hidden items-center gap-0.5 lg:flex">
              {NAV.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-sm no-underline transition-colors duration-150",
                    item.match(pathname)
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {item.label}
                  {item.beta ? (
                    <span className="rounded bg-secondary px-1 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                      Beta
                    </span>
                  ) : null}
                </Link>
              ))}
            </nav>
            <ThemeToggle />
            <HelpTip label="Export CSS for activated fonts">
              <Button size="sm" variant="secondary" className="h-8 px-2.5" onClick={() => setCssOpen(true)}>
                <Code2 />
                CSS
              </Button>
            </HelpTip>
            <HelpTip label="Upload font files">
              <Button
                size="sm"
                variant="secondary"
                className="h-8 px-2.5"
                onClick={() => void addFiles()}
              >
                <Upload />
                Files
              </Button>
            </HelpTip>
            <HelpTip label="Upload a whole folder of fonts">
              <Button size="sm" className="h-8 px-2.5" onClick={() => void addFolder()}>
                <FolderUp />
                Folder
              </Button>
            </HelpTip>
          </div>
          <div className="flex items-center gap-0.5 sm:hidden">
            <ThemeToggle />
            <HelpTip label="Export CSS">
              <Button size="icon-sm" variant="secondary" aria-label="Export CSS" onClick={() => setCssOpen(true)}>
                <Code2 />
              </Button>
            </HelpTip>
            <HelpTip label="Upload files">
              <Button
                size="icon-sm"
                variant="secondary"
                aria-label="Add font files"
                onClick={() => void addFiles()}
              >
                <Upload />
              </Button>
            </HelpTip>
            <HelpTip label="Upload a folder">
              <Button
                size="icon-sm"
                aria-label="Add font folder"
                onClick={() => void addFolder()}
              >
                <FolderUp />
              </Button>
            </HelpTip>
          </div>
        </header>
        <DownloadBar />

        <div className="flex min-h-0 flex-1">
          <Sidebar
            onNewCollection={openNewCollection}
            className="hidden w-sidebar shrink-0 border-r border-border md:flex"
          />
          <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <TabPanes pathname={pathname} />
          </main>
          <FontInspector />
        </div>

        <nav className="grid grid-cols-4 border-t border-border bg-card lg:hidden">
          {NAV.map((item) => {
            const Icon = item.icon;
            const active = item.match(pathname);
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "flex h-12 flex-col items-center justify-center gap-0.5 text-[11px] no-underline",
                  active ? "text-foreground" : "text-muted-foreground",
                )}
              >
                <Icon className="size-4" />
                <span className="inline-flex items-center gap-0.5">
                  {item.label}
                  {item.beta ? <span className="text-[8px] uppercase text-muted-foreground">β</span> : null}
                </span>
              </Link>
            );
          })}
        </nav>

        <Sheet open={mobileNav} onOpenChange={setMobileNav}>
          <SheetContent side="left" className="p-0">
            <div className="px-4 py-4 font-heading text-2xl">Library</div>
            <Sidebar
              onNewCollection={openNewCollectionMobile}
              className="h-[calc(100%-4rem)]"
            />
          </SheetContent>
        </Sheet>

        <CollectionDialog open={collectionOpen} onOpenChange={setCollectionOpen} />
        <CssExportDialog open={cssOpen} onOpenChange={setCssOpen} />

        {inputsReady && (
          <>
            <input
              ref={fileRef}
              data-testid="font-file-input"
              type="file"
              accept=".ttf,.otf,.woff,.woff2,.ttc,.otc"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) void runFontImport(e.target.files);
                e.target.value = "";
              }}
            />
            <input
              ref={(el) => {
                folderRef.current = el;
                if (!el) return;
                el.setAttribute("webkitdirectory", "");
                el.setAttribute("directory", "");
              }}
              data-testid="font-folder-input"
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) void runFontImport(e.target.files);
                e.target.value = "";
              }}
            />
          </>
        )}
      </div>
    </TooltipProvider>
  );
}
