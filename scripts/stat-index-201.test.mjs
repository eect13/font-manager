import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function load(rel) {
  return readFileSync(join(root, rel));
}

function productionParseRs() {
  const rust = readFileSync(join(root, "src-tauri/src/parse.rs"), "utf8");
  return rust.replace(/#\[cfg\(test\)][\s\S]*$/, "");
}

function u16(buf, o) {
  return buf.readUInt16BE(o);
}
function u32(buf, o) {
  return buf.readUInt32BE(o);
}
function i32(buf, o) {
  return buf.readInt32BE(o);
}
function tag(buf, o) {
  return buf.subarray(o, o + 4).toString("latin1");
}
function fixed(buf, o) {
  return i32(buf, o) / 65536;
}

function ttcOffsets(buf) {
  if (tag(buf, 0) !== "ttcf") return [0];
  const n = u32(buf, 8);
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(u32(buf, 12 + i * 4));
  return out;
}

function tables(buf, origin) {
  const n = u16(buf, origin + 4);
  const map = new Map();
  for (let i = 0; i < n; i += 1) {
    const p = origin + 12 + i * 16;
    map.set(tag(buf, p), { off: u32(buf, p + 8), len: u32(buf, p + 12) });
  }
  return map;
}

function names(buf, tbl) {
  const base = tbl.off;
  const count = u16(buf, base + 2);
  const stringOff = base + u16(buf, base + 4);
  const best = new Map();
  for (let i = 0; i < count; i += 1) {
    const rec = base + 6 + i * 12;
    const platform = u16(buf, rec);
    const encoding = u16(buf, rec + 2);
    const id = u16(buf, rec + 6);
    const len = u16(buf, rec + 8);
    const off = u16(buf, rec + 10);
    if (!(platform === 3 && (encoding === 1 || encoding === 10)) && platform !== 0) continue;
    const raw = buf.subarray(stringOff + off, stringOff + off + len);
    let s = "";
    for (let j = 0; j + 1 < raw.length; j += 2) {
      const c = (raw[j] << 8) | raw[j + 1];
      if (c) s += String.fromCharCode(c);
    }
    s = s.trim();
    if (s) best.set(id, s);
  }
  return best;
}

function parseFace(buf, origin) {
  const t = tables(buf, origin);
  const nameTbl = t.get("name");
  const fvarTbl = t.get("fvar");
  const statTbl = t.get("STAT");
  const nm = nameTbl ? names(buf, nameTbl) : new Map();
  const family = nm.get(16) || nm.get(1) || "";
  const axes = [];
  if (fvarTbl) {
    const o = fvarTbl.off;
    const axisOff = o + u16(buf, o + 4);
    const axisCount = u16(buf, o + 8);
    const axisSize = u16(buf, o + 10) || 20;
    for (let i = 0; i < axisCount; i += 1) {
      const p = axisOff + i * axisSize;
      const tg = tag(buf, p);
      const flags = u16(buf, p + 16);
      const nameId = u16(buf, p + 18);
      if (flags & 1 && tg !== "ital") continue;
      let name = nm.get(nameId) || tg;
      axes.push({
        tag: tg,
        name,
        min: fixed(buf, p + 4),
        max: fixed(buf, p + 12),
        nameId,
      });
    }
  }
  const statNames = {};
  if (statTbl) {
    const o = statTbl.off;
    if (u16(buf, o) === 1) {
      const axisSize = u16(buf, o + 4) || 8;
      const axisCount = u16(buf, o + 6);
      const axisOffset = o + u32(buf, o + 8);
      for (let i = 0; i < axisCount; i += 1) {
        const p = axisOffset + i * axisSize;
        const tg = tag(buf, p);
        const name = nm.get(u16(buf, p + 4));
        if (tg && name) statNames[tg] = name;
      }
    }
  }
  for (const axis of axes) {
    if (statNames[axis.tag] && (!axis.name || axis.name === axis.tag)) axis.name = statNames[axis.tag];
  }
  return { family, axes, statNames, hasStat: Boolean(statTbl), hasFvar: Boolean(fvarTbl) };
}

/** STAT axis-value tables (fmt 1 value, 2 range, 3 value+linked, 4 combo). Tests only. */
function parseStatTable(buf, o, nm) {
  const major = u16(buf, o);
  if (major !== 1) return [];
  const axisSize = u16(buf, o + 4) || 8;
  const axisCount = u16(buf, o + 6);
  const axisOffset = o + u32(buf, o + 8);
  const valueCount = u16(buf, o + 12);
  const valueStart = u32(buf, o + 14);
  const axisTags = [];
  for (let i = 0; i < axisCount; i += 1) {
    axisTags.push(tag(buf, axisOffset + i * axisSize));
  }
  const out = [];
  for (let i = 0; i < valueCount; i += 1) {
    const rel = u16(buf, o + valueStart + i * 2);
    const p = o + valueStart + rel;
    const fmt = u16(buf, p);
    if (fmt === 1 || fmt === 3) {
      const axisIndex = u16(buf, p + 2);
      const flags = u16(buf, p + 4);
      const nameId = u16(buf, p + 6);
      const value = fixed(buf, p + 8);
      const linked = fmt === 3 ? fixed(buf, p + 12) : undefined;
      out.push({
        fmt,
        tag: axisTags[axisIndex],
        name: nm.get(nameId) || "",
        value,
        linked,
        elidable: Boolean(flags & 2),
      });
    } else if (fmt === 2) {
      const axisIndex = u16(buf, p + 2);
      const flags = u16(buf, p + 4);
      const nameId = u16(buf, p + 6);
      out.push({
        fmt,
        tag: axisTags[axisIndex],
        name: nm.get(nameId) || "",
        value: fixed(buf, p + 8),
        min: fixed(buf, p + 12),
        max: fixed(buf, p + 16),
        elidable: Boolean(flags & 2),
      });
    } else if (fmt === 4) {
      out.push({ fmt, tag: "*", name: nm.get(u16(buf, p + 6)) || "", count: u16(buf, p + 2) });
    }
  }
  return out;
}

function parseStatValues(buf, origin) {
  const t = tables(buf, origin);
  const statTbl = t.get("STAT");
  const nameTbl = t.get("name");
  if (!statTbl) return [];
  const nm = nameTbl ? names(buf, nameTbl) : new Map();
  return parseStatTable(buf, statTbl.off, nm);
}

test("Figtree (real Google VF TTF): fvar + STAT names from bytes, not a source grep", () => {
  const buf = load("tests/fixtures/Figtree-wght.ttf");
  assert.equal(tag(buf, 0), "\x00\x01\x00\x00");
  const face = parseFace(buf, 0);
  assert.equal(face.family, "Figtree");
  assert.equal(face.hasStat, true);
  assert.equal(face.hasFvar, true);
  const wght = face.axes.find((a) => a.tag === "wght");
  assert.ok(wght, JSON.stringify(face.axes));
  assert.equal(wght.name, "Weight");
  assert.ok(wght.min <= 300, String(wght.min));
  assert.ok(wght.max >= 900, String(wght.max));
});

test("synthetic overlay TTF: STAT names win when fvar name is just the tag", () => {
  const face = parseFace(load("tests/fixtures/stat-overlay.ttf"), 0);
  const opsz = face.axes.find((a) => a.tag === "opsz");
  const wght = face.axes.find((a) => a.tag === "wght");
  assert.equal(opsz?.nameId, 256);
  assert.equal(face.statNames.opsz, "Optical size");
  assert.equal(opsz?.name, "Optical size");
  assert.equal(opsz?.min, 8);
  assert.equal(opsz?.max, 144);
  assert.equal(wght?.name, "Weight");
  assert.equal(wght?.min, 100);
  assert.equal(wght?.max, 900);
});

test("TTC collection indexing returns every face", () => {
  const buf = load("tests/fixtures/two-face.ttc");
  const offs = ttcOffsets(buf);
  assert.equal(offs.length, 2);
  const faces = offs.map((o) => parseFace(buf, o));
  const families = faces.map((f) => f.family).sort();
  assert.deepEqual(families, ["Alpha", "Beta"]);
  for (const face of faces) {
    assert.equal(face.axes.find((a) => a.tag === "opsz")?.name, "Optical size");
  }
});

test("Inter VF is a fixture (opsz+wght+STAT ital) — not skipped for size", () => {
  const buf = load("tests/fixtures/Inter-opsz-wght.ttf");
  assert.ok(buf.length > 400_000, "Inter variable TTF, not a subset");
  const face = parseFace(buf, 0);
  assert.equal(face.family, "Inter");
  assert.equal(face.hasStat, true);
  const tags = face.axes.map((a) => a.tag).sort();
  assert.deepEqual(tags, ["opsz", "wght"]);
  const opsz = face.axes.find((a) => a.tag === "opsz");
  const wght = face.axes.find((a) => a.tag === "wght");
  assert.equal(opsz.min, 14);
  assert.equal(opsz.max, 32);
  assert.equal(wght.min, 100);
  assert.equal(wght.max, 900);
  assert.equal(face.statNames.opsz, "Optical Size");
  assert.equal(face.statNames.wght, "Weight");
  assert.equal(face.statNames.ital, "Italic");
});

test("Inter STAT subtables: format 1 names + format 3 Regular linked to Bold — not instance chips", () => {
  const values = parseStatValues(load("tests/fixtures/Inter-opsz-wght.ttf"), 0);
  assert.equal(values.length, 17);
  const formats = values.reduce((acc, v) => {
    acc[v.fmt] = (acc[v.fmt] || 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(formats, { 1: 15, 3: 2 });
  const by = Object.fromEntries(values.map((v) => [`${v.tag}:${v.value}`, v]));
  assert.equal(by["opsz:14"]?.name, "14pt");
  assert.equal(by["opsz:14"]?.elidable, true);
  assert.equal(by["wght:100"]?.name, "Thin");
  assert.equal(by["wght:400"]?.name, "Regular");
  assert.equal(by["wght:400"]?.fmt, 3);
  assert.equal(by["wght:400"]?.linked, 700);
  assert.equal(by["wght:400"]?.elidable, true);
  assert.equal(by["wght:700"]?.name, "Bold");
  assert.equal(by["ital:0"]?.name, "Roman");
  assert.equal(by["ital:0"]?.linked, 1);
  const prod = productionParseRs();
  assert.doesNotMatch(prod, /stat\.subtables\(\)/);
  assert.doesNotMatch(prod, /subtable_for_axis\s*\(/);
});

test("Figtree STAT is not Inter-shaped — both fixtures required", () => {
  const fig = parseStatValues(load("tests/fixtures/Figtree-wght.ttf"), 0);
  const inter = parseStatValues(load("tests/fixtures/Inter-opsz-wght.ttf"), 0);
  assert.equal(fig.length, 8);
  assert.equal(inter.length, 17);
  assert.ok(!fig.some((v) => v.tag === "opsz"), "Figtree has no optical-size STAT values");
  assert.ok(inter.some((v) => v.tag === "opsz"));
  assert.ok(!fig.some((v) => v.name === "Thin"), "Figtree wght starts at Light 300");
  assert.ok(inter.some((v) => v.name === "Thin"));
  const figTags = [...new Set(fig.map((v) => v.tag))].sort();
  const interTags = [...new Set(inter.map((v) => v.tag))].sort();
  assert.deepEqual(figTags, ["ital", "wght"]);
  assert.deepEqual(interTags, ["ital", "opsz", "wght"]);
  const figReg = fig.find((v) => v.tag === "wght" && v.value === 400);
  assert.equal(figReg?.fmt, 3);
  assert.equal(figReg?.linked, 700);
});

test("STAT format 2 range walker (synthetic) — Inter/Figtree have none", () => {
  const buf = Buffer.alloc(50);
  buf.writeUInt32BE(0x00010002, 0);
  buf.writeUInt16BE(8, 4);
  buf.writeUInt16BE(1, 6);
  buf.writeUInt32BE(20, 8);
  buf.writeUInt16BE(1, 12);
  buf.writeUInt32BE(28, 14);
  buf.writeUInt16BE(2, 18);
  buf.write("opsz", 20, 4, "latin1");
  buf.writeUInt16BE(256, 24);
  buf.writeUInt16BE(0, 26);
  buf.writeUInt16BE(2, 28);
  buf.writeUInt16BE(2, 30);
  buf.writeUInt16BE(0, 32);
  buf.writeUInt16BE(0, 34);
  buf.writeUInt16BE(257, 36);
  buf.writeInt32BE(12 * 65536, 38);
  buf.writeInt32BE(8 * 65536, 42);
  buf.writeInt32BE(14 * 65536, 46);
  const values = parseStatTable(buf, 0, new Map([[257, "Caption"]]));
  assert.equal(values.length, 1);
  assert.equal(values[0].fmt, 2);
  assert.equal(values[0].tag, "opsz");
  assert.equal(values[0].name, "Caption");
  assert.equal(values[0].value, 12);
  assert.equal(values[0].min, 8);
  assert.equal(values[0].max, 14);
});

test("Rust indexer overlays STAT names; STAT values tests-only; no rayon; no fontspector", () => {
  const prod = productionParseRs();
  const rust = readFileSync(join(root, "src-tauri/src/parse.rs"), "utf8");
  const sfnt = readFileSync(join(root, "src/lib/fonts/sfnt.ts"), "utf8");
  const cargo = readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.match(prod, /fn stat_axis_names/);
  assert.match(prod, /face\.tables\(\)\.stat/);
  assert.match(prod, /if name == tag/);
  assert.doesNotMatch(prod, /stat\.subtables\(\)/);
  assert.doesNotMatch(prod, /subtable_for_axis\s*\(/);
  assert.doesNotMatch(sfnt, /axisValueCount|offsetToAxisValueOffsets|linkedValue/);
  assert.match(rust, /include_bytes!\("\.\.\/\.\.\/tests\/fixtures\/stat-overlay\.ttf"\)/);
  assert.match(rust, /include_bytes!\("\.\.\/\.\.\/tests\/fixtures\/Inter-opsz-wght\.ttf"\)/);
  assert.match(rust, /include_bytes!\("\.\.\/\.\.\/tests\/fixtures\/two-face\.ttc"\)/);
  assert.match(rust, /Do not rayon without a profiler/);
  assert.doesNotMatch(cargo, /fontspector|fontbakery|skrifa|read-fonts/);
  const depBlob = JSON.stringify({ ...pkg.dependencies, ...pkg.devDependencies });
  assert.doesNotMatch(depBlob, /fontspector|fontbakery/i);
});
