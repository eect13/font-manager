// Card 20: loading /duplicates directly must not write store state before
// rehydrate (review 1 issue 1 — persist saved unhydrated defaults over the
// user's favorites, activated and collections).
// Behaviour test: runs DuplicateFinder's auto-hide effect body with stubs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "src/components/font-studio/duplicate-finder.tsx"), "utf8");
const at = src.indexOf("useEffect(() => {", src.indexOf("useEffect(() => {") + 1);
const end = src.indexOf("}, [", at);
const body = src.slice(at + "useEffect(() => {".length, end);
const deps = src.slice(end + 3, src.indexOf("]", end) + 1);

function run({ hydrated, autoHide, groups }) {
  const writes = [];
  const useFontStore = {
    setState: (patch) => writes.push(patch),
    getState: () => ({ setActivatedMany: (ids, on) => writes.push({ setActivatedMany: [ids, on] }) }),
  };
  const hideIdsFromDuplicateGroups = (g) => g.flatMap((x) => x.hide);
  new Function(
    "useFontStore",
    "hideIdsFromDuplicateGroups",
    "hydrated",
    "autoHide",
    "groups",
    body,
  )(useFontStore, hideIdsFromDuplicateGroups, hydrated, autoHide, groups);
  return writes;
}

test("auto-hide effect writes nothing before hydrate", () => {
  assert.deepEqual(run({ hydrated: false, autoHide: false, groups: [] }), []);
  assert.deepEqual(run({ hydrated: false, autoHide: true, groups: [{ hide: ["a"] }] }), []);
});

test("auto-hide effect still works after hydrate", () => {
  assert.deepEqual(run({ hydrated: true, autoHide: false, groups: [] }), [{ duplicateHideIds: [] }]);
  assert.deepEqual(run({ hydrated: true, autoHide: true, groups: [{ hide: ["a"] }] }), [
    { duplicateHideIds: ["a"] },
    { setActivatedMany: [["a"], false] },
  ]);
});

test("auto-hide effect re-runs when hydrated flips", () => {
  assert.match(deps, /\bhydrated\b/);
});
