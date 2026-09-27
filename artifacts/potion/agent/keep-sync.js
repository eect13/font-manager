#!/usr/bin/env node
"use strict";

/**
 * Desktop folder agent for Keep.
 *
 *   set KEEP_URL=http://127.0.0.1:4747
 *   set KEEP_TOKEN=keep_xxxx
 *   set KEEP_FOLDER=%USERPROFILE%\Keep
 *   node agent/keep-sync.js
 *
 * On first run it registers as a device, then loops:
 *   pull remote files that are newer / missing locally
 *   push local files that are newer / missing remotely
 * Conflicts (both changed) keep both copies: name (conflict-timestamp).ext
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");

const URL_BASE = (process.env.KEEP_URL || "http://127.0.0.1:4747").replace(/\/$/, "");
const TOKEN = process.env.KEEP_TOKEN;
const FOLDER = path.resolve(process.env.KEEP_FOLDER || path.join(os.homedir(), "Keep"));
const INTERVAL = Number(process.env.KEEP_INTERVAL || 15) * 1000;

if (!TOKEN) {
  console.error("Set KEEP_TOKEN to an API token from Keep → Settings.");
  process.exit(1);
}

function hashFile(file) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(file));
  return h.digest("hex");
}

async function req(pathname, opts = {}) {
  const headers = { Authorization: "Bearer " + TOKEN, ...(opts.headers || {}) };
  const r = await fetch(URL_BASE + pathname, { ...opts, headers });
  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!r.ok) throw new Error(data.error || text || r.statusText);
  return data;
}

function walk(dir, prefix = "") {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(".") || name === "desktop.ini") continue;
    const rel = prefix ? prefix + "/" + name : name;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...walk(full, rel));
    else out.push({ rel, full, size: st.size, mtime: st.mtimeMs, hash: hashFile(full) });
  }
  return out;
}

function pathOf(items, node) {
  const byId = new Map(items.map((n) => [n.id, n]));
  const parts = [];
  let cur = node;
  while (cur) {
    parts.unshift(cur.name);
    cur = cur.parent_id ? byId.get(cur.parent_id) : null;
  }
  return parts.join("/");
}

async function pull(remoteFiles, localByRel) {
  for (const remote of remoteFiles) {
    const rel = remote.rel;
    const dest = path.join(FOLDER, rel);
    const local = localByRel.get(rel);
    if (local && local.hash === remote.hash) continue;
    if (local && local.mtime > remote.updated_at && local.hash !== remote.hash) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const r = await fetch(URL_BASE + "/api/files/" + remote.id + "/download", {
      headers: { Authorization: "Bearer " + TOKEN },
    });
    if (!r.ok) continue;
    const buf = Buffer.from(await r.arrayBuffer());
    if (local && local.hash !== remote.hash && local.mtime > 0) {
      const ext = path.extname(dest);
      const base = dest.slice(0, dest.length - ext.length);
      fs.copyFileSync(dest, `${base} (conflict-${Date.now()})${ext}`);
    }
    fs.writeFileSync(dest, buf);
    console.log("pull", rel);
  }
}

async function push(localFiles, remoteByRel) {
  for (const local of localFiles) {
    const remote = remoteByRel.get(local.rel);
    if (remote && remote.hash === local.hash) continue;
    if (remote && remote.updated_at > local.mtime && remote.hash !== local.hash) continue;
    const fd = new FormData();
    fd.append("path", local.rel);
    fd.append("file", new Blob([fs.readFileSync(local.full)]), path.basename(local.rel));
    const r = await fetch(URL_BASE + "/api/v1/put", {
      method: "POST",
      headers: { Authorization: "Bearer " + TOKEN },
      body: fd,
    });
    if (!r.ok) {
      console.error("push failed", local.rel, await r.text());
      continue;
    }
    console.log("push", local.rel);
  }
}

async function cycle() {
  fs.mkdirSync(FOLDER, { recursive: true });
  const tree = await req("/api/v1/tree");
  const remoteFiles = tree.items
    .filter((n) => n.kind === "file")
    .map((n) => ({ ...n, rel: pathOf(tree.items, n) }));
  const remoteByRel = new Map(remoteFiles.map((n) => [n.rel, n]));
  const localFiles = walk(FOLDER);
  const localByRel = new Map(localFiles.map((n) => [n.rel, n]));
  await pull(remoteFiles, localByRel);
  await push(walk(FOLDER), remoteByRel);
}

async function main() {
  console.log("Keep agent");
  console.log("  server ", URL_BASE);
  console.log("  folder ", FOLDER);
  try {
    await req("/api/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: os.hostname(), platform: process.platform }),
    });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  await cycle();
  setInterval(() => cycle().catch((err) => console.error(err.message)), INTERVAL);
  fs.watch(FOLDER, { recursive: true }, () => {
    clearTimeout(main._t);
    main._t = setTimeout(() => cycle().catch((err) => console.error(err.message)), 800);
  });
  console.log("watching every", INTERVAL / 1000, "s");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
