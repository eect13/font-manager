import { useEffect } from "react";
import { GOOGLE_FONTS } from "./catalog";
import { refreshGoogleCatalog } from "./google-api";
import { idbGet, persistStorageOnGesture, requestPersistentStorage } from "./idb";
import { refineLicense } from "./license";
import { findFont, useFontStore } from "./store";
import { loadFont } from "./loader";
import { inferLocalStyle } from "./style-tags";
import { registerExistingOnDisk, listDiskFamilies, resumeGoogleFamilies, rememberSessionFamilies } from "./os-activate";
import { inDesktopShell } from "@/lib/desktop/open-fonts";
import { startWatchPolling } from "./watch-folder";
import type { FontRecord } from "./types";

async function reclassifyStoredLocalFonts(cancelled: () => boolean) {
  const { localFonts, collections } = useFontStore.getState();
  const targets = localFonts.filter((font) => !font.licenseUserSet);
  if (!targets.length) return;

  const namesFor = (id: string) =>
    collections.filter((collection) => collection.fontIds.includes(id)).map((collection) => collection.name);

  const next = localFonts.slice();
  const indexOf = new Map(next.map((font, index) => [font.id, index]));

  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const index = cursor;
      cursor += 1;
      const font = targets[index]!;
      if (cancelled()) return;
      let refined = refineLicense(
        {
          license: font.license ?? "unknown",
          licenseName: font.licenseName,
          fileName: font.fileName,
        },
        { collectionNames: namesFor(font.id), fileName: font.fileName },
      );
      let family = font.family;
      let cssFamily = font.cssFamily;
      let kerningKey = font.kerningKey;
      let glyphCount = font.glyphCount;
      let category = font.category;
      let tags = font.tags;
      const thinTags = !tags.length || (tags.length === 1 && tags[0] === "uploaded");
      const needsParse = !font.kerningKey || font.license === "unknown" || thinTags;
      if (needsParse) {
        const blob = await idbGet(font.id);
        if (blob) {
          try {
            const { parseFontFile } = await import("./parse-font");
            const parsed = await parseFontFile(new File([blob], font.fileName || "font.ttf"));
            refined = refineLicense(parsed, {
              fileName: font.fileName,
              collectionNames: namesFor(font.id),
            });
            const fallback = (font.fileName ?? "").replace(/\.[^.]+$/, "").replace(/[-_]/g, " ");
            if (parsed.family && font.family === fallback) {
              family = parsed.family;
              cssFamily = parsed.family;
            }
            if (parsed.kerningKey) kerningKey = parsed.kerningKey;
            if (parsed.glyphCount) glyphCount = parsed.glyphCount;
            if (parsed.category) category = parsed.category;
            if (parsed.tags.length) tags = parsed.tags;
          } catch {
            /* keep hint-based result */
          }
        }
      }
      const inferred = inferLocalStyle({
        family,
        fileName: `${font.fileName ?? ""} ${namesFor(font.id).join(" ")}`,
      });
      if (inferred.fromName) category = inferred.category;
      if (inferred.tags.length) {
        tags = Array.from(new Set([...inferred.tags, ...tags.filter((t) => t !== "uploaded")]));
      }
      const at = indexOf.get(font.id);
      if (at === undefined) continue;
      const current = next[at] as FontRecord;
      next[at] = {
        ...current,
        license: refined.license,
        licenseName: refined.licenseName || current.licenseName,
        family,
        cssFamily,
        kerningKey,
        glyphCount,
        category,
        tags,
      };
    }
  }

  await Promise.all(Array.from({ length: Math.min(4, targets.length) }, () => worker()));
  if (cancelled()) return;
  useFontStore.setState({ localFonts: next });
}

export function useHydrateFonts() {
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve(useFontStore.persist.rehydrate()).then(async () => {
      if (cancelled) return;
      const { localFonts, setHydrated, googleFonts, collections, scope } = useFontStore.getState();
      if (
        typeof scope === "string" &&
        scope.startsWith("collection:") &&
        !collections.some((c) => c.id === scope.slice("collection:".length))
      ) {
        useFontStore.getState().setScope("all");
      }
      setHydrated(true);
      void requestPersistentStorage();
      persistStorageOnGesture();

      const google = googleFonts.length ? googleFonts : GOOGLE_FONTS;
      const wantIds = Array.from(
        new Set([...useFontStore.getState().activated, ...useFontStore.getState().pendingActivate]),
      );
      const desktop = await inDesktopShell();
      if (desktop) {
        const wantNames = wantIds
          .map((id) => findFont(id, localFonts, google)?.family)
          .filter((name): name is string => Boolean(name));
        await registerExistingOnDisk(wantNames);
        const disk = cancelled ? [] : await listDiskFamilies();
        if (cancelled) return;
        if (disk.length) {
          const allow = new Set(disk.map((n) => n.trim().toLowerCase()));
          const live: string[] = [];
          const need: string[] = [];
          for (const id of wantIds) {
            const font = findFont(id, localFonts, google);
            if (!font) continue;
            if (font.source === "local" || allow.has(font.family.toLowerCase())) live.push(id);
            else if (font.source === "google") need.push(id);
          }
          useFontStore.getState().restoreActivation(live, need);
          void rememberSessionFamilies(
            live
              .map((id) => findFont(id, localFonts, google)?.family)
              .filter((name): name is string => Boolean(name)),
          );
          if (need.length) {
            void resumeGoogleFamilies(
              need
                .map((id) => findFont(id, localFonts, google)?.family)
                .filter((name): name is string => Boolean(name)),
            );
          }
        } else if (wantIds.length) {
          const live: string[] = [];
          const need: string[] = [];
          for (const id of wantIds) {
            const font = findFont(id, localFonts, google);
            if (!font) continue;
            if (font.source === "local") live.push(id);
            else need.push(id);
          }
          useFontStore.getState().restoreActivation(live, need);
          if (need.length) {
            void resumeGoogleFamilies(
              need
                .map((id) => findFont(id, localFonts, google)?.family)
                .filter((name): name is string => Boolean(name)),
            );
          }
        }
      }
      const liveIds = useFontStore.getState().activated;
      const toLoad = liveIds.slice(0, 12).map((id) => findFont(id, localFonts, google));
      void Promise.all(toLoad.map((font) => (font ? loadFont(font) : Promise.resolve())));

      void reclassifyStoredLocalFonts(() => cancelled);

      startWatchPolling();

      window.setTimeout(() => {
        if (cancelled) return;
        void refreshGoogleCatalog().then((live) => {
          if (cancelled || !live) return;
          useFontStore.getState().setGoogleFonts(GOOGLE_FONTS.slice());
          useFontStore.getState().setCatalogLive(true);
        });
      }, 2500);
    });
    return () => {
      cancelled = true;
    };
  }, []);
}
