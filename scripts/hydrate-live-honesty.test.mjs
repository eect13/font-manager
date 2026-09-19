import assert from "node:assert/strict";
import test from "node:test";

/**
 * 1.0.176 hydrate live honesty:
 * - Activated after boot = this-process GDI (result.ready ∪ bootReady)
 * - 1.0.190: boot.ready chunks are live before boot.done (progressive hydrate)
 * - last-session sidecar is live only after session_begin pruned (bootDone) when boot.ready empty
 * - onDisk (files in Documents) is NOT live
 * - Gidugu is live only when boot.ready includes it (GDI Add after Debg sanitize / 2015 pin)
 * - skipFailed never nuclear-clears pending when names match no ids
 */

function hydrateLiveIds({ wantIds, fonts, ready, onDisk, sessionNames, bootReady, bootDone }) {
  const allow = new Set();
  for (const n of ready) allow.add(n.trim().toLowerCase());
  // 1.0.190: boot.ready (this-process Add) is live even before boot.done.
  // Sidecar sessionNames only after boot.done when boot.ready is empty.
  const sessionLive = bootReady?.length
    ? bootReady
    : bootDone
      ? sessionNames
      : [];
  for (const n of sessionLive) allow.add(n.trim().toLowerCase());
  const live = [];
  const seen = new Set();
  const byId = new Map(fonts.map((f) => [f.id, f]));
  const consider = (id) => {
    if (seen.has(id)) return;
    const font = byId.get(id);
    if (!font) {
      if (id.startsWith("g:")) {
        const name = id.slice(2).trim().toLowerCase();
        if (allow.has(name)) {
          seen.add(id);
          live.push(id);
        }
      }
      return;
    }
    if (allow.has(font.family.toLowerCase())) {
      seen.add(id);
      live.push(id);
    }
  };
  for (const id of wantIds) consider(id);
  const byFamily = new Map(fonts.map((f) => [f.family.toLowerCase(), f.id]));
  for (const name of sessionLive) {
    const key = name.trim().toLowerCase();
    if (!allow.has(key)) continue;
    consider(byFamily.get(key) ?? `g:${name.trim()}`);
  }
  void onDisk;
  return live;
}

function skipFailedPendingIds(failedNames, fonts, pending) {
  const drop = new Set(failedNames.map((n) => n.trim().toLowerCase()));
  const ids = fonts.filter((font) => drop.has(font.family.toLowerCase())).map((font) => font.id);
  if (!ids.length) return pending.slice();
  const dropIds = new Set(ids);
  return pending.filter((id) => !dropIds.has(id));
}

const fonts = [
  { id: "g:Nunito", family: "Nunito", source: "google" },
  { id: "l:Upload", family: "My Upload", source: "local" },
  { id: "g:42dot Sans", family: "42dot Sans", source: "google" },
  { id: "g:Gidugu", family: "Gidugu", source: "google" },
];

test("hydrate live: onDisk + persist local are not Activated without GDI", () => {
  const live = hydrateLiveIds({
    wantIds: ["g:Nunito", "l:Upload", "g:42dot Sans"],
    fonts,
    ready: ["Nunito"],
    onDisk: ["Nunito", "42dot Sans", "My Upload"],
    sessionNames: ["Nunito"],
    bootReady: ["Nunito"],
    bootDone: true,
  });
  assert.deepEqual(live, ["g:Nunito"]);
});

test("hydrate live: boot.ready stays live even if JS re-register returns []", () => {
  const live = hydrateLiveIds({
    wantIds: ["g:Nunito", "l:Upload"],
    fonts,
    ready: [],
    onDisk: ["Nunito", "My Upload"],
    sessionNames: ["Nunito", "My Upload"],
    bootReady: ["Nunito", "My Upload"],
    bootDone: true,
  });
  assert.equal(live.includes("g:Nunito"), true);
  assert.equal(live.includes("l:Upload"), true);
});

test("hydrate live: session family not in persist still marked from boot.ready", () => {
  const live = hydrateLiveIds({
    wantIds: [],
    fonts,
    ready: [],
    onDisk: ["Nunito"],
    sessionNames: ["Nunito"],
    bootReady: ["Nunito"],
    bootDone: true,
  });
  assert.deepEqual(live, ["g:Nunito"]);
});

test("hydrate live: last-session sidecar before boot prune is not live", () => {
  const live = hydrateLiveIds({
    wantIds: ["g:Nunito", "g:Gidugu"],
    fonts,
    ready: [],
    onDisk: ["Nunito", "Gidugu"],
    sessionNames: ["Nunito", "Gidugu"],
    bootReady: [],
    bootDone: false,
  });
  assert.deepEqual(live, []);
});

test("1.0.190 progressive: boot.ready before boot.done marks Live (not sidecar)", () => {
  const live = hydrateLiveIds({
    wantIds: ["g:Nunito", "g:Gidugu"],
    fonts,
    ready: [],
    onDisk: ["Nunito", "Gidugu"],
    sessionNames: ["Nunito", "Gidugu"],
    bootReady: ["Nunito"],
    bootDone: false,
  });
  assert.deepEqual(live, ["g:Nunito"]);
  assert.equal(live.includes("g:Gidugu"), false);
});

test("hydrate live: Gidugu not Activated unless this-process boot.ready (Add succeeded)", () => {
  const live = hydrateLiveIds({
    wantIds: ["g:Nunito", "g:Gidugu"],
    fonts,
    ready: ["Nunito"],
    onDisk: ["Nunito", "Gidugu"],
    sessionNames: ["Nunito"],
    bootReady: ["Nunito"],
    bootDone: true,
  });
  assert.deepEqual(live, ["g:Nunito"]);
  assert.equal(live.includes("g:Gidugu"), false);
});

test("hydrate live: Gidugu is live when boot.ready includes it (GDI Add worked)", () => {
  const live = hydrateLiveIds({
    wantIds: ["g:Nunito", "g:Gidugu"],
    fonts,
    ready: ["Nunito", "Gidugu"],
    onDisk: ["Nunito", "Gidugu"],
    sessionNames: ["Nunito", "Gidugu"],
    bootReady: ["Nunito", "Gidugu"],
    bootDone: true,
  });
  assert.deepEqual(live, ["g:Nunito", "g:Gidugu"]);
});

test("skipFailed: unmatched names do not wipe pending", () => {
  const pending = ["g:Nunito", "l:Upload", "g:42dot Sans"];
  const next = skipFailedPendingIds(["Not In Catalog"], fonts, pending);
  assert.deepEqual(next, pending);
});

test("skipFailed: matched names drop only those ids", () => {
  const pending = ["g:Nunito", "l:Upload", "g:42dot Sans"];
  const next = skipFailedPendingIds(["Nunito"], fonts, pending);
  assert.deepEqual(next, ["l:Upload", "g:42dot Sans"]);
});
