import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "font-manager:theme";
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function readStored(): Theme {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "light" || value === "dark") return value;
  } catch {
    /* ignore */
  }
  return "dark";
}

function readDom(): Theme | null {
  if (typeof document === "undefined") return null;
  const value = document.documentElement.dataset.theme;
  return value === "light" || value === "dark" ? value : null;
}

let current: Theme = readDom() ?? "dark";

export const THEME_BOOTSTRAP = `(function(){try{var t=localStorage.getItem("${STORAGE_KEY}");if(t!=="light"&&t!=="dark")t="dark";var r=document.documentElement;r.setAttribute("data-theme",t);r.style.colorScheme=t;var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute("content",t==="light"?"#f3efe6":"#0c0c0d");}catch(e){document.documentElement.setAttribute("data-theme","dark");}})();`;

export function getTheme(): Theme {
  return current;
}

export function subscribeTheme(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function applyTheme(theme: Theme) {
  current = theme;
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "light" ? "#f3efe6" : "#0c0c0d");
  }
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* ignore */
  }
  emit();
}

export function toggleTheme() {
  applyTheme(current === "dark" ? "light" : "dark");
}

export function hydrateTheme() {
  applyTheme(readDom() ?? readStored());
}

export function useTheme() {
  return useSyncExternalStore(subscribeTheme, getTheme, () => "dark" as Theme);
}
