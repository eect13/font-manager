import { RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useFontStore } from "@/lib/fonts/store";

export function UploadsResetDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const count = useFontStore((s) => s.localFonts.length);
  const clearLocalFonts = useFontStore((s) => s.clearLocalFonts);
  const resetLibrary = useFontStore((s) => s.resetLibrary);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Uploaded fonts</DialogTitle>
          <DialogDescription>
            {count
              ? `${count.toLocaleString()} uploaded typeface${count === 1 ? "" : "s"} in this library. Fontsource families are not affected.`
              : "No uploaded typefaces. Reset still restores default activations."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={async () => {
              const n = await resetLibrary();
              onOpenChange(false);
              toast.success(
                n
                  ? `Library reset. ${n.toLocaleString()} upload${n === 1 ? "" : "s"} removed.`
                  : "Library reset.",
              );
            }}
          >
            <RotateCcw className="size-3.5" />
            Reset library
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={!count}
            onClick={async () => {
              const n = await clearLocalFonts();
              onOpenChange(false);
              toast.success(`Removed ${n.toLocaleString()} uploaded typeface${n === 1 ? "" : "s"}`);
            }}
          >
            <Trash2 className="size-3.5" />
            Clear uploads
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
