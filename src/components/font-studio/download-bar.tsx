import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { FolderOpen, LoaderCircle, Pause, Play, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  cancelDownloadQueue,
  dismissDownloadBar,
  getDownloadJob,
  getJobClock,
  isDocsVfSyncJob,
  openActivatedFolder,
  pauseDownloadQueue,
  resumeDownloadQueue,
  retryFailedDownloads,
  skipFailedDownloads,
  subscribeDownloadJob,
} from "@/lib/fonts/os-activate";
import {
  advanceDocsCancelChrome,
  cancelChromeA11y,
  cancelChromeVisibleLabel,
} from "@/lib/fonts/docs-vf-sync-ownership.mjs";

function clampPct(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function etaLabel(remaining: number, activeMs: number, processed: number): string {
  if (remaining <= 0 || processed <= 0 || activeMs < 800) return "";
  const rate = processed / activeMs;
  if (rate <= 0) return "";
  const ms = remaining / rate;
  if (ms < 4000) return "a few seconds left";
  if (ms < 60_000) return `~${Math.max(1, Math.round(ms / 1000))}s left`;
  const min = Math.round(ms / 60_000);
  if (min < 60) return `~${min} min left`;
  const hr = Math.floor(min / 60);
  const rem = min % 60;
  return rem ? `~${hr}h ${rem}m left` : `~${hr}h left`;
}

/** Match Settled finish toast duration (notifyDownloadResult). */
const SETTLED_IDLE_AUTO_HIDE_MS = 16_000;

export function DownloadBar() {
  const job = useSyncExternalStore(subscribeDownloadJob, getDownloadJob, getDownloadJob);
  const [, setTick] = useState(0);
  const [, setDocsHoldTick] = useState(0);
  const holdPct = useRef(0);
  // 1.0.206x: latch docs Cancel identity + min display across progress ticks / early idle.
  const docsCancelLatch = useRef<{ latched: boolean; paintedAt: number | null }>({
    latched: false,
    paintedAt: null,
  });
  const skipped = job.skipped ?? 0;
  // Progress is rust `done` (families processed). Do not use `skipped` as the
  // numerator — it double-counts already-on-disk + successful Add (4044/2253).
  const total = Math.max(1, job.total, job.done);
  const processed = Math.min(Math.max(0, job.done), total);
  const remaining = Math.max(0, total - processed);
  const empty =
    job.running &&
    job.total === 0 &&
    skipped === 0 &&
    processed === 0 &&
    !job.failedNames.length &&
    !job.paused;
  useEffect(() => {
    if (!job.running || job.paused) return;
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [job.running, job.paused]);

  const settledIdle = (job.settledNames?.length ?? 0) > 0 && !job.running && !job.paused;
  // 1.0.187: auto-hide settled-idle bar ~16s (same as Settled toast); store settled stays.
  useEffect(() => {
    if (!settledIdle) return;
    const t = window.setTimeout(() => dismissDownloadBar(), SETTLED_IDLE_AUTO_HIDE_MS);
    return () => window.clearTimeout(t);
  }, [settledIdle]);

  // Peek docs ownership before idle early-return so post-end min-display hold can keep bar ≥1s.
  // cancelChromeEligible = running/paused only — do NOT OR latched (that would imply Cancel mid-hold).
  const docsSync = isDocsVfSyncJob();
  const cancelEligible = job.running || job.paused;
  const now = Date.now();
  const chrome = advanceDocsCancelChrome({
    docsOwns: docsSync,
    cancelChromeEligible: cancelEligible,
    now,
    paintedAt: docsCancelLatch.current.paintedAt,
    latched: docsCancelLatch.current.latched,
  });
  docsCancelLatch.current = { latched: chrome.latched, paintedAt: chrome.paintedAt };

  // Re-render when post-end Dismiss hold expires after natural docs end (no fake Pause).
  useEffect(() => {
    if (!chrome.inMinDisplayHold || chrome.remainingMinMs <= 0) return;
    if (job.running || job.paused) return;
    const t = window.setTimeout(() => setDocsHoldTick((n) => n + 1), chrome.remainingMinMs + 1);
    return () => window.clearTimeout(t);
  }, [chrome.inMinDisplayHold, chrome.remainingMinMs, job.running, job.paused]);

  // Post-end hold only — helper already excludes cancellable docs (Cancel Name/id path).
  const holdDismissChrome = chrome.holdDismissChrome;
  const idleHide =
    (!job.running &&
      !job.paused &&
      job.mode === "idle" &&
      (job.owner === "idle" || !job.owner) &&
      !job.failedNames.length &&
      !settledIdle) ||
    empty;

  if (idleHide && !holdDismissChrome) {
    holdPct.current = 0;
    return null;
  }

  const scanning = /scanning/i.test(job.current);
  const registering = job.mode === "register" || job.owner === "register" || /registering/i.test(job.current);
  // 1.0.190: calm Restoring N/T — not download hang chrome.
  const restoring = /restoring/i.test(job.current) && !chrome.showDocsCancelIdentity;
  // 1.0.206w amend: sticky docs ownership only — never bare "scanning documents" (Activate shares it).
  // 1.0.206x: docs Cancel identity only while docs + cancellable (not post-end hold).
  const docsChrome = chrome.showDocsCancelIdentity;
  const pct = job.total > 0 || job.done > 0 ? clampPct((100 * processed) / total) : job.paused ? holdPct.current : 0;
  if (pct > holdPct.current) holdPct.current = pct;
  const shownPct = job.paused ? Math.max(pct, holdPct.current) : pct;
  const clock = getJobClock();
  const eta =
    job.paused || scanning || restoring || docsChrome || settledIdle || holdDismissChrome
      ? ""
      : etaLabel(remaining, clock.activeMs, Math.max(0, processed - skipped) || processed);
  const label =
    holdDismissChrome
      ? "Refreshing complete"
      : settledIdle
        ? "Done"
        : job.mode === "remove"
          ? `Deactivating ${processed.toLocaleString()} / ${total.toLocaleString()}`
          : job.failed && !job.running && !job.paused
            ? `${job.failed.toLocaleString()} failed — retry or skip`
            : job.paused
              ? `Paused ${shownPct}% · ${processed.toLocaleString()} / ${total.toLocaleString()}`
              : scanning || (docsChrome && /scanning/i.test(job.current))
                ? `Scanning Documents${total ? ` — ${total.toLocaleString()} queued` : ""}`
                : docsChrome && job.running
                  ? `Refreshing Documents ${processed.toLocaleString()} / ${total.toLocaleString()}`
                  : restoring && job.running
                    ? `Restoring ${processed.toLocaleString()} / ${total.toLocaleString()}`
                    : registering && job.running
                      ? `Registering ${processed.toLocaleString()} / ${total.toLocaleString()}`
                      : skipped && remaining === 0 && job.running
                        ? `Registering ${skipped.toLocaleString()} already on disk`
                        : skipped && job.running
                          ? `${skipped.toLocaleString()} on disk · downloading ${Math.max(0, processed - Math.min(skipped, processed)).toLocaleString()} / ${Math.max(0, total - Math.min(skipped, total)).toLocaleString()}`
                          : job.running
                            ? `Downloading ${processed.toLocaleString()} / ${total.toLocaleString()}`
                            : skipped && remaining === 0
                              ? `${skipped.toLocaleString()} already on disk`
                              : `Downloading ${processed.toLocaleString()} / ${total.toLocaleString()}`;

  return (
    <div className="fm-download-bar flex flex-col border-b border-border bg-card text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        {job.running && !job.paused ? <LoaderCircle className="size-3.5 shrink-0 animate-spin" /> : null}
        <p className="min-w-0 flex-1 truncate">
          <span className="font-medium text-foreground">{label}</span>
          {/* 1.0.206x: never put rapidly changing job.current into a11y tree during docs sync. */}
          {job.current && !scanning && !restoring && !docsChrome && !settledIdle && !holdDismissChrome ? ` — ${job.current}` : ""}
          {job.failedNames.length ? (
            <span className="block truncate text-destructive">
              Couldn’t load: {job.failedNames.slice(0, 8).join(", ")}
              {job.failedNames.length > 8 ? ` +${job.failedNames.length - 8}` : ""}. Retry, Skip, or Delete files and Activate again.
            </span>
          ) : (job.settledNames?.length ?? 0) > 0 && !job.running ? (
            <span className="block truncate text-muted-foreground">
              Settled {job.settledNames!.slice(0, 4).join(", ")}
              {job.settledNames!.length > 4 ? ` +${job.settledNames!.length - 4}` : ""} — on disk · Windows won’t load (not Activated)
            </span>
          ) : null}
          <span className="text-muted-foreground">
            {settledIdle || holdDismissChrome || docsChrome
              ? ""
              : job.paused
                ? " · queue held at this percent — Resume continues, does not restart"
                : scanning
                  ? " · checking Documents, not downloading yet"
                  : restoring
                    ? " · session GDI restore — UI stays interactive"
                    : registering
                      ? " · intact files register only — no fetch"
                      : remaining === 0 && skipped
                      ? " · nothing to fetch"
                      : eta
                        ? ` · ${eta}`
                        : " · skip intact, download only missing or corrupt"}
          </span>
        </p>
        <span
          className="shrink-0 tabular-nums font-medium text-foreground"
          aria-live={docsChrome || holdDismissChrome ? undefined : "polite"}
          aria-label={`${shownPct} percent`}
        >
          {shownPct}%
        </span>
        <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => void openActivatedFolder()}>
          <FolderOpen />
          Folder
        </Button>
        {settledIdle ? (
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => dismissDownloadBar()}>
            <X />
            Dismiss
          </Button>
        ) : null}
        {holdDismissChrome ? (
          /* Post-end min-display hold: honest Dismiss (dismissDownloadBar only) — never Cancel Name/id. */
          <Button
            key="activate-bar-dismiss"
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            data-testid="activate-bar-dismiss"
            {...cancelChromeA11y({ dismissHold: true })}
            onClick={() => dismissDownloadBar()}
          >
            <X aria-hidden="true" />
            {cancelChromeVisibleLabel({ dismissHold: true })}
          </Button>
        ) : job.running || job.paused ? (
          <>
            {job.paused ? (
              <Button size="sm" variant="ghost" className="h-7 px-2" aria-label="Resume" data-testid="activate-bar-resume" onClick={() => resumeDownloadQueue()}>
                <Play />
                Resume
              </Button>
            ) : (
              <Button size="sm" variant="ghost" className="h-7 px-2" aria-label="Pause" data-testid="activate-bar-pause" onClick={() => pauseDownloadQueue()}>
                <Pause />
                Pause
              </Button>
            )}
            <Button
              key="activate-bar-cancel"
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              /* 1.0.206z: visible label = UIA Name (WebView2 often ignores aria-label for Name);
                 cancelChromeA11y spreads unique id onto this real <button> (toast omits DOM id). */
              data-testid="activate-bar-cancel"
              {...cancelChromeA11y({
                showDocsCancelIdentity: docsChrome,
                restoring,
              })}
              onClick={() => cancelDownloadQueue()}
            >
              <X aria-hidden="true" />
              {cancelChromeVisibleLabel({
                showDocsCancelIdentity: docsChrome,
                restoring,
              })}
            </Button>
          </>
        ) : null}
        {!job.running && !job.paused && job.failedNames.length ? (
          <>
            <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => void retryFailedDownloads()}>
              Retry
            </Button>
            <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => void skipFailedDownloads()}>
              Skip
            </Button>
          </>
        ) : null}
      </div>
      <div
        className="fm-job-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={shownPct}
        aria-label={job.paused ? `Paused at ${shownPct} percent` : `${shownPct} percent complete`}
      >
        <div
          className={job.paused ? "fm-job-fill fm-job-fill-paused" : "fm-job-fill"}
          style={{ width: `${shownPct}%` }}
        />
      </div>
    </div>
  );
}
