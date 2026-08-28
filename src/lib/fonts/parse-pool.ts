import type { ParsedLocalFont } from "./parse-font";

type Ok = { ok: true; file: File; faces: ParsedLocalFont[] };
type Fail = { ok: false; file: File };
export type ParsedBatchItem = Ok | Fail;

let worker: Worker | null = null;
let workerFailed = false;
let seq = 0;
const pending = new Map<number, { file: File; resolve: (item: ParsedBatchItem) => void }>();

function getWorker() {
  if (workerFailed || typeof Worker === "undefined") return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./parse.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (ev: MessageEvent<{ id: number; ok: boolean; faces?: ParsedLocalFont[] }>) => {
      const job = pending.get(ev.data.id);
      if (!job) return;
      pending.delete(ev.data.id);
      if (ev.data.ok && ev.data.faces?.length) {
        job.resolve({ ok: true, file: job.file, faces: ev.data.faces });
      } else {
        job.resolve({ ok: false, file: job.file });
      }
    };
    worker.onerror = () => {
      workerFailed = true;
      for (const job of pending.values()) job.resolve({ ok: false, file: job.file });
      pending.clear();
    };
    return worker;
  } catch {
    workerFailed = true;
    return null;
  }
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
  await Promise.all(Array.from({ length: Math.min(4, files.length) }, () => run()));
  return out;
}

export async function parseFilesPool(files: File[]): Promise<ParsedBatchItem[]> {
  if (!files.length) return [];
  const w = getWorker();
  if (!w) return parseOnMain(files);
  const limit = 2;
  const out: ParsedBatchItem[] = new Array(files.length);
  let cursor = 0;
  async function pump() {
    while (cursor < files.length) {
      const index = cursor;
      cursor += 1;
      const file = files[index]!;
      const id = ++seq;
      out[index] = await new Promise<ParsedBatchItem>((resolve) => {
        pending.set(id, { file, resolve });
        try {
          w!.postMessage({ id, file });
        } catch {
          pending.delete(id);
          resolve({ ok: false, file });
        }
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, files.length) }, () => pump()));
  if (out.some((item) => !item)) return parseOnMain(files);
  return out;
}
