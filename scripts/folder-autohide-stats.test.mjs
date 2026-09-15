import assert from "node:assert/strict";
import test from "node:test";

/** Mirror of src/lib/fonts/store.ts folderFontStats + folderStatsWithAutoHide */
function folderFontStats(collections) {
  const byParent = new Map();
  const byId = new Map();
  for (const c of collections) {
    byId.set(c.id, c);
    const parent = c.parentId ?? null;
    const list = byParent.get(parent) ?? [];
    list.push(c);
    byParent.set(parent, list);
  }
  const map = new Map();
  const walk = (folderId) => {
    const cached = map.get(folderId);
    if (cached) return cached.ids;
    const col = byId.get(folderId);
    if (!col) return [];
    const ids = new Set(col.fontIds);
    for (const child of byParent.get(folderId) ?? []) {
      for (const fontId of walk(child.id)) ids.add(fontId);
    }
    const list = [...ids];
    map.set(folderId, { count: list.length, ids: list });
    return list;
  };
  const known = new Set(collections.map((c) => c.id));
  for (const c of collections) {
    if (!c.parentId || !known.has(c.parentId)) walk(c.id);
  }
  return map;
}

function folderStatsWithAutoHide(collections, hideDupIds) {
  const raw = folderFontStats(collections);
  if (!hideDupIds.length) return raw;
  const hide = new Set(hideDupIds);
  const next = new Map();
  for (const [id, stat] of raw) {
    const ids = stat.ids.filter((fid) => !hide.has(fid));
    next.set(id, { count: ids.length, ids });
  }
  return next;
}

test("Folders and Collections share auto-hide counts", () => {
  const collections = [
    { id: "c1", parentId: null, watchPath: undefined, fontIds: ["g:nunito", "l:nunito"] },
    { id: "f1", parentId: null, watchPath: "D:/Fonts", fontIds: ["l:nunito", "l:other"] },
  ];
  const hide = ["l:nunito"];
  const stats = folderStatsWithAutoHide(collections, hide);
  assert.equal(stats.get("c1").count, 1);
  assert.deepEqual(stats.get("c1").ids, ["g:nunito"]);
  assert.equal(stats.get("f1").count, 1);
  assert.deepEqual(stats.get("f1").ids, ["l:other"]);
});

test("auto-hide off keeps full folder counts", () => {
  const collections = [
    { id: "f1", parentId: null, watchPath: "D:/Fonts", fontIds: ["l:a", "l:b"] },
  ];
  const stats = folderStatsWithAutoHide(collections, []);
  assert.equal(stats.get("f1").count, 2);
});
