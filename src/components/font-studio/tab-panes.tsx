import { useEffect, useState } from "react";
import { DuplicatesPage } from "@/routes/duplicates";
import { GlyphsPage } from "@/routes/glyphs";
import { LibraryPage } from "@/routes/index";
import { PlaygroundPage } from "@/routes/playground";
import { cn } from "@/lib/utils";

const PANES = [
  { path: "/", match: (p: string) => p === "/", Page: LibraryPage },
  { path: "/playground", match: (p: string) => p.startsWith("/playground"), Page: PlaygroundPage },
  { path: "/duplicates", match: (p: string) => p.startsWith("/duplicates"), Page: DuplicatesPage },
  { path: "/glyphs", match: (p: string) => p.startsWith("/glyphs"), Page: GlyphsPage },
] as const;

const VISITED_KEY = "fm-tab-visited";

function readVisited(current: string): string[] {
  const fallback = [current || "/"];
  if (typeof sessionStorage === "undefined") return fallback;
  try {
    const raw = sessionStorage.getItem(VISITED_KEY);
    if (!raw) return fallback;
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list) || !list.every((p) => typeof p === "string")) return fallback;
    return list.includes(current) ? list : [...list, current];
  } catch {
    return fallback;
  }
}

function writeVisited(list: string[]) {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(VISITED_KEY, JSON.stringify(list));
  } catch {
    /* private mode */
  }
}

function panePath(pathname: string) {
  const p = pathname.split("?")[0] || "/";
  if (!p || p === "/index.html") return "/";
  return PANES.some((pane) => pane.match(p)) ? p : "/";
}

export function TabPanes({ pathname }: { pathname: string }) {
  const current = panePath(pathname);
  const [visited, setVisited] = useState<string[]>(() => readVisited(current));

  useEffect(() => {
    setVisited((list) => {
      const next = list.includes(current) ? list : [...list, current];
      writeVisited(next);
      return next;
    });
  }, [current]);

  return (
    <div className="relative z-10 flex min-h-0 min-w-0 flex-1 flex-col">
      {PANES.filter((pane) => visited.some((path) => pane.match(path))).map((pane) => {
        const active = pane.match(current);
        return (
          <div
            key={pane.path}
            aria-hidden={!active}
            inert={!active ? true : undefined}
            className={cn(
              "min-h-0 min-w-0 flex flex-1 flex-col overflow-hidden",
              active
                ? "relative z-10"
                : "pointer-events-none invisible absolute inset-0 z-0 [&_*]:pointer-events-none",
            )}
          >
            <pane.Page />
          </div>
        );
      })}
    </div>
  );
}