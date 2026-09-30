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
