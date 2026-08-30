import {
  BadgeCheck,
  Briefcase,
  CircleHelp,
  Gift,
  Heart,
  Library,
  Power,
  Tag,
  Type,
  Upload,
  User,
  HardDrive,
} from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { LibraryGroups } from "./folder-tree";
import { GoogleActivateMenuItem, LibraryActivateMenuItem, ActivatedDeactivateMenuItem } from "./activate-toggle";
import { SidebarRow } from "./sidebar-row";
import { HelpTip } from "./help-tip";
import { ALL_TAGS } from "@/lib/fonts/catalog";
import { fontLicense } from "@/lib/fonts/license";
import { UNTRUSTED_FONT_SOURCES } from "@/lib/fonts/style-tags";
import { allFonts, tagsFor, useFontStore } from "@/lib/fonts/store";
import type { FontCategory, FontLicense, LibraryScope } from "@/lib/fonts/types";
import { CATEGORY_LABEL, LICENSE_LABEL } from "@/lib/fonts/types";
import { cn } from "@/lib/utils";

const CATEGORIES: FontCategory[] = ["sans", "serif", "display", "handwriting", "mono"];

const LICENSE_NAV: { id: FontLicense; icon: typeof Library }[] = [
  { id: "free", icon: BadgeCheck },
  { id: "freeware", icon: Gift },
  { id: "personal", icon: User },
  { id: "commercial", icon: Briefcase },
  { id: "unknown", icon: CircleHelp },
];

const SIDEBAR_TAGS = [
  "geometric",
  "humanist",
  "grotesque",
  "neo-grotesque",
  "editorial",
  "condensed",
  "slab",
  "didone",
  "rounded",
  "coding",
  "script",
  "technical",
  "accessible",
  "noto",
  "emoji",
  "color",
  "ligatures",
];

const KNOWN_TAGS = new Set(ALL_TAGS);

const STYLE_TIP =
  "Google Fonts use Google’s official class (Sans, Serif, Display, Script, Mono). Uploads use the file name first. These hosts often ship dummy PANOSE, so we ignore it: " +
  (UNTRUSTED_FONT_SOURCES ?? []).join(", ") +
  ".";

const LICENSE_TIP =
  "Read from the font’s license name/URL (OpenType name IDs 13–14), then the file path. Dafont-style packs are treated as personal-use until you confirm. Not legal advice — override in the inspector.";

const TAGS_TIP =
  "Guessed from the family name, Google stroke/classifications, and real OS/2 data when it looks filled in. Dummy PANOSE from free-font sites is ignored. Add your own tags in the inspector.";

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

export function Sidebar({
  onNewCollection,
  className,
}: {
  onNewCollection: () => void;
  className?: string;
}) {
  const scope = useFontStore((s) => s.scope);
  const setScope = useFontStore((s) => s.setScope);
  const favoriteCount = useFontStore((s) => s.favorites.length);
  const activated = useFontStore((s) => s.activated);
  const customTags = useFontStore((s) => s.customTags);
  const localFonts = useFontStore((s) => s.localFonts);
  const googleFonts = useFontStore((s) => s.googleFonts);
  const diskCount = useFontStore((s) => s.diskFamilies.length);
  const counts = useMemo(() => {
    const list = allFonts(localFonts, googleFonts);
    const license = { free: 0, freeware: 0, personal: 0, commercial: 0, unknown: 0 };
    const category = { sans: 0, serif: 0, display: 0, handwriting: 0, mono: 0 };
    const tags = new Map<string, number>();
    for (const font of list) {
      license[fontLicense(font)] += 1;
      category[font.category] += 1;
      for (const tag of tagsFor(font, customTags)) {
        if (KNOWN_TAGS.has(tag) && SIDEBAR_TAGS.includes(tag)) {
          tags.set(tag, (tags.get(tag) ?? 0) + 1);
        }
      }
    }
    const on = new Set(activated);
    return { license, category, tags, activated: list.filter((font) => on.has(font.id)).length };
  }, [localFonts, googleFonts, activated, customTags]);

  function go(next: LibraryScope) {
    setScope(next);
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
            <SidebarRow
              active={scope === "uploaded"}
              onClick={() => go("uploaded")}
              icon={<Upload className="size-4 shrink-0" />}
              label="Uploaded"
              count={localFonts.length}
              mainProps={{ "aria-label": "Uploaded" }}
            />
            <SidebarRow
              active={scope === "disk"}
              onClick={() => go("disk")}
              icon={<HardDrive className="size-4 shrink-0" />}
              label="On disk"
              count={diskCount}
              mainProps={{
                "aria-label": "On disk",
                title: "Google families already downloaded into Documents / Font Manager. Not Windows system fonts (Arial, Calibri).",
              }}
            />
          </section>

          <section>
            <p className="mb-0.5 px-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Provider
            </p>
            <SidebarRow
              active={scope === "google"}
              onClick={() => go("google")}
              icon={<Type className="size-4 shrink-0" />}
              label="Google Fonts"
              count={googleFonts.length}
              mainProps={{ "aria-label": "Google Fonts" }}
              menu={<GoogleActivateMenuItem />}
            />
          </section>

          <LibraryGroups onNewCollection={onNewCollection} />

          <section>
            <p className="mb-0.5 flex items-center gap-1 px-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              License
              <SidebarHint label={LICENSE_TIP} ariaLabel="About inferred licenses" icon={<CircleHelp className="size-3" />} />
            </p>
            {LICENSE_NAV.filter((item) => counts.license[item.id] > 0).map((item) => (
              <SidebarRow
                key={item.id}
                active={scope === `license:${item.id}`}
                onClick={() => go(`license:${item.id}`)}
                icon={<item.icon className="size-4 shrink-0" />}
                label={LICENSE_LABEL[item.id]}
                count={counts.license[item.id]}
                mainProps={{ "aria-label": LICENSE_LABEL[item.id] }}
              />
            ))}
          </section>

          <section>
            <p className="mb-0.5 flex items-center gap-1 px-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Style
              <SidebarHint label={STYLE_TIP} ariaLabel="About style classification" icon={<CircleHelp className="size-3" />} />
            </p>
            {CATEGORIES.filter((category) => counts.category[category] > 0).map((category) => (
              <SidebarRow
                key={category}
                active={scope === `category:${category}`}
                onClick={() => go(`category:${category}`)}
                icon={<Type className="size-4 shrink-0" />}
                label={CATEGORY_LABEL[category]}
                count={counts.category[category]}
                mainProps={{ "aria-label": CATEGORY_LABEL[category] }}
              />
            ))}
          </section>

          {counts.tags.size > 0 ? (
          <section>
            <p className="mb-0.5 flex items-center gap-1 px-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Tags
              <SidebarHint label={TAGS_TIP} ariaLabel="About inferred tags" icon={<CircleHelp className="size-3" />} />
            </p>
            <div className="flex flex-wrap gap-1 px-1.5 pb-8">
              {SIDEBAR_TAGS.filter((tag) => (counts.tags.get(tag) ?? 0) > 0).map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => go(`tag:${tag}`)}
                  className={cn(
                    "inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-xs transition-colors duration-150",
                    scope === `tag:${tag}`
                      ? "bg-primary text-primary-foreground"
                      : "bg-secondary text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Tag className="size-2.5" />
                  {tag}
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
