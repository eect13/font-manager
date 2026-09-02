import {
  BadgeCheck,
  Briefcase,
  CircleHelp,
  Gift,
  Globe,
  Heart,
  Italic,
  Library,
  Power,
  RefreshCw,
  SlidersHorizontal,
  Tag,
  Type,
  Upload,
  User,
  Monitor,
  FolderOpen,
} from "lucide-react";
import { useDeferredValue, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { LibraryGroups } from "./folder-tree";
import { GoogleActivateMenuItem, GfontsActivateMenuItem, LibraryActivateMenuItem, ActivatedDeactivateMenuItem } from "./activate-toggle";
import { SidebarRow } from "./sidebar-row";
import { HelpTip } from "./help-tip";
import { ALL_TAGS, isFontsourceOnly, isGoogleCatalog } from "@/lib/fonts/catalog";
import { getCatalogSyncState, subscribeCatalogSync, syncFontCatalog } from "@/lib/fonts/google-api";
import { fontLicense } from "@/lib/fonts/license";
import { UNTRUSTED_FONT_SOURCES } from "@/lib/fonts/style-tags";
import { allFonts, filterLibrary, tagsFor, useFontStore } from "@/lib/fonts/store";
import { openSystemFontsFolder } from "@/lib/fonts/system-fonts";
import type { FontLicense, FontRecord, LibraryFacet, LibraryScope } from "@/lib/fonts/types";
import { CATEGORY_LABEL, CATEGORY_ORDER, LICENSE_LABEL, TAG_ORDER } from "@/lib/fonts/types";
import { cn } from "@/lib/utils";

const LICENSE_NAV: { id: FontLicense; icon: typeof Library }[] = [
  { id: "free", icon: BadgeCheck },
  { id: "freeware", icon: Gift },
  { id: "personal", icon: User },
  { id: "commercial", icon: Briefcase },
  { id: "unknown", icon: CircleHelp },
];

const KNOWN_TAGS = new Set(ALL_TAGS);

function tallyFonts(list: FontRecord[], customTags: Record<string, string[]>) {
  const license = { free: 0, freeware: 0, personal: 0, commercial: 0, unknown: 0 };
  const category = { sans: 0, serif: 0, display: 0, handwriting: 0, mono: 0, other: 0, icons: 0 };
  const tags = new Map<string, number>();
  let variable = 0;
  let italic = 0;
  for (const font of list) {
    license[fontLicense(font)] += 1;
    category[font.category] += 1;
    if (font.variable) variable += 1;
    if (font.italic) italic += 1;
    for (const tag of tagsFor(font, customTags)) {
      if (KNOWN_TAGS.has(tag) && (TAG_ORDER as readonly string[]).includes(tag)) {
        tags.set(tag, (tags.get(tag) ?? 0) + 1);
      }
    }
  }
  return { license, category, tags, variable, italic };
}

function hasToken(query: string, token: string) {
  return query
    .toLowerCase()
    .split(/\s+/)
    .includes(token.toLowerCase());
}

function toggleToken(query: string, token: string) {
  const parts = query.trim().split(/\s+/).filter(Boolean);
  const key = token.toLowerCase();
  const next = parts.filter((p) => p.toLowerCase() !== key);
  if (next.length === parts.length) next.push(token);
  return next.join(" ");
}

const STYLE_TIP =
  "Seven style categories: Sans Serif, Serif, Display, Handwriting, Monospace, Other, Icons. Category names are not tags. Uploads use the file name first. Dummy PANOSE from free-font sites is ignored: " +
  (UNTRUSTED_FONT_SOURCES ?? []).join(", ") +
  ".";

const LICENSE_TIP =
  "Open (OFL, Apache, UFL, MIT, CC0, Unlicense), Freeware, Personal, Commercial, or Unknown. Read from the font’s license name/URL (OpenType name IDs 13–14), then the file path. Dafont-style packs are personal-use until you confirm. Not legal advice — override in the inspector.";

const TAGS_TIP =
  "One list: geometric, humanist, grotesque, neo-grotesque, editorial, condensed, slab, didone, rounded, coding, script, technical, accessible, noto, emoji, color, symbols, ligatures. Guessed from the family name and real OS/2 data when it looks filled in. Dummy PANOSE from free-font sites is ignored. Add your own in the inspector.";

function SidebarHint({
  label,
  icon,
  ariaLabel,
}: {
  label: string;
  icon: ReactNode;
  ariaLabel: string;
}) {
  return (
    <HelpTip label={label} side="right" wide>
      <button
        type="button"
        className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
        aria-label={ariaLabel}
      >
        {icon}
      </button>
    </HelpTip>
  );
}

function relativeSync(at: number) {
  const sec = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

function ProviderRefresh() {
  const { busy, syncedAt } = useSyncExternalStore(subscribeCatalogSync, getCatalogSyncState, getCatalogSyncState);
  const label = busy
    ? "Updating Fontsource and Google Fonts…"
    : syncedAt
      ? `Refresh the catalog list. Last updated ${relativeSync(syncedAt)}. Does not replace TTF files — Retry a family for that.`
      : "Refresh Fontsource and Google Fonts. The shipped list is already loaded. Does not replace TTF files on disk.";
  return (
    <HelpTip label={label} side="right" wide>
      <button
        type="button"
        className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40"
        aria-label="Refresh catalogs"
        disabled={busy}
        onClick={() => void syncFontCatalog({ force: true, notify: true })}
      >
        <RefreshCw className={cn("size-3", busy && "animate-spin motion-reduce:animate-none")} />
      </button>
    </HelpTip>
  );
}

export function Sidebar({
  onNewCollection,
  className,
}: {
  onNewCollection: () => void;
  className?: string;
}) {
  const scope = useFontStore((s) => s.scope);
  const setScope = useFontStore((s) => s.setScope);
  const facet = useFontStore((s) => s.facet);
  const setFacet = useFontStore((s) => s.setFacet);
  const favoriteCount = useFontStore((s) => s.favorites.length);
  const activated = useFontStore((s) => s.activated);
  const pendingActivate = useFontStore((s) => s.pendingActivate);
  const favorites = useFontStore((s) => s.favorites);
  const collections = useFontStore((s) => s.collections);
  const customTags = useFontStore((s) => s.customTags);
  const query = useFontStore((s) => s.query);
  const deferredQuery = useDeferredValue(query);
  const setQuery = useFontStore((s) => s.setQuery);
  const localFonts = useFontStore((s) => s.localFonts);
  const googleFonts = useFontStore((s) => s.googleFonts);
  const systemFonts = useFontStore((s) => s.systemFonts);
  const systemCount = systemFonts.length;
  const counts = useMemo(() => {
    const pool = scope === "system" ? systemFonts : allFonts(localFonts, googleFonts);
    const liveIds = pendingActivate.length ? [...activated, ...pendingActivate] : activated;
    const scoped = filterLibrary(pool, scope, deferredQuery, favorites, liveIds, collections, customTags, "");
    const viewed = facet
      ? filterLibrary(pool, scope, deferredQuery, favorites, liveIds, collections, customTags, facet)
      : scoped;
    const licenseList = facet.startsWith("license:") ? scoped : viewed;
    const categoryList = facet.startsWith("category:") ? scoped : viewed;
    const tagList = facet.startsWith("tag:") ? scoped : viewed;
    const licenses = tallyFonts(licenseList, customTags);
    const styles = tallyFonts(categoryList, customTags);
    const tagged = tallyFonts(tagList, customTags);
    const current = tallyFonts(viewed, customTags);
    const on = new Set(liveIds);
    let fontsource = 0;
    let gfonts = 0;
    for (const font of googleFonts) {
      if (isFontsourceOnly(font)) fontsource += 1;
      else if (isGoogleCatalog(font)) gfonts += 1;
    }
    return {
      license: licenses.license,
      category: styles.category,
      tags: tagged.tags,
      variable: current.variable,
      italic: current.italic,
      activated: allFonts(localFonts, googleFonts).filter((font) => on.has(font.id)).length,
      fontsource,
      gfonts,
    };
  }, [localFonts, googleFonts, systemFonts, scope, deferredQuery, facet, favorites, activated, pendingActivate, collections, customTags]);

  function go(next: LibraryScope) {
    setScope(next);
  }

  function goFacet(next: LibraryFacet) {
    setFacet(next);
  }

  return (
    <aside className={cn("flex h-full min-w-0 flex-col overflow-hidden bg-card", className)}>
      <div className="sidebar-nav min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain py-3 pl-2 pr-2">
        <div className="min-w-0 space-y-4">
          <section>
            <p className="mb-0.5 px-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Library
            </p>
            <SidebarRow
              active={scope === "all"}
              onClick={() => go("all")}
              icon={<Library className="size-4 shrink-0" />}
              label="All typefaces"
              count={googleFonts.length + localFonts.length}
              mainProps={{ "aria-label": "All typefaces" }}
              menu={<LibraryActivateMenuItem />}
            />
            <SidebarRow
              active={scope === "activated"}
              onClick={() => go("activated")}
              icon={<Power className="size-4 shrink-0" />}
              label="Activated"
              count={counts.activated}
              mainProps={{ "aria-label": "Activated" }}
              menu={<ActivatedDeactivateMenuItem />}
            />
            <SidebarRow
              active={scope === "favorites"}
              onClick={() => go("favorites")}
              icon={<Heart className="size-4 shrink-0" />}
              label="Favorites"
              count={favoriteCount}
              mainProps={{ "aria-label": "Favorites" }}
            />
            {counts.variable > 0 ? (
              <SidebarRow
                active={hasToken(query, "variable")}
                onClick={() => setQuery(toggleToken(query, "variable"))}
                icon={<SlidersHorizontal className="size-4 shrink-0" />}
                label="Variable"
                count={counts.variable}
                mainProps={{ "aria-label": "Variable" }}
              />
            ) : null}
            {counts.italic > 0 ? (
              <SidebarRow
                active={hasToken(query, "italic")}
                onClick={() => setQuery(toggleToken(query, "italic"))}
                icon={<Italic className="size-4 shrink-0" />}
                label="Italic"
                count={counts.italic}
                mainProps={{ "aria-label": "Italic" }}
              />
            ) : null}
            <SidebarRow
              active={scope === "system"}
              onClick={() => go("system")}
              icon={<Monitor className="size-4 shrink-0" />}
              label="System"
              count={systemCount}
              menu={
                <DropdownMenuItem
                  onSelect={() => {
                    void openSystemFontsFolder();
                  }}
                >
                  <FolderOpen className="size-3.5" />
                  Open Fonts folder
                </DropdownMenuItem>
              }
              mainProps={{
                "aria-label": "System",
                title: "Fonts already installed on this computer. View only. ··· opens C:\\Windows\\Fonts.",
              }}
            />
          </section>

          <section>
            <p className="mb-0.5 flex items-center gap-1 px-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Provider
              <ProviderRefresh />
            </p>
            <SidebarRow
              active={scope === "google"}
              onClick={() => go("google")}
              icon={<Type className="size-4 shrink-0" />}
              label="Fontsource"
              count={counts.fontsource}
              mainProps={{ "aria-label": "Fontsource" }}
              menu={<GoogleActivateMenuItem />}
            />
            <SidebarRow
              active={scope === "gfonts"}
              onClick={() => go("gfonts")}
              icon={<Globe className="size-4 shrink-0" />}
              label="Google Fonts"
              count={counts.gfonts}
              mainProps={{ "aria-label": "Google Fonts" }}
              menu={<GfontsActivateMenuItem />}
            />
            <SidebarRow
              active={scope === "uploaded"}
              onClick={() => go("uploaded")}
              icon={<Upload className="size-4 shrink-0" />}
              label="Local Files"
              count={localFonts.length}
              mainProps={{ "aria-label": "Local Files" }}
            />
          </section>

          <LibraryGroups onNewCollection={onNewCollection} />

          {LICENSE_NAV.some((item) => counts.license[item.id] > 0) ? (
          <section>
            <p className="mb-0.5 flex items-center gap-1 px-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              License
              <SidebarHint label={LICENSE_TIP} ariaLabel="About inferred licenses" icon={<CircleHelp className="size-3" />} />
            </p>
            {LICENSE_NAV.filter((item) => counts.license[item.id] > 0).map((item) => (
              <SidebarRow
                key={item.id}
                active={facet === `license:${item.id}`}
                onClick={() => goFacet(`license:${item.id}`)}
                icon={<item.icon className="size-4 shrink-0" />}
                label={LICENSE_LABEL[item.id]}
                count={counts.license[item.id]}
                mainProps={{ "aria-label": LICENSE_LABEL[item.id] }}
              />
            ))}
          </section>
          ) : null}

          {CATEGORY_ORDER.some((category) => counts.category[category] > 0) ? (
          <section>
            <p className="mb-0.5 flex items-center gap-1 px-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Style
              <SidebarHint label={STYLE_TIP} ariaLabel="About style classification" icon={<CircleHelp className="size-3" />} />
            </p>
            {CATEGORY_ORDER.filter((category) => counts.category[category] > 0).map((category) => (
              <SidebarRow
                key={category}
                active={facet === `category:${category}`}
                onClick={() => goFacet(`category:${category}`)}
                icon={<Type className="size-4 shrink-0" />}
                label={CATEGORY_LABEL[category]}
                count={counts.category[category]}
                mainProps={{ "aria-label": CATEGORY_LABEL[category] }}
              />
            ))}
          </section>
          ) : null}

          {counts.tags.size > 0 ? (
          <section>
            <p className="mb-0.5 flex items-center gap-1 px-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Tags
              <SidebarHint label={TAGS_TIP} ariaLabel="About inferred tags" icon={<CircleHelp className="size-3" />} />
            </p>
            <div className="flex flex-wrap gap-1 px-1.5 pb-8">
              {TAG_ORDER.filter((tag) => (counts.tags.get(tag) ?? 0) > 0).map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => goFacet(`tag:${tag}`)}
                  className={cn(
                    "inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-xs transition-colors duration-150",
                    facet === `tag:${tag}`
                      ? "bg-primary text-primary-foreground"
                      : "bg-secondary text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Tag className="size-2.5" />
                  {tag}
                  <span className="tabular-nums opacity-70">{counts.tags.get(tag)}</span>
                </button>
              ))}
            </div>
          </section>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
