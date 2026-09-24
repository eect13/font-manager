/**
 * In-app Activate All confirm (1.0.206e) — replaces window.confirm.
 * OK = all remainder / Cancel = keep prefer if wave0 queued, else visible/first-page / Abort = stop.
 */
export type ActivateConfirmChoice = "ok" | "cancel" | "abort";

export type ActivateConfirmRequest = {
  label: string;
  total: number;
  preferCount: number;
  remainderCount: number;
  visibleCount: number;
  cancelCount: number;
  /** Softened ETA copy — not a hard minute promise. */
  etaHint: string;
  resolve: (choice: ActivateConfirmChoice) => void;
};

type Listener = (req: ActivateConfirmRequest | null) => void;

let current: ActivateConfirmRequest | null = null;
const listeners = new Set<Listener>();

export function subscribeActivateConfirm(listener: Listener): () => void {
  listeners.add(listener);
  listener(current);
  return () => {
    listeners.delete(listener);
  };
}

function emit() {
  for (const l of listeners) l(current);
}

export function requestActivateConfirm(input: {
  label: string;
  total: number;
  preferCount: number;
  remainderCount: number;
  visibleCount: number;
  cancelCount: number;
  etaHint: string;
}): Promise<ActivateConfirmChoice> {
  return new Promise((resolve) => {
    if (current) {
      current.resolve("abort");
    }
    current = { ...input, resolve };
    emit();
  });
}

export function resolveActivateConfirm(choice: ActivateConfirmChoice) {
  const req = current;
  current = null;
  emit();
  req?.resolve(choice);
}
