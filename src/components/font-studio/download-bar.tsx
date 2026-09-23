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
  const holdPct = useRef(0);
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

  if ((!job.running && !job.paused && job.mode === "idle" && (job.owner === "idle" || !job.owner) && !job.failedNames.length && !settledIdle) || empty) {
    holdPct.current = 0;
    return null;
  }
  const scanning = /scanning/i.test(job.current);
  const registering = job.mode === "register" || job.owner === "register" || /registering/i.test(job.current);
  // 1.0.190: calm Restoring N/T — not download hang chrome.
  const restoring = /restoring/i.test(job.current);
  // 1.0.206w amend: sticky docs ownership only — never bare "scanning documents" (Activate shares it).
  const docsSync = isDocsVfSyncJob();
  const pct = job.total > 0 || job.done > 0 ? clampPct((100 * processed) / total) : job.paused ? holdPct.current : 0;
  if (pct > holdPct.current) holdPct.current = pct;
  const shownPct = job.paused ? Math.max(pct, holdPct.current) : pct;
  const clock = getJobClock();
  const eta = job.paused || scanning || restoring || docsSync || settledIdle ? "" : etaLabel(remaining, clock.activeMs, Math.max(0, processed - skipped) || processed);
  const label =
    settledIdle
      ? "Done"
      : job.mode === "remove"
        ? `Deactivating ${processed.toLocaleString()} / ${total.toLocaleString()}`
        : job.failed && !job.running && !job.paused
          ? `${job.failed.toLocaleString()} failed — retry or skip`
          : job.paused
            ? `Paused ${shownPct}% · ${processed.toLocaleString()} / ${total.toLocaleString()}`
            : scanning || (docsSync && /scanning/i.test(job.current))
              ? `Scanning Documents${total ? ` — ${total.toLocaleString()} queued` : ""}`
              : docsSync && job.running
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
          {job.current && !scanning && !restoring && !docsSync && !settledIdle ? ` — ${job.current}` : ""}
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
            {settledIdle
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
          aria-live="polite"
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
        {job.running || job.paused ? (
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
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              /* 1.0.206w: stable Name for UIA — docs vs restore vs download; keep activate-bar-cancel. */
              aria-label={docsSync ? "Cancel Documents refresh" : restoring ? "Cancel session restore" : "Cancel"}
              data-testid="activate-bar-cancel"
              data-docs-cancel={docsSync ? "activate-bar-cancel-docs" : undefined}
              data-cancel-kind={docsSync ? "documents-refresh" : restoring ? "session-restore" : "download"}
              id={docsSync ? "fm-cancel-documents-refresh" : restoring ? "fm-cancel-session-restore" : undefined}
              onClick={() => cancelDownloadQueue()}
            >
              <X />
              Cancel
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
