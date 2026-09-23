import { Settings } from "lucide-react";
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
import { useFontStore } from "@/lib/fonts/store";
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
        <Button size="icon-sm" variant="ghost" aria-label="Desktop settings">
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
                aria-pressed={density === opt.id}
                title={opt.hint}
                onClick={() => setDensity(opt.id)}
              >
                {opt.label}
              </Button>
            ))}
          </div>
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
