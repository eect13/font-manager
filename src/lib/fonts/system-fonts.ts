import { inDesktopShell } from "@/lib/desktop/open-fonts";
import type { FontCategory, FontRecord } from "./types";
import { useFontStore } from "./store";

type SystemFontOut = {
  family: string;
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
    source: "system",
    category: categoryOf(row.family),
    weights: [weight],
    italic: Boolean(row.italic),
    variable: Boolean(row.variable),
    tags: ["system"],
    popularity: 10_000,
    license: "unknown",
    licenseName: "Windows",
    fileName: row.fileName,
    cssFamily: row.family,
    originPath: row.path,
    colorKind: /emoji|color/i.test(row.family) ? "colrv1" : "none",
  };
}

export async function loadSystemFonts(): Promise<void> {
  if (!(await inDesktopShell())) {
    useFontStore.getState().setSystemFonts([]);
    return;
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const rows = (await invoke<SystemFontOut[]>("list_system_fonts")) ?? [];
    useFontStore.getState().setSystemFonts(rows.map(toRecord));
  } catch {
    useFontStore.getState().setSystemFonts([]);
  }
}
