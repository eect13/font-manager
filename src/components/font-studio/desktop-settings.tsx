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
    { id: "compact", label: "Compact", hint: "Tighter library, sidebar, toolbar, and inspector" },
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
        <div className="grid gap-2 rounded-md bg-secondary px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-sm font-medium">Density</p>
            <p className="text-xs text-muted-foreground">
              Comfortable or Compact for library grid/list, sidebar, preview toolbar, and inspector. Saved on this device.
            </p>
          </div>
          <div className="flex flex-wrap gap-2" role="group" aria-label="UI density">
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
        <label className="flex items-center justify-between gap-3 rounded-md bg-secondary px-3 py-2.5 text-sm">
          Close to tray
          <Switch
            checked={prefs.closeToTray}
            onCheckedChange={(on) => setDesktopPrefs({ closeToTray: on })}
          />
        </label>
        <p className="px-1 text-xs text-muted-foreground">
          X hides the window. Fonts stay live in Word until you Quit from the tray.
        </p>
        <label className="flex items-center justify-between gap-3 rounded-md bg-secondary px-3 py-2.5 text-sm">
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
