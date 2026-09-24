/**
 * Docs VF sync / Refresh Documents cancel ownership (1.0.206w–206z).
 * 1.0.206z: WebView2 UIA Name often follows button *contents* (not aria-label); bar
 * visible label must match FindFirst Name. Gate D Name/id are **bar-only** (toast = short Cancel).
 * Pure ESM so tip tests can assert the Scanning Documents collision matrix
 * and docs Cancel chrome ≥1s UIA stability without React.
 *
 * Activate (`start_google_downloads`) and docs sync both use "Scanning Documents…".
 * Ownership must NOT treat bare scanning as docs — sticky flags + docs-only currents only.
 */

/** Min time docs Cancel Name/AutomationId stay findable after first paint (Gate D smoke). */
export const DOCS_CANCEL_MIN_DISPLAY_MS = 1000;

/** Progress currents Activate never uses (belt-and-suspenders vs sticky race). */
export function isDocsRefreshJobCurrent(current) {
  // Docs mid-abort owned via docsVfSyncCancelPending + docsVfSyncSessionLive — never bare
  // "Stopping…" (shared cancel_google_downloads sets that for Activate too — soft-lie).
  return /syncing documents|sync cancelled|refresh(?:ing)? documents/i.test(
    current ?? "",
  );
}

/** Primary: sticky active/pending. Belt: docs-only job.current strings. */
export function docsVfSyncOwnsJob({
  docsVfSyncActive = false,
  docsVfSyncCancelPending = false,
  current = "",
} = {}) {
  return (
    Boolean(docsVfSyncActive) ||
    Boolean(docsVfSyncCancelPending) ||
    isDocsRefreshJobCurrent(current)
  );
}

/**
 * Cancel toast title kind (docs vs session restore vs download).
 * Restoring N/T → session-restore; Scanning Documents… without sticky → download.
 */
export function cancelToastKind({
  docsVfSyncActive = false,
  docsVfSyncCancelPending = false,
  current = "",
  wasRemove = false,
} = {}) {
  if (
    docsVfSyncOwnsJob({
      docsVfSyncActive,
      docsVfSyncCancelPending,
      current,
    })
  ) {
    return "documents-refresh";
  }
  if (wasRemove) return "deactivate";
  if (/restoring/i.test(current ?? "")) return "session-restore";
  return "download";
}

/**
 * Latch docs Cancel chrome for UIA stability (1.0.206x) + honest post-end hold.
 *
 * When docs ownership first meets cancellable Cancel chrome, latch and record paintedAt.
 * Keep Cancel Name/id while docs still owns AND cancel chrome is eligible (running/paused).
 * Do not flip to restore/download mid-job.
 *
 * showDocsCancelIdentity — true ONLY while docs + cancellable (Cancel Documents refresh path).
 * Never true during post-end min window (that would imply Cancel while onClick only dismisses).
 *
 * inMinDisplayHold / holdDismissChrome — post-end min window: delay bar hide until
 * paintedAt+minMs; download-bar routes to cancelChromeA11y({ dismissHold: true }).
 */
export function advanceDocsCancelChrome({
  docsOwns = false,
  cancelChromeEligible = false,
  now = Date.now(),
  paintedAt = null,
  latched = false,
  minMs = DOCS_CANCEL_MIN_DISPLAY_MS,
} = {}) {
  let nextLatched = Boolean(latched);
  let nextPaintedAt =
    paintedAt == null || !Number.isFinite(Number(paintedAt))
      ? null
      : Number(paintedAt);

  const cancellableDocs = Boolean(docsOwns) && Boolean(cancelChromeEligible);

  if (cancellableDocs) {
    if (!nextLatched || nextPaintedAt == null) {
      nextLatched = true;
      nextPaintedAt = now;
    }
  }

  const elapsed =
    nextPaintedAt == null ? Number.POSITIVE_INFINITY : Math.max(0, now - nextPaintedAt);
  const inMinWindow = nextLatched && nextPaintedAt != null && elapsed < minMs;

  // Cancel Name/id path — docs + cancellable only (never post-end hold).
  const showDocsCancelIdentity = nextLatched && cancellableDocs;
  // Post-end hold — min window after Cancel chrome no longer eligible.
  const inMinDisplayHold = inMinWindow && !cancellableDocs;
  const holdDismissChrome = inMinDisplayHold;

  if (nextLatched && !cancellableDocs && !inMinWindow) {
    nextLatched = false;
    nextPaintedAt = null;
  }

  return {
    latched: nextLatched,
    paintedAt: nextPaintedAt,
    showDocsCancelIdentity,
    inMinDisplayHold,
    holdDismissChrome,
    remainingMinMs:
      nextPaintedAt == null || !nextLatched
        ? 0
        : Math.max(0, minMs - Math.max(0, now - nextPaintedAt)),
  };
}

