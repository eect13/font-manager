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

export function DesktopSettings() {
  const prefs = useFontStore((s) => s.desktopPrefs);
  const setDesktopPrefs = useFontStore((s) => s.setDesktopPrefs);

  useEffect(() => {
    void applyDesktopPrefs(prefs);
  }, [prefs.closeToTray, prefs.startWithWindows]);

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
            Tray and Windows startup. Quit from the tray still unloads session fonts so Word drops them.
          </DialogDescription>
        </DialogHeader>
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
