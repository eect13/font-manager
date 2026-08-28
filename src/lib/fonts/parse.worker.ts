/// <reference lib="webworker" />
import { parseFontCollection } from "./parse-font";

type Req = { id: number; file: File };

self.onmessage = async (ev: MessageEvent<Req>) => {
  const { id, file } = ev.data;
  try {
    const faces = await parseFontCollection(file);
    const transfer = faces.map((face) => face.buffer);
    (self as DedicatedWorkerGlobalScope).postMessage({ id, ok: true, faces }, transfer);
  } catch {
    (self as DedicatedWorkerGlobalScope).postMessage({ id, ok: false });
  }
};
