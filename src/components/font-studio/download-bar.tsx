import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { FolderOpen, LoaderCircle, Pause, Play, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  cancelDownloadQueue,
  getDownloadJob,
  getJobClock,
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

export function DownloadBar() {
  const job = useSyncExternalStore(subscribeDownloadJob, getDownloadJob, getDownloadJob);
  const [, setTick] = useState(0);
  const holdPct = useRef(0);
  const skipped = job.skipped ?? 0;
  const processed = Math.max(job.done, skipped);
  const remaining = Math.max(0, job.total - processed);
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

  if ((!job.running && !job.paused && job.mode === "idle" && !job.failedNames.length) || empty) {
    holdPct.current = 0;
    return null;
  }
  const scanning = /scanning/i.test(job.current);
  const registering = /registering/i.test(job.current);
  const pct = job.total > 0 ? clampPct((100 * processed) / job.total) : job.paused ? holdPct.current : 0;
  if (pct > holdPct.current) holdPct.current = pct;
  const shownPct = job.paused ? Math.max(pct, holdPct.current) : pct;
  const clock = getJobClock();
  const eta = job.paused || scanning ? "" : etaLabel(remaining, clock.activeMs, Math.max(0, processed - skipped) || processed);
  const label =
    job.mode === "remove"
      ? `Deactivating ${processed.toLocaleString()} / ${job.total.toLocaleString()}`
      : job.failed && !job.running && !job.paused
        ? `${job.failed.toLocaleString()} failed — retry or skip`
        : job.paused
          ? `Paused ${shownPct}% · ${processed.toLocaleString()} / ${job.total.toLocaleString()}`
          : scanning
            ? `Scanning Documents${job.total ? ` — ${job.total.toLocaleString()} queued` : ""}`
            : registering && job.running
              ? skipped || processed || job.total
                ? `Registering ${(skipped || processed || job.total).toLocaleString()} already on disk`
                : "Checking files on disk"
              : skipped && remaining === 0 && job.running
                ? `Registering ${skipped.toLocaleString()} already on disk`
                : skipped && job.running
                  ? `${skipped.toLocaleString()} on disk · downloading ${Math.max(0, processed - skipped).toLocaleString()} / ${Math.max(0, job.total - skipped).toLocaleString()}`
                  : job.running
                    ? `Downloading ${processed.toLocaleString()} / ${job.total.toLocaleString()}`
                    : skipped && remaining === 0
                      ? `${skipped.toLocaleString()} already on disk`
                      : `Downloading ${processed.toLocaleString()} / ${job.total.toLocaleString()}`;

  return (
    <div className="flex flex-col gap-1.5 border-b border-border bg-card px-3 py-1.5 text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        {job.running && !job.paused ? <LoaderCircle className="size-3.5 shrink-0 animate-spin" /> : null}
        <p className="min-w-0 flex-1 truncate">
          <span className="font-medium text-foreground">{label}</span>
          {job.current && !scanning ? ` — ${job.current}` : ""}
          {job.failedNames.length ? (
            <span className="block truncate text-destructive">
              Couldn’t load: {job.failedNames.slice(0, 8).join(", ")}
              {job.failedNames.length > 8 ? ` +${job.failedNames.length - 8}` : ""}. Retry, Skip, or Delete files and Activate again.
            </span>
          ) : null}
          <span className="text-muted-foreground">
            {job.paused
              ? " · queue held at this percent — Resume continues, does not restart"
              : scanning
                ? " · checking Documents, not downloading yet"
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
        {job.running || job.paused ? (
          <>
            {job.paused ? (
              <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => resumeDownloadQueue()}>
                <Play />
                Resume
              </Button>
            ) : (
              <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => pauseDownloadQueue()}>
                <Pause />
                Pause
              </Button>
            )}
            <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => cancelDownloadQueue()}>
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
