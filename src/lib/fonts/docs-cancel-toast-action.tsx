/**
 * 1.0.206y — docs-owned toast Cancel uses the same Name/AutomationId as the
 * progress-bar Cancel (`cancelChromeA11y`). Sonner Action only exposes label/onClick,
 * so we pass a React element (ValidElement path) with id on the real <button>.
 */
import { createElement, type MouseEvent } from "react";
import { toast } from "sonner";
import { cancelChromeA11y } from "@/lib/fonts/docs-vf-sync-ownership.mjs";
import { cancelDownloadQueue } from "@/lib/fonts/os-activate";

const DOCS_REFRESH_TOAST_ID = "sync-docs-vf";

/** Toast action button with docs Cancel identity (Gate D UIA). */
export function docsCancelToastAction() {
  const a11y = cancelChromeA11y({ showDocsCancelIdentity: true });
  return createElement(
    "button",
    {
      type: "button",
      "data-button": true,
      "data-action": true,
      "data-testid": "docs-toast-cancel",
      ...a11y,
      onClick: (event: MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        void cancelDownloadQueue();
        toast.dismiss(DOCS_REFRESH_TOAST_ID);
      },
    },
    "Cancel",
  );
}

export { DOCS_REFRESH_TOAST_ID };
