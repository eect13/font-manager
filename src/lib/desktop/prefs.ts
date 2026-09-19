export type DesktopPrefs = {
  closeToTray: boolean;
  startWithWindows: boolean;
};

export const DEFAULT_DESKTOP_PREFS: DesktopPrefs = {
  closeToTray: false,
  startWithWindows: false,
};

export function coerceDesktopPrefs(raw: unknown): DesktopPrefs {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    closeToTray: Boolean(o.closeToTray),
    startWithWindows: Boolean(o.startWithWindows),
  };
}

/** Push prefs to the desktop shell. No-op in the browser preview. */
export async function applyDesktopPrefs(prefs: DesktopPrefs): Promise<void> {
  try {
    const { invoke, isTauri } = await import("@tauri-apps/api/core");
    if (typeof isTauri === "function" && !isTauri()) return;
    await invoke("set_desktop_prefs", {
      closeToTray: prefs.closeToTray,
      startWithWindows: prefs.startWithWindows,
    });
  } catch {
    /* web / old installer */
  }
}
