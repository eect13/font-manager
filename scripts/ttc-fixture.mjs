// Test-time TTC builder (Card 36): packs N faces built from the 532-byte
// tests/fixtures/stat-overlay.ttf, each with its own name table. Nothing large is
// committed; a 10-face collection is ~6 KB and generated in memory.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function nameTable(family, subfamily = "Regular") {
  const recs = [
    [1, family],
    [2, subfamily],
    [4, subfamily === "Regular" ? family : `${family} ${subfamily}`],
  ];
  const strings = recs.map(([, s]) => Buffer.from(s, "utf16le").swap16());
  const head = Buffer.alloc(6 + 12 * recs.length);
  head.writeUInt16BE(0, 0);
  head.writeUInt16BE(recs.length, 2);
  head.writeUInt16BE(head.length, 4);
  let off = 0;
  recs.forEach(([id], i) => {
    const o = 6 + 12 * i;
    head.writeUInt16BE(3, o);
    head.writeUInt16BE(1, o + 2);
    head.writeUInt16BE(0x409, o + 4);
    head.writeUInt16BE(id, o + 6);
    head.writeUInt16BE(strings[i].length, o + 8);
    head.writeUInt16BE(off, o + 10);
    off += strings[i].length;
  });
  return Buffer.concat([head, ...strings]);
}

function baseTables() {
  const b = readFileSync(join(root, "tests/fixtures/stat-overlay.ttf"));
  const n = b.readUInt16BE(4);
  const tables = [];
  for (let i = 0; i < n; i++) {
    const o = 12 + 16 * i;
    const tag = b.subarray(o, o + 4).toString("latin1");
    const off = b.readUInt32BE(o + 8);
    const len = b.readUInt32BE(o + 12);
    tables.push({ tag, data: b.subarray(off, off + len) });
  }
  return { version: b.readUInt32BE(0), tables };
}

const pad4 = (n) => (n + 3) & ~3;

/** faces: [{ family, subfamily? }] → Buffer (ttcf, one table set per face). */
export function buildTtc(faces) {
  const base = baseTables();
  const perFace = faces.map((f) =>
    base.tables.map((t) => (t.tag === "name" ? { tag: "name", data: nameTable(f.family, f.subfamily) } : t)),
  );
  const headerLen = 12 + 4 * faces.length;
  let cursor = headerLen;
  const dirOffsets = perFace.map((tables) => {
    const at = cursor;
    cursor += 12 + 16 * tables.length;
    return at;
  });
  const dataOffsets = perFace.map((tables) =>
    tables.map((t) => {
      const at = cursor;
      cursor += pad4(t.data.length);
      return at;
    }),
  );
  const out = Buffer.alloc(cursor);
  out.write("ttcf", 0, "latin1");
  out.writeUInt32BE(0x00010000, 4);
  out.writeUInt32BE(faces.length, 8);
  perFace.forEach((tables, fi) => {
    out.writeUInt32BE(dirOffsets[fi], 12 + 4 * fi);
    const d = dirOffsets[fi];
    out.writeUInt32BE(base.version, d);
    out.writeUInt16BE(tables.length, d + 4);
    tables.forEach((t, ti) => {
      const r = d + 12 + 16 * ti;
      out.write(t.tag, r, "latin1");
      out.writeUInt32BE(dataOffsets[fi][ti], r + 8);
      out.writeUInt32BE(t.data.length, r + 12);
      t.data.copy(out, dataOffsets[fi][ti]);
    });
  });
  return out;
}

export const NOTO_LIKE_FACES = [
  ...["JP", "KR", "SC", "TC", "HK"].map((r) => ({ family: `Fixture Sans CJK ${r}` })),
  ...["JP", "KR", "SC"].map((r) => ({ family: `Fixture Sans Mono CJK ${r}` })),
  // Two faces of one family in the same collection (Regular + Bold).
  { family: "Fixture Shared", subfamily: "Regular" },
  { family: "Fixture Shared", subfamily: "Bold" },
];