/**
 * Visible button label — WebView2/WRY UIA Name often comes from contents, not aria-label
 * (Gate D 206y: FindFirst Name "Cancel Documents refresh" missed while short "Cancel" showed).
 */
export function cancelChromeVisibleLabel({
  showDocsCancelIdentity = false,
  restoring = false,
  dismissHold = false,
} = {}) {
  if (dismissHold) return "Dismiss";
  if (showDocsCancelIdentity) return "Cancel Documents refresh";
  if (restoring) return "Cancel session restore";
  return "Cancel";
}

/**
 * Stable Cancel / Dismiss button a11y attrs — single source of truth for download-bar + toast.
 * - dismissHold (post-end min-display): honest Dismiss — never Cancel Documents refresh Name/id
 * - showDocsCancelIdentity (cancellable docs): Cancel Documents refresh + fm-cancel-documents-refresh
 * - omitDomId: optional — strip HTML id from attrs (toast must not use Gate D identity at all;
 *   see docsCancelToastAction — short Cancel only, no fm-cancel-documents-refresh).
 */
export function cancelChromeA11y({
  showDocsCancelIdentity = false,
  restoring = false,
  dismissHold = false,
  omitDomId = false,
} = {}) {
  if (dismissHold) {
    return {
      "aria-label": "Dismiss Documents refresh",
      ...(omitDomId ? {} : { id: "fm-dismiss-documents-refresh" }),
      "data-automation-id": "fm-dismiss-documents-refresh",
      "data-cancel-kind": "dismiss",
    };
  }
  if (showDocsCancelIdentity) {
    return {
      "aria-label": "Cancel Documents refresh",
      ...(omitDomId ? {} : { id: "fm-cancel-documents-refresh" }),
      "data-automation-id": "fm-cancel-documents-refresh",
      "data-cancel-kind": "documents-refresh",
      "data-docs-cancel": "activate-bar-cancel-docs",
    };
  }
  if (restoring) {
    return {
      "aria-label": "Cancel session restore",
      ...(omitDomId ? {} : { id: "fm-cancel-session-restore" }),
      "data-cancel-kind": "session-restore",
    };
  }
  return {
    "aria-label": "Cancel",
    "data-cancel-kind": "download",
  };
}

/**
 * 1.0.206y — hide library/main (thousands of font cards) from the a11y tree while
 * docs sync owns the job so UIA FindFirst(Name/Id) for Cancel resolves in ≤300ms
 * without walking Descendants through ~2100 library nodes.
 * DownloadBar / toast Cancel must stay *outside* the aria-hidden / inert subtree (app-shell).
 */
export function shouldHideLibraryFromA11yDuringDocsJob({
  docsOwns = false,
  cancelChromeEligible = true,
} = {}) {
  return Boolean(docsOwns) && Boolean(cancelChromeEligible);
}

/**
 * 1.0.206z — contract: Cancel chrome hosts must not be descendants of inert/aria-hidden
 * library wrappers. Tip tests assert app-shell source order (chrome region before inert).
 */
export function docsCancelChromeHosts() {
  return {
    shellChromeAttr: "data-fm-shell-chrome",
    libraryInertAttr: "data-fm-library-inert",
    cancelTestId: "activate-bar-cancel",
    cancelDomId: "fm-cancel-documents-refresh",
    cancelName: "Cancel Documents refresh",
    /** Toast must never expose this Name/id (Gate D bar-only). */
    toastCancelName: "Cancel",
  };
}
