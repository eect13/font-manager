/// <reference lib="webworker" />
import { parseFontCollectionFromBuffer } from "./parse-font";

type Req = { id: number; name: string; size: number; buffer: ArrayBuffer };

self.onmessage = async (ev: MessageEvent<Req>) => {
  const { id, name, size, buffer } = ev.data;
  try {
    const faces = await parseFontCollectionFromBuffer(name, size, buffer);
    const transfer = faces.map((face) => face.buffer).filter((buf) => buf.byteLength > 0);
    (self as DedicatedWorkerGlobalScope).postMessage({ id, ok: true, faces }, transfer);
  } catch {
    (self as DedicatedWorkerGlobalScope).postMessage({ id, ok: false });
  }
};
