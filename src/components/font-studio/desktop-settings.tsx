import { RefreshCw, Settings } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { applyDesktopPrefs } from "@/lib/desktop/prefs";
import { armDocsVfSyncOwnership, cancelDownloadQueue, didDocsVfSyncCancelToast, syncDocumentsVfPolicy, syncManagedDocumentsRoot } from "@/lib/fonts/os-activate";
import { docsCancelToastAction } from "@/lib/fonts/docs-cancel-toast-action";
import { useFontStore } from "@/lib/fonts/store";
import { toast } from "sonner";
import { useUiDensity, type UiDensity } from "@/lib/ui-density";

export function DesktopSettings() {
  const prefs = useFontStore((s) => s.desktopPrefs);
  const setDesktopPrefs = useFontStore((s) => s.setDesktopPrefs);
  const { density, setDensity } = useUiDensity();

  useEffect(() => {
    void applyDesktopPrefs(prefs);
  }, [prefs.closeToTray, prefs.startWithWindows]);

  const densityOpts: { id: UiDensity; label: string; hint: string }[] = [
    { id: "comfortable", label: "Comfortable", hint: "Default spacing — roomy cards and rows" },
    { id: "compact", label: "Compact", hint: "Tighter library, dialogs, empty panes, and settings" },
  ];

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label="Settings" data-testid="settings-open">
          <Settings />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Desktop</DialogTitle>
          <DialogDescription>
            Tray, Windows startup, and library density. Quit from the tray still unloads session fonts so Word drops them.
          </DialogDescription>
        </DialogHeader>
        <div className="fm-settings-stack fm-settings-row rounded-md bg-secondary">
          <div className="min-w-0">
            <p className="text-sm font-medium">Density</p>
            <p className="text-xs text-muted-foreground">
              Comfortable or Compact for library, dialogs, empty panes, and Desktop Settings rows. Saved on this device.
            </p>
          </div>
          <div className="fm-settings-opts flex flex-wrap" role="group" aria-label="UI density">
            {densityOpts.map((opt) => (
              <Button
                key={opt.id}
                type="button"
                size="sm"
                variant={density === opt.id ? "default" : "outline"}
                aria-label={opt.label}
                aria-pressed={density === opt.id}
                title={opt.hint}
                data-testid={`density-${opt.id}`}
                onClick={() => setDensity(opt.id)}
              >
                {opt.label}
              </Button>
            ))}
          </div>
        </div>

        <div className="fm-settings-stack fm-settings-row rounded-md bg-secondary">
          <div className="min-w-0">
            <p className="text-sm font-medium">Documents library</p>
            <p className="text-xs text-muted-foreground">
              Removes redundant statics when a variable font is present. Keeps static-only families. Does not download the full catalog.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label="Refresh Documents folder"
            data-testid="refresh-documents-settings"
            onClick={() => {
              void (async () => {
                armDocsVfSyncOwnership();
                toast.message("Refreshing Documents folder…", {
                  id: "sync-docs-vf",
                  description: "Cancel from the progress bar if needed.",
                  duration: 8_000,
                  action: docsCancelToastAction(),
                });
                const result = await syncDocumentsVfPolicy();
                if (!result) return;
                await syncManagedDocumentsRoot();
                if (result.cancelled) {
                  // 1.0.206w amend: skip if cancel already toasted; else toast on Rust cancelled.
                  if (!didDocsVfSyncCancelToast()) {
                    toast.message("Documents refresh cancelled", {
                      id: "sync-docs-vf",
                      description: `Checked ${result.familiesSeen.toLocaleString()} folders · removed ${result.staticsDeleted.toLocaleString()} statics before cancel.`,
                    });
                  }
                  return;
                }
                if (result.locked > 0) {
                  toast.error(
                    `${result.locked.toLocaleString()} face${result.locked === 1 ? "" : "s"} locked — deactivate fonts or quit Adobe/Word, then Repair`,
                    {
                      id: "sync-docs-vf-locked",
                      description:
                        "Illustrator, fontdrvhost, or another app is holding static TTFs during Refresh. Quit those apps (or Deactivate), then Refresh or Repair again.",
                      duration: 24_000,
                    },
                  );
                }
                toast.success(
                  `Documents refreshed — ${result.staticsDeleted.toLocaleString()} redundant statics removed`,
                  {
                    id: "sync-docs-vf",
                    description: `${result.familiesSeen.toLocaleString()} folders · ${result.familiesPurged.toLocaleString()} VF families updated${
                      result.locked
                        ? ` · ${result.locked.toLocaleString()} locked (Deactivate / quit Adobe, then Repair)`
                        : ""
                    }.`,
                    duration: 12_000,
                  },
                );
              })();
            }}
          >
            <RefreshCw className="size-3.5" />
            Refresh Documents
          </Button>
        </div>

        <label className="fm-settings-row flex items-center justify-between gap-3 rounded-md bg-secondary text-sm">
          Close to tray
          <Switch
            checked={prefs.closeToTray}
            onCheckedChange={(on) => setDesktopPrefs({ closeToTray: on })}
          />
        </label>
        <p className="px-1 text-xs text-muted-foreground">
          X hides the window. Fonts stay live in Word until you Quit from the tray.
        </p>
        <label className="fm-settings-row flex items-center justify-between gap-3 rounded-md bg-secondary text-sm">
          Start with Windows
          <Switch
            checked={prefs.startWithWindows}
            onCheckedChange={(on) => setDesktopPrefs({ startWithWindows: on })}
          />
        </label>
        <p className="px-1 text-xs text-muted-foreground">
          Adds a shortcut to the user Startup folder. Deactivate-on-quit is always on — this app does not leave GDI maps after the process exits.
        </p>
      </DialogContent>
    </Dialog>
  );
}
