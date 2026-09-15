import assert from "node:assert/strict";
import test from "node:test";

/**
 * 1.0.169 hydrate live honesty:
 * - Activated after boot = GDI-registered only (result.ready ∪ sessionNames)
 * - onDisk (files in Documents) is NOT live
 * - local source is NOT live just because persist.activated had it
 * - skipFailed never nuclear-clears pending when names match no ids
 */

function hydrateLiveIds({ wantIds, fonts, ready, onDisk, sessionNames }) {
  const allow = new Set();
  for (const n of ready) allow.add(n.trim().toLowerCase());
  for (const n of sessionNames) allow.add(n.trim().toLowerCase());
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
  for (const name of sessionNames) {
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
];

test("hydrate live: onDisk + persist local are not Activated without GDI", () => {
  const live = hydrateLiveIds({
    wantIds: ["g:Nunito", "l:Upload", "g:42dot Sans"],
    fonts,
    ready: ["Nunito"],
    onDisk: ["Nunito", "42dot Sans", "My Upload"],
    sessionNames: ["Nunito"],
  });
  assert.deepEqual(live, ["g:Nunito"]);
});

test("hydrate live: session_begin sidecar families stay live even if JS re-register returns []", () => {
  const live = hydrateLiveIds({
    wantIds: ["g:Nunito", "l:Upload"],
    fonts,
    ready: [],
    onDisk: ["Nunito", "My Upload"],
    sessionNames: ["Nunito", "My Upload"],
  });
  assert.equal(live.includes("g:Nunito"), true);
  assert.equal(live.includes("l:Upload"), true);
});

test("hydrate live: session family not in persist still marked", () => {
  const live = hydrateLiveIds({
    wantIds: [],
    fonts,
    ready: [],
    onDisk: ["Nunito"],
    sessionNames: ["Nunito"],
  });
  assert.deepEqual(live, ["g:Nunito"]);
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
