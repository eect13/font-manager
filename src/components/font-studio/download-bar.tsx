import { useSyncExternalStore } from "react";
import { FolderOpen, LoaderCircle, Pause, Play, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  cancelDownloadQueue,
  getDownloadJob,
  openActivatedFolder,
  pauseDownloadQueue,
  resumeDownloadQueue,
  retryFailedDownloads,
  skipFailedDownloads,
  subscribeDownloadJob,
} from "@/lib/fonts/os-activate";

export function DownloadBar() {
  const job = useSyncExternalStore(subscribeDownloadJob, getDownloadJob, getDownloadJob);
  const skipped = job.skipped ?? 0;
  const n = job.done + job.failed;
  const remaining = Math.max(0, job.total - n);
  const empty =
    job.running &&
    job.total === 0 &&
    skipped === 0 &&
    n === 0 &&
    !job.failedNames.length &&
    !job.paused;
  if ((!job.running && !job.paused && job.mode === "idle" && !job.failedNames.length) || empty) {
    return null;
  }
  const scanning = /scanning/i.test(job.current);
  const registering = /registering/i.test(job.current);
  const label =
    job.mode === "remove"
      ? `Deactivating ${n.toLocaleString()} / ${job.total.toLocaleString()}`
      : job.failed && !job.running && !job.paused
        ? `${job.failed.toLocaleString()} failed — retry or skip`
        : job.paused
          ? `Paused ${n.toLocaleString()} / ${job.total.toLocaleString()}`
          : scanning
            ? `Scanning Documents${job.total ? ` — ${job.total.toLocaleString()} queued` : ""}`
            : registering && job.running
              ? skipped || n || job.total
                ? `Registering ${(skipped || n || job.total).toLocaleString()} already on disk`
                : "Checking files on disk"
              : skipped && remaining === 0 && job.running
                ? `Registering ${skipped.toLocaleString()} already on disk`
                : skipped && job.running
                  ? `${skipped.toLocaleString()} on disk · downloading ${Math.max(0, n - skipped).toLocaleString()} / ${Math.max(0, job.total - skipped).toLocaleString()}`
                  : job.running
                    ? `Downloading ${n.toLocaleString()} / ${job.total.toLocaleString()}`
                    : skipped && remaining === 0
                      ? `${skipped.toLocaleString()} already on disk`
                      : `Downloading ${n.toLocaleString()} / ${job.total.toLocaleString()}`;

  return (
    <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-1.5 text-xs text-muted-foreground">
      {job.running && !job.paused ? <LoaderCircle className="size-3.5 shrink-0 animate-spin" /> : null}
      <p className="min-w-0 flex-1 truncate">
        <span className="font-medium text-foreground">{label}</span>
        {job.current ? ` — ${job.current}` : ""}
        {job.failedNames.length ? (
          <span className="block truncate text-destructive">
            Couldn’t load: {job.failedNames.slice(0, 8).join(", ")}
            {job.failedNames.length > 8 ? ` +${job.failedNames.length - 8}` : ""}. Retry, Skip, or Delete files and Activate again.
          </span>
        ) : null}
        <span className="text-muted-foreground">
          {job.paused
            ? " · queue held, files already on disk are skipped"
            : scanning
              ? " · checking Documents, not downloading yet"
              : registering
                ? " · intact files register only — no fetch"
                : remaining === 0 && skipped
                  ? " · nothing to fetch"
                  : " · skip intact, download only missing or corrupt"}
        </span>
      </p>
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
            Stop
          </Button>
        </>
      ) : job.failedNames.length ? (
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
  );
}