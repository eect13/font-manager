import { useSyncExternalStore } from "react";

const KEY = "font-manager:ui-density";
const ATTR = "data-ui-density";

export type UiDensity = "comfortable" | "compact";
export const UI_DENSITY_DEFAULT: UiDensity = "comfortable";

/** Virtualizer + card layout px — keep in sync with styles.css density vars. */
export const DENSITY_LAYOUT = {
  comfortable: { gridH: 232, listH: 152, gap: 8 },
  compact: { gridH: 176, listH: 120, gap: 4 },
} as const;

const listeners = new Set<() => void>();

export function parseUiDensity(raw: string | null): UiDensity {
  return raw === "compact" ? "compact" : "comfortable";
}

export function readUiDensity(): UiDensity {
  if (typeof localStorage === "undefined") return UI_DENSITY_DEFAULT;
  try {
    return parseUiDensity(localStorage.getItem(KEY));
  } catch {
    return UI_DENSITY_DEFAULT;
  }
}

export function applyUiDensity(value: UiDensity) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute(ATTR, value);
}

export function writeUiDensity(value: UiDensity) {
  try {
    localStorage.setItem(KEY, value);
  } catch {
    /* private mode */
  }
  applyUiDensity(value);
}

let current: UiDensity = UI_DENSITY_DEFAULT;
if (typeof window !== "undefined") {
  current = readUiDensity();
  applyUiDensity(current);
}

function emit() {
  listeners.forEach((fn) => fn());
}

export function getUiDensity(): UiDensity {
  return current;
}

export function setUiDensity(value: UiDensity) {
  current = value === "compact" ? "compact" : "comfortable";
  writeUiDensity(current);
  emit();
}

export function subscribeUiDensity(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useUiDensity() {
  const density = useSyncExternalStore(subscribeUiDensity, getUiDensity, () => UI_DENSITY_DEFAULT);
  return {
    density,
    setDensity: setUiDensity,
    isCompact: density === "compact",
    layout: DENSITY_LAYOUT[density],
  };
}

/** Apply before paint — pairs with THEME_BOOTSTRAP. */
export const UI_DENSITY_BOOT = `(function(){try{var k=${JSON.stringify(KEY)};var v=localStorage.getItem(k);var d=v==="compact"?"compact":"comfortable";document.documentElement.setAttribute(${JSON.stringify(ATTR)},d);}catch(e){}})();`;
