/**
 * 1.0.206z amend (Skye HOLD) — docs-owned toast Cancel is a real <button> that calls
 * `cancelDownloadQueue` (honesty: mid-job → Documents refresh cancelled). Gate D UIA
 * Name/AutomationId stay on the **progress bar only** — toast uses short Name **Cancel**
 * with no bar Gate D id / data-automation-id / long Name (avoids dual FindFirst miss).
 */
import { createElement, type MouseEvent } from "react";
import { cancelDownloadQueue } from "@/lib/fonts/os-activate";

const DOCS_REFRESH_TOAST_ID = "sync-docs-vf";

/** Toast action: short Cancel only — Gate D identity is bar-only. */
export function docsCancelToastAction() {
  return createElement(
    "button",
    {
      type: "button",
      "data-button": true,
      "data-action": true,
      "data-testid": "docs-toast-cancel",
      "aria-label": "Cancel",
      "data-cancel-kind": "documents-refresh-toast",
      onClick: (event: MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        // cancelDownloadQueue replaces Refreshing → Cancelling (do not dismiss after).
        void cancelDownloadQueue({ fromDocsCancelChrome: true });
      },
    },
    "Cancel",
  );
}

export { DOCS_REFRESH_TOAST_ID };
