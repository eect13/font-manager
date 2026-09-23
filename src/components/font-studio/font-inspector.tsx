import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { FolderOpen, Heart, Power, Trash2, X, Copy, Grid3x3 } from "lucide-react";
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
import { useLiveAxes } from "@/lib/fonts/live-axes";
import { fontLicense } from "@/lib/fonts/license";
import { contrastLabel, formatXh, metricsFor, toggleSearchToken, widthClassLabel } from "@/lib/fonts/metrics";
import { CATEGORY_LABEL, LICENSE_HINT, LICENSE_LABEL, LICENSE_OPTIONS } from "@/lib/fonts/types";
import { axesForFont, defaultWeightForFont, formatFvar, hasRealItalic, instancesForFont, isItalicOnlyFace, italicPreviewStyle, previewAxisValues, realItalicAxes, variationStyle } from "@/lib/fonts/axes";
import { AxisSliders } from "./axis-sliders";
import { HelpTip } from "./help-tip";
import { LicenseBadge } from "./license-badge";
import { cn } from "@/lib/utils";
import { previewSample } from "@/lib/fonts/emoji";
import { scriptDir, scriptLang } from "@/lib/fonts/scripts";
import { colorKindLabel, colorKindOf, windowsColorNote } from "@/lib/fonts/color-font";
import { DEFAULT_ON, FEATURE_DEMO, featureStyle, labelForFeature, togglesFor } from "@/lib/fonts/ot-features";
import { openActivatedFolder, deleteFontFiles } from "@/lib/fonts/os-activate";
import { openSystemFontsFolder } from "@/lib/fonts/system-fonts";
import { copyText } from "@/lib/copy-text";
import { idbGet, previewCacheId } from "@/lib/fonts/idb";

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
  const isOn = useFontStore((s) =>
    selectedId ? s.activatedSet.has(selectedId) || s.pendingSet.has(selectedId) : false,
  );
  const isFav = useFontStore((s) => (selectedId ? s.favorites.includes(selectedId) : false));
  const preview = useFontStore((s) => s.preview);
  const storedAxes = useLiveAxes(selectedId);
  const setPreviewAxis = useFontStore((s) => s.setPreviewAxis);
  const setFeaturePref = useFontStore((s) => s.setFeaturePref);
  const query = useFontStore((s) => s.query);
  const setQuery = useFontStore((s) => s.setQuery);

  const font = selectedId ? findFont(selectedId, localFonts, googleFonts) : undefined;
  const [tagDraft, setTagDraft] = useState("");
  const [features, setFeatures] = useState<Record<string, boolean>>({});

  const [italicOn, setItalicOn] = useState(false);
  const [parsedTags, setParsedTags] = useState<string[] | undefined>();

  useEffect(() => {
    if (!font) return;
    void loadFont(font, "full");
    setItalicOn(isItalicOnlyFace(font) || (hasRealItalic(font) && Boolean(preview.italic)));
    setFeatures(useFontStore.getState().featurePrefs[font.id] ?? {});
    setTagDraft("");
    setParsedTags(font.otFeatures);
    const id = font.id;
    void (async () => {
      try {
        const { nativeFamilyLayout, fontMetricsFromLayout } = await import("@/lib/fonts/native-parse");
        const layout = await nativeFamilyLayout(font.family);
        if (layout) {
          if (layout.otFeatures?.length) setParsedTags(layout.otFeatures);
          const store = useFontStore.getState();
          if (layout.axes?.length) store.patchFontAxes(id, layout.axes);
          const metrics = fontMetricsFromLayout(layout);
          if (metrics) store.patchFontMetrics(id, metrics);
          if (layout.otFeatures?.length) return;
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
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setInspectorOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setInspectorOpen]);

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
      <>
        <button
          type="button"
          className="absolute inset-0 z-20 bg-background/60 md:hidden"
          aria-label="Close inspector"
          onClick={() => setInspectorOpen(false)}
        />
        <aside className="fm-inspector fixed inset-y-0 right-0 z-30 flex h-full w-full min-w-0 flex-col overflow-hidden border-l border-border bg-card shadow-border md:static md:inset-auto md:z-auto md:w-inspector md:shrink-0">
          <div className="fm-inspector-head flex justify-end">
            <Button size="icon-sm" variant="ghost" aria-label="Close inspector" onClick={() => setInspectorOpen(false)}>
              <X />
            </Button>
          </div>
        </aside>
      </>
    );
  }

  const stack = cssFamilyStack(font);
  const axes = axesForFont(font);
  const cardWeight = storedAxes?.wght ?? defaultWeightForFont(font);
  const liveAxes = previewAxisValues(font, storedAxes, cardWeight, italicOn);
  const weight = liveAxes.wght ?? cardWeight;
  const { ital: italAxis, slnt: slntAxis } = realItalicAxes(font);
  const italicCss = italicPreviewStyle(font, italicOn);
  const canItalic = hasRealItalic(font) && !isItalicOnlyFace(font);
  const axisStyle = variationStyle(
    {
      ...liveAxes,
      ...(axes.some((a) => a.tag === "wght") ? {} : { wght: weight }),
    },
    axes,
  );
  const tags = tagsFor(font, customTags);
  const searchMetrics = metricsFor(font);
  const searchChips: { label: string; token: string; title: string }[] = [];
  {
    const xh = formatXh(searchMetrics.xh);
    const ctr = contrastLabel(searchMetrics.contrast);
    const width = widthClassLabel(searchMetrics.widthClass);
    if (xh) searchChips.push({ label: `xh ${xh}`, token: `xh:${xh}-${xh}`, title: "OS/2 sxHeight / UPM" });
    if (ctr) {
      searchChips.push({
        label: `${ctr} contrast`,
        token: `contrast:${ctr}`,
        title: "Latin-Text PANOSE, not a stem raster",
      });
    }
    searchChips.push({
      label: `weight ${searchMetrics.weightClass}`,
      token: `weight:${searchMetrics.weightClass}`,
      title: "OS/2 usWeightClass or catalog weights",
    });
    if (width) {
      searchChips.push({
        label: width,
        token: `width:${searchMetrics.widthClass}-${searchMetrics.widthClass}`,
        title: "OS/2 usWidthClass",
      });
    }
    searchChips.push({ label: `UPM ${searchMetrics.upem}`, token: "", title: "head unitsPerEm" });
    for (const axis of axes) {
      const lo = formatFvar(axis.min);
      const hi = formatFvar(axis.max);
      searchChips.push({
        label: `${axis.tag} ${lo}–${hi}`,
        token: `${axis.tag}:${lo}-${hi}`,
        title: `fvar ${axis.name || axis.tag}`,
      });
    }
  }

  return (
    <>
      <button
        type="button"
        className="absolute inset-0 z-20 bg-background/60 md:hidden"
        aria-label="Close inspector"
        onClick={() => setInspectorOpen(false)}
      />
    <aside className="fm-inspector fixed inset-y-0 right-0 z-30 flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden border-l border-border bg-card shadow-border md:static md:inset-auto md:z-auto md:w-inspector md:shrink-0">
      <div className="fm-inspector-head flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-heading min-w-0 max-w-full overflow-hidden text-xl leading-snug break-words text-foreground" style={{ fontFamily: stack, overflowWrap: "anywhere" }}>
            {font.family}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {font.source === "google"
              ? font.catalog === "other"
                ? "Fontsource"
                : "Google Fonts"
              : font.source === "system"
                ? "System"
                : "Local file"}
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
          <div className="fm-inspector-body space-y-6 pb-10">
            <p
              className={cn(
                "fm-spec min-w-0 max-w-full overflow-x-hidden overflow-hidden break-words rounded-lg bg-paper px-4 py-4 text-xl leading-snug text-ink",
                italicOn && hasRealItalic(font) ? "fm-spec-italic" : "fm-spec-roman",
                font.variable ? "fm-spec-variable" : "fm-spec-static",
                italicOn && hasRealItalic(font) ? "fm-spec-real" : null,
                preview.align === "center" && "text-center",
                preview.align === "right" && "text-right",
              )}
              dir={scriptDir(font.family)}
              lang={scriptLang(font.family)}
              style={{
                fontFamily: stack,
                fontSize: "1.25rem",
                lineHeight: 1.3,
                ...featureCss,
                fontWeight: font.variable ? (axisStyle.fontWeight ?? weight) : weight,
                fontStyle: italicCss.fontStyle ?? "normal",
                fontStretch: font.variable ? axisStyle.fontStretch : undefined,
                // Variable: always variationStyle FVS (opsz + custom). italicPreviewStyle
                // must not win — its old full-tuple FVS clobbered opsz and put wght in FVS.
                fontVariationSettings: font.variable
                  ? axisStyle.fontVariationSettings
                  : italicCss.fontVariationSettings,
                fontOpticalSizing: font.variable ? axisStyle.fontOpticalSizing : undefined,
                fontSynthesis: italicCss.fontSynthesis ?? synthesisForFont(font, {
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
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm text-muted-foreground">
                    System font — already available to Word and other apps. Read-only here (no Activate or Delete).
                  </p>
                  <HelpTip label="Open C:\\Windows\\Fonts">
                    <Button size="sm" variant="ghost" onClick={() => void openSystemFontsFolder()}>
                      <FolderOpen />
                      Folder
                    </Button>
                  </HelpTip>
                </div>
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
                <HelpTip label="Move the file to the Recycle Bin (library + Documents). Deactivate only unloads it from other apps.">
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => {
                      if (!window.confirm(`Move ${font.family} to the Recycle Bin? You can restore it from there.`)) return;
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
                <HelpTip
                  label={
                    font.catalog === "other"
                      ? "Move downloaded files to the Recycle Bin. The family stays in Fontsource. Deactivate only unloads them from other apps."
                      : "Move downloaded files to the Recycle Bin. The family stays in Google Fonts. Deactivate only unloads them from other apps."
                  }
                >
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      if (!window.confirm(`Move ${font.family} files to the Recycle Bin? The catalog entry stays.`)) return;
                      void deleteFontFiles(font);
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
                    if (tag === "slnt") setItalicOn(Math.abs(value) > 0.05);
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
            <label className="flex h-10 items-center justify-between rounded-md bg-secondary px-3 text-sm">
                Italic
                <Switch
                  checked={italicOn}
                  disabled={!canItalic}
                  title={canItalic ? "Toggle italic" : isItalicOnlyFace(font) ? "Italic file" : "No italic face"}
                  onCheckedChange={(on) => {
                    if (!canItalic) return;
                    setItalicOn(on);
                    if (italAxis) setPreviewAxis(font.id, "ital", on ? 1 : 0);
                    if (slntAxis) {
                      setPreviewAxis(
                        font.id,
                        "slnt",
                        on
                          ? slntAxis.min < 0
                            ? slntAxis.min
                            : slntAxis.max
                          : slntAxis.min <= 0 && slntAxis.max >= 0
                            ? 0
                            : slntAxis.def,
                      );
                    }
                    if (on) void loadItalicFace(font);
                  }}
                />
              </label>

            <section className="space-y-2">
              <Label>SuperSearch</Label>
              <p className="text-xs text-muted-foreground">
                {searchMetrics.xh == null || searchMetrics.contrast == null
                  ? "xh/contrast unknown until OS/2 is read (uploads and on-disk). Catalog-only families still match weight, width, variable, and axis ranges."
                  : "From OS/2 + head. Tap a chip to filter the library."}
              </p>
              <div className="flex flex-wrap gap-1">
                {searchChips.map((chip) => (
                  <button
                    key={chip.label}
                    type="button"
                    disabled={!chip.token}
                    title={chip.title}
                    onClick={() => {
                      if (!chip.token) return;
                      setQuery(toggleSearchToken(query, chip.token));
                    }}
                    className="inline-flex h-6 items-center rounded-full bg-secondary px-2.5 text-[11px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-70"
                  >
                    {chip.label}
                  </button>
                ))}
              </div>
            </section>

            <section className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label>OpenType features</Label>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => {
                    const css = [
                      `font-family: ${JSON.stringify(font.family)}, ${font.category === "mono" ? "monospace" : "sans-serif"};`,
                      `font-feature-settings: ${featureCss.fontFeatureSettings ?? "normal"};`,
                    ].join("\n");
                    void copyText(css).then(
                      () => undefined,
                      () => undefined,
                    );
                  }}
                >
                  <Copy className="size-3.5" />
                  Copy CSS
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {layoutTags?.length
                  ? `${layoutTags.length} GSUB/GPOS tags in this file. liga/calt/kern on by default. Toggle and watch the line below.`
                  : "Reading GSUB… common tags until the file is parsed. Off means explicitly disable."}
              </p>
              <p
                className="fm-spec min-w-0 max-w-full overflow-hidden break-words rounded-lg bg-paper px-3 py-2 text-xl text-ink"
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
                      onCheckedChange={(checked) => {
                        setFeatures((prev) => ({ ...prev, [tag]: checked }));
                        setFeaturePref(font.id, tag, checked);
                      }}
                    />
                  </label>
                ))}
              </div>
              <Link
                to="/glyphs"
                className="inline-flex h-9 items-center gap-1.5 text-xs text-muted-foreground no-underline hover:text-foreground"
              >
                <Grid3x3 className="size-3.5" />
                Full glyph map
              </Link>
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
              {font.source !== "system" && (
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
              {font.fullName && font.fullName !== font.family && <p>Name · {font.fullName}</p>}
              <p>Family · {font.family}</p>
              {font.originPath && <p className="truncate" title={font.originPath}>Path · {font.originPath}</p>}
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
    </>
  );
}
