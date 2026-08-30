import { useEffect, useMemo, useState } from "react";
import { FolderOpen, Heart, Power, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { formatBytes } from "@/lib/fonts/hash";
import { cssFamilyStack, loadFont, loadFontWeight, loadItalicFace } from "@/lib/fonts/loader";
import { synthesisForFont } from "@/lib/fonts/synthesis";
import { findFont, folderTree, collectionIsWatched, tagsFor, useFontStore } from "@/lib/fonts/store";
import { fontLicense } from "@/lib/fonts/license";
import { CATEGORY_LABEL, LICENSE_HINT, LICENSE_LABEL, LICENSE_OPTIONS } from "@/lib/fonts/types";
import { axesForFont, defaultWeightForFont, instancesForFont, realItalicAxes, resolvedAxisValues, variationStyle } from "@/lib/fonts/axes";
import { AxisSliders } from "./axis-sliders";
import { HelpTip } from "./help-tip";
import { LicenseBadge } from "./license-badge";
import { cn } from "@/lib/utils";
import { previewSample } from "@/lib/fonts/emoji";
import { scriptDir, scriptLang } from "@/lib/fonts/scripts";
import { colorKindLabel, colorKindOf, windowsColorNote } from "@/lib/fonts/color-font";
import { DEFAULT_ON, FEATURE_DEMO, featureStyle, labelForFeature, togglesFor } from "@/lib/fonts/ot-features";
import { openActivatedFolder, deleteFontFiles } from "@/lib/fonts/os-activate";
import { idbGet, previewCacheId } from "@/lib/fonts/idb";

const GLYPHS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789 &@$#%?!()[]{}";

export function FontInspector() {
  const open = useFontStore((s) => s.inspectorOpen);
  const selectedId = useFontStore((s) => s.selectedId);
  const localFonts = useFontStore((s) => s.localFonts);
  const googleFonts = useFontStore((s) => s.googleFonts);
  const setInspectorOpen = useFontStore((s) => s.setInspectorOpen);
  const collections = useFontStore((s) => s.collections);
  const toggleInCollection = useFontStore((s) => s.toggleInCollection);
  const setLicense = useFontStore((s) => s.setLicense);
  const toggleActivated = useFontStore((s) => s.toggleActivated);
  const toggleFavorite = useFontStore((s) => s.toggleFavorite);
  const addTag = useFontStore((s) => s.addTag);
  const removeTag = useFontStore((s) => s.removeTag);
  const removeLocalFont = useFontStore((s) => s.removeLocalFont);
  const customTags = useFontStore((s) => s.customTags);
  const isOn = useFontStore((s) => (selectedId ? s.activatedSet.has(selectedId) : false));
  const isFav = useFontStore((s) => (selectedId ? s.favorites.includes(selectedId) : false));
  const preview = useFontStore((s) => s.preview);
  const storedAxes = useFontStore((s) => (selectedId ? s.previewAxes[selectedId] : undefined));
  const setPreviewAxis = useFontStore((s) => s.setPreviewAxis);

  const font = selectedId ? findFont(selectedId, localFonts, googleFonts) : undefined;
  const [tagDraft, setTagDraft] = useState("");
  const [features, setFeatures] = useState<Record<string, boolean>>({});

  const [italicOn, setItalicOn] = useState(false);
  const [parsedTags, setParsedTags] = useState<string[] | undefined>();

  useEffect(() => {
    if (!font) return;
    void loadFont(font, "full");
    setItalicOn(Boolean(preview.italic) && (font.italic || Boolean(realItalicAxes(font).ital || realItalicAxes(font).slnt)));
    setFeatures({});
    setTagDraft("");
    setParsedTags(font.otFeatures);
    const id = font.id;
    void (async () => {
      try {
        const { nativeFamilyLayout } = await import("@/lib/fonts/native-parse");
        const layout = await nativeFamilyLayout(font.family);
        if (layout?.otFeatures?.length) {
          setParsedTags(layout.otFeatures);
          return;
        }
        let buf: ArrayBuffer | null = null;
        const blob = (await idbGet(id)) || (await idbGet(previewCacheId(id)));
        if (blob) buf = await blob.arrayBuffer();
        if (!buf) return;
        const { otFeaturesFromBuffer } = await import("@/lib/fonts/parse-font");
        const tags = await otFeaturesFromBuffer(buf);
        if (tags.length) setParsedTags(tags);
      } catch {
        /* CSS toggles still apply */
      }
    })();
  }, [font?.id]);

  useEffect(() => {
    if (!font || !italicOn) return;
    void loadItalicFace(font);
  }, [font?.id, italicOn]);

  const layoutTags = parsedTags ?? font?.otFeatures;
  const featureCss = useMemo(
    () => featureStyle(features, togglesFor(layoutTags)),
    [features, layoutTags],
  );

  if (!open) return null;

  if (!font) {
    return (
      <aside className="flex h-full w-[min(100%,24rem)] shrink-0 flex-col border-l border-border bg-card">
        <div className="flex justify-end p-3">
          <Button size="icon-sm" variant="ghost" aria-label="Close inspector" onClick={() => setInspectorOpen(false)}>
            <X />
          </Button>
        </div>
      </aside>
    );
  }

  const stack = cssFamilyStack(font);
  const axes = axesForFont(font);
  const liveAxes = resolvedAxisValues(axes, storedAxes ?? {}, instancesForFont(font));
  const weight = liveAxes.wght ?? defaultWeightForFont(font);
  const { ital: italAxis, slnt: slntAxis } = realItalicAxes(font);
  const hasItalAxis = Boolean(italAxis || slntAxis);
  const axisStyle = variationStyle(
    {
      ...liveAxes,
      ...(axes.some((a) => a.tag === "wght") ? {} : { wght: weight }),
      ...(italicOn && italAxis ? { ital: 1 } : {}),
      ...(italicOn && !italAxis && slntAxis ? { slnt: slntAxis.min < 0 ? slntAxis.min : slntAxis.max } : {}),
    },
    axes,
  );
  const tags = tagsFor(font, customTags);

  return (
    <aside className="flex h-full min-h-0 w-[min(100%,24rem)] shrink-0 flex-col overflow-hidden border-l border-border bg-card">
      <div className="flex items-start justify-between gap-3 p-5 pb-3">
        <div className="min-w-0">
          <h2 className="font-heading text-2xl leading-tight text-foreground break-words" style={{ fontFamily: stack }}>
            {font.family}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {font.source === "google" ? "Fontsource" : font.source === "system" ? "Windows" : "Uploaded"}
            {font.variable ? " · Variable" : ""}
            {scriptLang(font.family) ? ` · ${scriptLang(font.family)}` : ""}
            {` · ${LICENSE_LABEL[fontLicense(font)]}`}
          </p>
        </div>
        <Button size="icon-sm" variant="ghost" className="shrink-0" aria-label="Close inspector" onClick={() => setInspectorOpen(false)}>
          <X />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-6 px-5 pb-10">
            <p
              className={cn(
                "fm-spec overflow-hidden rounded-lg bg-paper px-4 py-5 text-ink",
                italicOn && (hasItalAxis || font.italic) ? "fm-spec-italic" : "fm-spec-roman",
                font.variable ? "fm-spec-variable" : "fm-spec-static",
                preview.align === "center" && "text-center",
                preview.align === "right" && "text-right",
              )}
              dir={scriptDir(font.family)}
              lang={scriptLang(font.family)}
              style={{
                fontFamily: stack,
                fontSize: "clamp(1.35rem, 3.6vw, 2.5rem)",
                lineHeight: 1.2,
                ...featureCss,
                fontWeight: font.variable ? (axisStyle.fontWeight ?? weight) : weight,
                fontStyle:
                  italicOn && (hasItalAxis || font.italic)
                    ? axisStyle.fontStyle && axisStyle.fontStyle !== "normal"
                      ? axisStyle.fontStyle
                      : "italic"
                    : "normal",
                fontStretch: font.variable ? axisStyle.fontStretch : undefined,
                fontVariationSettings: font.variable ? axisStyle.fontVariationSettings : undefined,
                fontSynthesis: synthesisForFont(font, {
                  italicOn,
                  weight: font.variable ? (axisStyle.fontWeight ?? weight) : weight,
                  smcp: Boolean(features.smcp),
                }),
                ...(colorKindOf(font) !== "none" ? { fontPalette: "normal", fontVariantEmoji: "emoji" as const } : {}),
              }}
            >
              {previewSample(font, preview.sampleText)}
            </p>

            <div className="flex flex-wrap gap-2">
              {font.source === "system" ? (
                <p className="text-sm text-muted-foreground">
                  Windows font — already available to Word and other apps. Read-only here (no Activate or Delete).
                </p>
              ) : (
                <>
              <HelpTip
                label={
                  isOn
                    ? "Deactivate: unload from Word/Figma. Files stay in Documents / Font Manager."
                    : "Activate: register so other apps can use it while Font Manager is open. Files are kept on disk."
                }
              >
                <Button
                  size="sm"
                  variant={isOn ? "default" : "outline"}
                  onClick={() => toggleActivated(font.id)}
                >
                  <Power />
                  {isOn ? "Deactivate" : "Activate"}
                </Button>
              </HelpTip>
              <HelpTip label="Open Documents / Font Manager (one folder per family)">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void openActivatedFolder()}
                >
                  <FolderOpen />
                  Folder
                </Button>
              </HelpTip>
              <HelpTip label={isFav ? "Remove from favorites" : "Keep this face in Favorites"}>
                <Button
                  size="sm"
                  variant={isFav ? "secondary" : "ghost"}
                  onClick={() => toggleFavorite(font.id)}
                >
                  <Heart className={isFav ? "fill-current" : undefined} />
                  Favorite
                </Button>
              </HelpTip>
              {font.source === "local" && (
                <HelpTip label="Delete: remove the file from this library and from Documents. Deactivate only unloads it from other apps.">
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => {
                      void removeLocalFont(font.id);
                      setInspectorOpen(false);
                    }}
                  >
                    <Trash2 />
                    Delete
                  </Button>
                </HelpTip>
              )}
              {font.source === "google" && (
                <HelpTip label="Delete downloaded files from Documents. The family stays in Fontsource. Deactivate only unloads them from other apps.">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      void deleteFontFiles(font).then(() => {
                        if (isOn) toggleActivated(font.id);
                      });
                    }}
                  >
                    <Trash2 />
                    Delete files
                  </Button>
                </HelpTip>
              )}
                </>
              )}
            </div>

            {axes.length ? (
              <section className="space-y-2">
                <Label>Variable axes</Label>
                {font.varStorage ? (
                  <p className="text-xs text-muted-foreground">{font.varStorage}</p>
                ) : null}
                <AxisSliders
                  axes={axes}
                  values={liveAxes}
                  instances={instancesForFont(font)}
                  onChange={(tag, value) => {
                    setPreviewAxis(font.id, tag, value);
                    if (tag === "wght") {
                      void loadFontWeight(font, Math.round(value), italicOn);
                    }
                    if (tag === "ital") setItalicOn(value >= 0.5);
                  }}
                />
              </section>
            ) : (
            <section className="space-y-2">
              <Label>Weight</Label>
              <div className="flex flex-wrap gap-1">
                {font.weights.map((w) => (
                  <button
                    key={w}
                    type="button"
                    onClick={() => {
                      setPreviewAxis(font.id, "wght", w);
                      void loadFontWeight(font, w, italicOn);
                    }}
                    className={cn(
                      "h-8 min-w-10 rounded-md px-2 font-mono text-xs tabular-nums",
                      weight === w ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground",
                    )}
                  >
                    {w}
                  </button>
                ))}
              </div>
            </section>
            )}
            {font.italic || hasItalAxis ? (
              <label className="flex h-10 items-center justify-between rounded-md bg-secondary px-3 text-sm">
                Italic
                <Switch
                  checked={italicOn}
                  onCheckedChange={(on) => {
                    setItalicOn(on);
                    if (on) void loadItalicFace(font);
                  }}
                />
              </label>
            ) : null}

            <section className="space-y-2">
              <Label>OpenType features</Label>
              <p className="text-xs text-muted-foreground">
                {layoutTags?.length
                  ? `${layoutTags.length} GSUB/GPOS tags in this file. liga/calt/kern on by default. Toggle and watch the line below.`
                  : "Reading GSUB… common tags until the file is parsed. Off means explicitly disable."}
              </p>
              <p
                className="fm-spec rounded-lg bg-paper px-3 py-2 text-xl text-ink"
                style={{ fontFamily: stack, fontWeight: weight, ...featureCss }}
              >
                {FEATURE_DEMO}
              </p>
              <div className="grid grid-cols-2 gap-2">
                {togglesFor(layoutTags).map((tag) => (
                  <label
                    key={tag}
                    className="flex h-10 items-center justify-between rounded-md bg-secondary px-3 text-sm"
                  >
                    <span className="truncate" title={tag}>
                      {labelForFeature(tag)}
                    </span>
                    <Switch
                      checked={features[tag] ?? DEFAULT_ON.has(tag)}
                      onCheckedChange={(checked) =>
                        setFeatures((prev) => ({ ...prev, [tag]: checked }))
                      }
                    />
                  </label>
                ))}
              </div>
            </section>

            <section className="space-y-2">
              <Label>Glyphs</Label>
              <p
                className="fm-spec rounded-lg bg-secondary p-3 text-lg leading-relaxed"
                dir={scriptDir(font.family)}
                lang={scriptLang(font.family)}
                style={{
                  fontFamily: stack,
                  fontWeight: weight,
                  ...featureCss,
                }}
              >
                {previewSample(font, GLYPHS)}
              </p>
            </section>

            {colorKindOf(font) !== "none" ? (
              <section className="space-y-2">
                <Label>Color tables</Label>
                <p className="text-sm">{colorKindLabel(colorKindOf(font))}</p>
                <p className="text-xs text-muted-foreground">{windowsColorNote(colorKindOf(font))}</p>
              </section>
            ) : null}

            <Separator />

            <section className="space-y-2">
              <Label>License</Label>
              <div className="flex items-start gap-2">
                <LicenseBadge license={fontLicense(font)} licenseName={font.licenseName} />
                <p className="min-w-0 break-words text-sm leading-snug text-muted-foreground">
                  {font.licenseName || LICENSE_HINT[fontLicense(font)]}
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                Inferred from the file — not legal advice. Confirm the author’s license before shipping work.
              </p>
              {font.source === "local" && (
                <div className="grid grid-cols-1 gap-1.5" role="radiogroup" aria-label="Font license">
                  {LICENSE_OPTIONS.map((id) => (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={fontLicense(font) === id}
                      onClick={() => setLicense(font.id, id)}
                      className={cn(
                        "rounded-md border px-3 py-2 text-left transition-colors duration-150",
                        fontLicense(font) === id
                          ? "border-ring bg-accent text-foreground"
                          : "border-border bg-secondary text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <span className="block text-sm font-medium">{LICENSE_LABEL[id]}</span>
                      <span className="block text-xs opacity-80">{LICENSE_HINT[id]}</span>
                    </button>
                  ))}
                </div>
              )}
            </section>

            <section className="space-y-2">
              <Label>Collections</Label>
              <p className="text-xs text-muted-foreground">Virtual groups. Files are not moved.</p>
              <div className="space-y-1">
                {folderTree(collections).filter((row) => !collectionIsWatched(collections, row.folder.id)).length === 0 && (
                  <p className="text-sm text-muted-foreground">Create one from Collections in the sidebar.</p>
                )}
                {folderTree(collections)
                  .filter((row) => !collectionIsWatched(collections, row.folder.id))
                  .map(({ folder, depth }) => (
                    <label
                      key={folder.id}
                      className="flex h-10 items-center justify-between rounded-md px-2 text-sm hover:bg-accent"
                      style={{ paddingLeft: 8 + depth * 12 }}
                    >
                      {folder.name}
                      <Switch
                        checked={folder.fontIds.includes(font.id)}
                        onCheckedChange={() => toggleInCollection(folder.id, font.id)}
                      />
                    </label>
                  ))}
              </div>
            </section>

            <section className="space-y-2">
              <Label>Folders</Label>
              <p className="text-xs text-muted-foreground">Watched disk folders. Files stay put.</p>
              <div className="space-y-1">
                {folderTree(collections).filter((row) => collectionIsWatched(collections, row.folder.id)).length === 0 && (
                  <p className="text-sm text-muted-foreground">Watch a folder from Folders in the sidebar.</p>
                )}
                {folderTree(collections)
                  .filter((row) => collectionIsWatched(collections, row.folder.id))
                  .map(({ folder, depth }) => (
                    <label
                      key={folder.id}
                      className="flex h-10 items-center justify-between rounded-md px-2 text-sm hover:bg-accent"
                      style={{ paddingLeft: 8 + depth * 12 }}
                    >
                      {folder.name}
                      <Switch
                        checked={folder.fontIds.includes(font.id)}
                        onCheckedChange={() => toggleInCollection(folder.id, font.id)}
                      />
                    </label>
                  ))}
              </div>
            </section>

            <section className="space-y-2">
              <Label>Tags</Label>
              <div className="flex flex-wrap gap-1">
                {tags.map((tag) => (
                  <Badge key={tag} variant="outline" className="gap-1">
                    {tag}
                    {(customTags[font.id] ?? []).includes(tag) && (
                      <button
                        type="button"
                        aria-label={`Remove ${tag}`}
                        onClick={() => removeTag(font.id, tag)}
                      >
                        <X className="size-3" />
                      </button>
                    )}
                  </Badge>
                ))}
              </div>
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  addTag(font.id, tagDraft);
                  setTagDraft("");
                }}
              >
                <Input
                  value={tagDraft}
                  onChange={(e) => setTagDraft(e.target.value)}
                  placeholder="Add a tag"
                  className="h-9"
                />
                <Button type="submit" size="sm" variant="secondary" disabled={!tagDraft.trim()}>
                  Add
                </Button>
              </form>
            </section>

            <section className="space-y-1 text-xs text-muted-foreground">
              {font.fileName && <p>File · {font.fileName}</p>}
              {font.fileSize ? <p>Size · {formatBytes(font.fileSize)}</p> : null}
              {font.glyphCount ? <p>Glyphs · {font.glyphCount}</p> : null}
              {font.version && <p>Version · {font.version}</p>}
              {font.checksum && (
                <p className="truncate font-mono">SHA · {font.checksum.slice(0, 16)}</p>
              )}
            </section>
          </div>
        </ScrollArea>
    </aside>
  );
}
