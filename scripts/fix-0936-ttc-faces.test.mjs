// Card 36 item 3: a desktop TTC/OTC import keeps every face, each activatable.
import "./lib-ts-hooks.mjs";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildTtc, NOTO_LIKE_FACES } from "./ttc-fixture.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");
const { parseFontCollectionFromBuffer } = await import("../src/lib/fonts/parse-font.ts");
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

test("generated 10-face TTC parses to 10 standalone faces with distinct keys", async () => {
  const ttc = buildTtc(NOTO_LIKE_FACES);
  assert.ok(ttc.length < 16_000, `fixture stays small: ${ttc.length}`);
  const faces = await parseFontCollectionFromBuffer("Fixture-Regular.ttc", ttc.length, ab(ttc));
  assert.equal(faces.length, 10);
  assert.equal(new Set(faces.map((f) => f.checksum)).size, 10);
  assert.equal(new Set(faces.map((f) => f.fileName)).size, 10);
  for (const [i, f] of faces.entries()) {
    assert.equal(f.family, NOTO_LIKE_FACES[i].family);
    const again = await parseFontCollectionFromBuffer(f.fileName, f.buffer.byteLength, f.buffer);
    assert.equal(again.length, 1, "each face is a standalone SFNT");
    assert.equal(again[0].family, f.family);
  }
});

test("the desktop file picker accepts .otc", () => {
  assert.match(read("src/lib/desktop/open-fonts.ts"), /FONT_EXT = \[[^\]]*"otc"/);
});

test("import saves every face to Documents (per-face key, not the TTC file name)", () => {
  const store = read("src/lib/fonts/store.ts");
  assert.doesNotMatch(store, /savedDisk\.has\(file\.name\)/);
  assert.match(store, /savedDisk\.has\(diskKey\)/);
});

test("activating a second face of the same family is not skipped by the family cache", () => {
  const os = read("src/lib/fonts/os-activate.ts");
  const at = os.indexOf("async function installOne(");
  const body = os.slice(at, os.indexOf("\n}\n", at));
  assert.doesNotMatch(body, /^\s*if \(cacheHas\(font\.family\)\) return;/m);
});

test("watch-folder: native index keys each collection face and replaces all faces of a changed file", () => {
  const rust = read("src-tauri/src/parse.rs");
  assert.match(rust, /rename = "faceIndex"/);
  const watch = read("src/lib/fonts/watch-folder.ts");
  assert.doesNotMatch(watch, /new Map\(known\.map\(\(f\) => \[norm\(f\.originPath!\), f\]\)\)/);
});

const noto = process.env.FM_NOTO_TTC;
test("real Noto Sans CJK TTC: 10 faces (set FM_NOTO_TTC)", { skip: !noto || !existsSync(noto) }, async () => {
  const b = readFileSync(noto);
  const faces = await parseFontCollectionFromBuffer("NotoSansCJK-Regular.ttc", b.length, ab(b));
  assert.equal(faces.length, 10);
  assert.equal(new Set(faces.map((f) => f.family)).size, 10);
  assert.equal(new Set(faces.map((f) => f.fileName)).size, 10);
  assert.ok(faces.every((f) => /\.otf$/.test(f.fileName)), "CFF faces are saved as .otf");
});
