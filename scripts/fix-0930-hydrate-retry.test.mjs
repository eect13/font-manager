// Card 20 / N4: storage failures must not be silent.
// - hydrate.ts ran persist.rehydrate() once; zustand swallows a failed load,
//   the hook still flipped hydrated, and the next write saved defaults over
//   the library.
// Behaviour tests against the real modules and real zustand persist.
import assert from "node:assert/strict";
import test from "node:test";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { createPersistStorage } from "../src/lib/fonts/persist-storage.ts";
import { hydratePersistedStore } from "../src/lib/fonts/hydrate-steps.ts";

function domError(name, message = name) {
  const e = new Error(message);
  e.name = name;
  return e;
}

function memory({ failWrites } = {}) {
  const data = new Map();
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => {
      if (failWrites) throw failWrites();
      data.set(k, v);
    },
    removeItem: (k) => data.delete(k),
  };
}

function makeStore(ls) {
  let ready = false;
  const store = create(
    persist(
      (set) => ({
        favorites: [],
        hydrated: false,
        setHydrated: (v) => {
          if (v) ready = true;
          set({ hydrated: v });
        },
      }),
      {
        name: "fm",
        storage: createJSONStorage(() => createPersistStorage({ storage: () => ls, canWrite: () => ready, onWriteError: () => {}, delayMs: 0 })),
        skipHydration: true,
      },
    ),
  );
  return store;
}

const saved = JSON.stringify({ state: { favorites: ["g:Inter"] }, version: 0 });

test("a transient failed load is retried and the saved library survives", async () => {
  let calls = 0;
  const ls = memory();
  ls.data.set("fm", saved);
  const get = ls.getItem;
  ls.getItem = (k) => {
    calls += 1;
    if (calls === 1) throw domError("SecurityError", "transient");
    return get(k);
  };
  const store = makeStore(ls);
  const reports = [];
  const status = await hydratePersistedStore({
    loadCatalog: async () => {
      throw new Error("catalog idb down");
    },
    rehydrate: () => store.persist.rehydrate(),
    hasHydrated: () => store.persist.hasHydrated(),
    cancelled: () => false,
    report: (step, err) => reports.push([step, err.message]),
    retryDelayMs: 0,
  });
  assert.equal(status, "ok");
  assert.deepEqual(store.getState().favorites, ["g:Inter"]);
  assert.deepEqual(reports.map((r) => r[0]), ["catalog"]);
  store.getState().setHydrated(true);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(JSON.parse(ls.data.get("fm")).state.favorites, ["g:Inter"]);
});

test("a load that keeps failing is reported, and nothing overwrites the saved library", async () => {
  const ls = memory();
  ls.data.set("fm", "{not json");
  const store = makeStore(ls);
  const reports = [];
  const status = await hydratePersistedStore({
    loadCatalog: async () => true,
    rehydrate: () => store.persist.rehydrate(),
    hasHydrated: () => store.persist.hasHydrated(),
    cancelled: () => false,
    report: (step) => reports.push(step),
    retryDelayMs: 0,
  });
  assert.equal(status, "failed");
  assert.deepEqual(reports, ["library"]);
  // Caller keeps writes blocked on "failed" (store gate never opens).
  store.setState({ favorites: ["g:Lora"] });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ls.data.get("fm"), "{not json");
});

test("cancel stops hydration without reporting", async () => {
  const status = await hydratePersistedStore({
    loadCatalog: async () => true,
    rehydrate: async () => {},
    hasHydrated: () => true,
    cancelled: () => true,
    report: () => assert.fail("no report on cancel"),
  });
  assert.equal(status, "cancelled");
});
