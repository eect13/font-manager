/**
 * Docs VF sync / Refresh Documents cancel ownership (1.0.206w amend).
 * Pure ESM so tip tests can assert the Scanning Documents collision matrix.
 *
 * Activate (`start_google_downloads`) and docs sync both use "Scanning Documents…".
 * Ownership must NOT treat bare scanning as docs — sticky flags + docs-only currents only.
 */

/** Progress currents Activate never uses (belt-and-suspenders vs sticky race). */
export function isDocsRefreshJobCurrent(current) {
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
