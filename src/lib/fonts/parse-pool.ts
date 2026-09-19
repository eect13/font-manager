import type { ParsedLocalFont } from "./parse-font";
import { parseWorkerCount } from "./wasm-parse";

/** Parse this many files before dropping buffers + committing to the library. 20k RAM bound. */
export const PARSE_WAVE = 256;

type Ok = { ok: true; file: File; faces: ParsedLocalFont[] };
type Fail = { ok: false; file: File };
export type ParsedBatchItem = Ok | Fail;

type WorkerJob = { id: number; file: File; resolve: (item: ParsedBatchItem) => void };

type ParseWorker = {
  worker: Worker;
  pending: Map<number, WorkerJob>;
  inflight: number;
};

const pool: ParseWorker[] = [];
let seq = 0;
let poolFailed = false;

function attachWorker(worker: Worker): ParseWorker {
  const slot: ParseWorker = { worker, pending: new Map(), inflight: 0 };
  worker.onmessage = (ev: MessageEvent<{ id: number; ok: boolean; faces?: ParsedLocalFont[] }>) => {
    const job = slot.pending.get(ev.data.id);
    if (!job) return;
    slot.pending.delete(ev.data.id);
    slot.inflight = Math.max(0, slot.inflight - 1);
    if (ev.data.ok && ev.data.faces?.length) {
      job.resolve({ ok: true, file: job.file, faces: ev.data.faces });
    } else {
      job.resolve({ ok: false, file: job.file });
    }
  };
  worker.onerror = () => {
    worker.terminate();
    const idx = pool.indexOf(slot);
    if (idx >= 0) pool.splice(idx, 1);
    for (const job of slot.pending.values()) job.resolve({ ok: false, file: job.file });
    slot.pending.clear();
    if (!pool.length) poolFailed = true;
  };
  return slot;
}

function getPool(): ParseWorker[] | null {
  if (poolFailed || typeof Worker === "undefined") return null;
  if (pool.length) return pool;
  const n = parseWorkerCount();
  try {
    for (let i = 0; i < n; i += 1) {
      const worker = new Worker(new URL("./parse.worker.ts", import.meta.url), { type: "module" });
      pool.push(attachWorker(worker));
    }
    return pool.length ? pool : null;
  } catch {
    poolFailed = true;
    return null;
  }
}

function nextSlot(slots: ParseWorker[]): ParseWorker {
  let best = slots[0]!;
  for (const slot of slots) {
    if (slot.inflight < best.inflight) best = slot;
  }
  return best;
}

async function parseOnMain(files: File[]): Promise<ParsedBatchItem[]> {
  const { parseFontCollection } = await import("./parse-font");
  const out: ParsedBatchItem[] = new Array(files.length);
  let cursor = 0;
  async function run() {
    while (cursor < files.length) {
      const index = cursor;
      cursor += 1;
      const file = files[index]!;
      try {
        const faces = await parseFontCollection(file);
        out[index] = { ok: true, file, faces };
      } catch {
        out[index] = { ok: false, file };
      }
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  await Promise.all(Array.from({ length: Math.min(parseWorkerCount(), files.length) }, () => run()));
  return out;
}

export async function parseFilesPool(files: File[]): Promise<ParsedBatchItem[]> {
  if (!files.length) return [];
  const slots = getPool();
  if (!slots) return parseOnMain(files);
  const out: ParsedBatchItem[] = new Array(files.length);
  let cursor = 0;
  async function pump() {
    while (cursor < files.length) {
      const index = cursor;
      cursor += 1;
      const file = files[index]!;
      const id = ++seq;
      const slot = nextSlot(slots!);
      out[index] = await new Promise<ParsedBatchItem>((resolve) => {
        slot.pending.set(id, { id, file, resolve });
        slot.inflight += 1;
        void file
          .arrayBuffer()
          .then((buffer) => {
            try {
              slot.worker.postMessage({ id, name: file.name, size: file.size, buffer }, [buffer]);
            } catch {
              slot.pending.delete(id);
              slot.inflight = Math.max(0, slot.inflight - 1);
              resolve({ ok: false, file });
            }
          })
          .catch(() => {
            slot.pending.delete(id);
            slot.inflight = Math.max(0, slot.inflight - 1);
            resolve({ ok: false, file });
          });
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(slots.length, files.length) }, () => pump()));
  if (out.some((item) => !item)) return parseOnMain(files);
  return out;
}