/** cmap with a (3,1) format 4 subtable (BMP) and a (3,10) format 12 subtable. */
export function cmapTable(codepoints) {
  const cps = [...new Set(codepoints)].sort((a, b) => a - b);
  const runs = [];
  for (const cp of cps) {
    const last = runs[runs.length - 1];
    if (last && cp === last[1] + 1) last[1] = cp;
    else runs.push([cp, cp]);
  }
  let gid = 1;
  const groups = runs.map(([s, e]) => {
    const g = [s, e, gid];
    gid += e - s + 1;
    return g;
  });
  const bmp = groups.filter(([, e]) => e <= 0xfffe);
  const segs = [...bmp, [0xffff, 0xffff, 0]];
  const segX2 = segs.length * 2;
  const f4 = Buffer.alloc(16 + segs.length * 8);
  f4.writeUInt16BE(4, 0);
  f4.writeUInt16BE(f4.length, 2);
  f4.writeUInt16BE(segX2, 6);
  segs.forEach(([s, e, g], i) => {
    f4.writeUInt16BE(e, 14 + 2 * i);
    f4.writeUInt16BE(s, 16 + segX2 + 2 * i);
    const delta = s === 0xffff ? 1 : (g - s) & 0xffff;
    f4.writeUInt16BE(delta, 16 + 2 * segX2 + 2 * i);
    f4.writeUInt16BE(0, 16 + 3 * segX2 + 2 * i);
  });
  const f12 = Buffer.alloc(16 + groups.length * 12);
  f12.writeUInt16BE(12, 0);
  f12.writeUInt32BE(f12.length, 4);
  f12.writeUInt32BE(groups.length, 12);
  groups.forEach(([s, e, g], i) => {
    f12.writeUInt32BE(s, 16 + 12 * i);
    f12.writeUInt32BE(e, 20 + 12 * i);
    f12.writeUInt32BE(g, 24 + 12 * i);
  });
  const head = Buffer.alloc(4 + 8 * 2);
  head.writeUInt16BE(0, 0);
  head.writeUInt16BE(2, 2);
  head.writeUInt16BE(3, 4);
  head.writeUInt16BE(1, 6);
  head.writeUInt32BE(head.length, 8);
  head.writeUInt16BE(3, 12);
  head.writeUInt16BE(10, 14);
  head.writeUInt32BE(head.length + f4.length, 16);
  return Buffer.concat([head, f4, f12]);
}

/** Rebuild an SFNT with some tables replaced / added (e.g. { name, cmap }). */
export function rebuildSfnt(buf, replace) {
  const n = buf.readUInt16BE(4);
  const tables = new Map();
  for (let i = 0; i < n; i++) {
    const o = 12 + 16 * i;
    const off = buf.readUInt32BE(o + 8);
    tables.set(buf.subarray(o, o + 4).toString("latin1"), buf.subarray(off, off + buf.readUInt32BE(o + 12)));
  }
  for (const [tag, data] of Object.entries(replace)) tables.set(tag, data);
  const tags = [...tables.keys()].sort();
  let cursor = 12 + 16 * tags.length;
  const offs = tags.map((t) => {
    const at = cursor;
    cursor += pad4(tables.get(t).length);
    return at;
  });
  const out = Buffer.alloc(cursor);
  buf.copy(out, 0, 0, 4);
  out.writeUInt16BE(tags.length, 4);
  tags.forEach((t, i) => {
    const r = 12 + 16 * i;
    out.write(t, r, "latin1");
    out.writeUInt32BE(offs[i], r + 8);
    out.writeUInt32BE(tables.get(t).length, r + 12);
    tables.get(t).copy(out, offs[i]);
  });
  return out;
}

/** Single-face SFNT from the overlay fixture with its own family name and cmap. */
export function buildSfnt(family, codepoints) {
  const base = readFileSync(join(root, "tests/fixtures/stat-overlay.ttf"));
  return rebuildSfnt(base, { name: nameTable(family), cmap: cmapTable(codepoints) });
}

export const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
export const BASIC_LATIN = [...range(0x20, 0x7e)];
export const ARABIC = [...range(0x0600, 0x06ff), ...range(0xfe70, 0xfefc)];
