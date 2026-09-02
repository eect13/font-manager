import { inDesktopShell, isDesktopShellSync } from "@/lib/desktop/open-fonts";
import type { FontCategory, FontRecord } from "./types";
import { useFontStore } from "./store";

type SystemFontOut = {
  family: string;
  fullName?: string;
  path: string;
  fileName: string;
  italic: boolean;
  variable: boolean;
  weight: number;
};

function categoryOf(family: string): FontCategory {
  const n = family.toLowerCase();
  if (/mdl2|fluent icons|wingdings|webdings|symbol/i.test(n)) return "icons";
  if (/mono|consolas|courier|cascadia|fixedsys|terminal/i.test(n)) return "mono";
  if (/script|hand|comic|cursive|segoe script|ink/i.test(n)) return "handwriting";
  if (/display|black|poster|impact/i.test(n)) return "display";
  if (/serif|times|georgia|garamond|cambria|palatino|constantia/i.test(n)) return "serif";
  return "sans";
}

function toRecord(row: SystemFontOut): FontRecord {
  const weight = Number.isFinite(row.weight) && row.weight > 0 ? Math.round(row.weight) : 400;
  return {
    id: `s:${row.family}`,
    family: row.family,
    fullName: row.fullName && row.fullName !== row.family ? row.fullName : undefined,
    source: "system",
    category: categoryOf(row.family),
    weights: [weight],
    italic: Boolean(row.italic),
    variable: Boolean(row.variable),
    tags: ["system"],
    popularity: 10_000,
    license: "unknown",
    licenseName: "System",
    fileName: row.fileName,
    cssFamily: row.family,
    originPath: row.path || undefined,
    colorKind: /emoji|color/i.test(row.family) ? "colrv1" : "none",
  };
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

let inflight: Promise<void> | null = null;

export async function loadSystemFonts(): Promise<void> {
  if (useFontStore.getState().systemFonts.length) return;
  if (inflight) return inflight;
  inflight = (async () => {
    let desktop = isDesktopShellSync();
    if (!desktop) desktop = await inDesktopShell();
    if (!desktop) {
      useFontStore.getState().setSystemBusy(false);
      return;
    }
    useFontStore.getState().setSystemBusy(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      let rows: SystemFontOut[] = [];
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          rows = (await invoke<SystemFontOut[]>("list_system_fonts")) ?? [];
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err;
          await sleep(200);
        }
      }
      if (lastErr && !rows.length) throw lastErr;
      useFontStore.getState().setSystemFonts(rows.map(toRecord));
    } catch {
      useFontStore.getState().setSystemBusy(false);
      useFontStore.getState().setSystemFonts([]);
    }
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

export async function openSystemFontsFolder(): Promise<void> {
  if (!(await inDesktopShell())) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_system_fonts_folder");
  } catch {
    /* web preview */
  }
}
