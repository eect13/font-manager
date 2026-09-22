import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  resolveActivateConfirm,
  subscribeActivateConfirm,
  type ActivateConfirmRequest,
} from "@/lib/fonts/activate-confirm";

/** In-app modal: OK=all / Cancel=keep prefer if wave0 queued else visible/first-page / Abort. */
export function ActivateConfirmDialog() {
  const [req, setReq] = useState<ActivateConfirmRequest | null>(null);
  useEffect(() => subscribeActivateConfirm(setReq), []);

  const open = Boolean(req);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && req) resolveActivateConfirm("abort");
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Activate {req?.total.toLocaleString() ?? ""} in {req?.label ?? ""}?</DialogTitle>
          <DialogDescription>
            {req?.etaHint ?? ""} Word/Adobe stay honest (Add&gt;0 only).
            {req && req.preferCount > 0
              ? ` First ${req.preferCount.toLocaleString()} (visible/selected/recent) already queued.`
              : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => resolveActivateConfirm("abort")}>
            Abort
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={!req || (req.preferCount < 1 && req.cancelCount < 1)}
            onClick={() => resolveActivateConfirm("cancel")}
          >
            {req && req.preferCount > 0
              ? `Cancel = keep first ${req.preferCount.toLocaleString()} (already queued)`
              : req && req.visibleCount > 0
                ? `Cancel = visible (${req.cancelCount.toLocaleString()})`
                : `Cancel = first page / selection (${req?.cancelCount.toLocaleString() ?? 0})`}
          </Button>
          <Button type="button" onClick={() => resolveActivateConfirm("ok")}>
            OK = all {req?.total.toLocaleString() ?? ""}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
