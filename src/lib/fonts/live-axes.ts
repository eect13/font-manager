import { useCallback, useSyncExternalStore } from "react";

type AxisMap = Record<string, Record<string, number>>;

let live: AxisMap = {};
const listeners = new Set<() => void>();
let persistTimer: ReturnType<typeof setTimeout> | undefined;
let persistFn: ((axes: AxisMap) => void) | null = null;

function emit() {
  for (const fn of listeners) fn();
}

function flushPersist() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = undefined;
  }
  persistFn?.(live);
}

export function bindAxesPersist(fn: (axes: AxisMap) => void) {
  persistFn = fn;
}

export function hydrateLiveAxes(saved: AxisMap | undefined) {
  live = saved && typeof saved === "object" ? { ...saved } : {};
  emit();
}

export function getLiveAxes(id: string) {
  return live[id];
}

export function subscribeLiveAxes(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  return () => listeners.delete(onStoreChange);
}

export function setLiveAxis(id: string, tag: string, value: number) {
  const prev = live[id];
  if (prev?.[tag] === value) return;
  live = { ...live, [id]: { ...prev, [tag]: value } };
  emit();
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(flushPersist, 400);
}

export function useLiveAxes(id: string | null | undefined) {
  const get = useCallback(() => (id ? live[id] : undefined), [id]);
  return useSyncExternalStore(subscribeLiveAxes, get, get);
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushPersist);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPersist();
  });
}
