"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const dbx = require("./db");
const c = require("./crypto");

const QUOTA = Number(process.env.KEEP_QUOTA_GB || 50) * 1024 * 1024 * 1024;

function now() {
  return Date.now();
}

function sanitizeName(name) {
  const n = String(name || "")
    .replace(/[\\/:\x00-\x1f]/g, "_")
    .replace(/^\.+/, ".")
    .trim();
  if (!n || n === "." || n === "..") throw Object.assign(new Error("Invalid name"), { status: 400 });
  return n.slice(0, 240);
}

function usedBytes(db, userId) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(size), 0) AS n FROM nodes WHERE user_id = ? AND kind = 'file' AND deleted_at IS NULL`
  ).get(userId);
  return row.n;
}

function log(db, userId, action, nodeId, detail) {
  db.prepare(
    `INSERT INTO events (user_id, action, node_id, detail, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(userId, action, nodeId || null, detail || null, now());
}

function getNode(db, userId, id) {
  return db.prepare(`SELECT * FROM nodes WHERE id = ? AND user_id = ?`).get(id, userId);
}

function liveNode(db, userId, id) {
  const n = getNode(db, userId, id);
  if (!n || n.deleted_at) throw Object.assign(new Error("Not found"), { status: 404 });
  return n;
}

function childByName(db, userId, parentId, name) {
  return db.prepare(
    `SELECT * FROM nodes WHERE user_id = ? AND parent_id IS ? AND name = ? AND deleted_at IS NULL`
  ).get(userId, parentId, name);
}

function listChildren(db, userId, parentId, { trash = false } = {}) {
  if (trash) {
    return db.prepare(
      `SELECT * FROM nodes WHERE user_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC`
    ).all(userId);
  }
  return db.prepare(
    `SELECT * FROM nodes WHERE user_id = ? AND parent_id IS ? AND deleted_at IS NULL
     ORDER BY kind DESC, name COLLATE NOCASE`
  ).all(userId, parentId);
}

function pathOf(db, userId, node) {
  const parts = [];
  let cur = node;
  const guard = new Set();
  while (cur) {
    if (guard.has(cur.id)) break;
    guard.add(cur.id);
    parts.unshift({ id: cur.id, name: cur.name, kind: cur.kind });
    if (!cur.parent_id) break;
    cur = getNode(db, userId, cur.parent_id);
  }
  return parts;
}

function resolvePath(db, userId, rel) {
  const clean = String(rel || "/")
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s && s !== ".");
  let parentId = null;
  let node = null;
  for (const part of clean) {
    node = childByName(db, userId, parentId, part);
    if (!node) return { node: null, parentId, missing: part, rest: clean };
    parentId = node.id;
  }
  return { node, parentId: node ? node.parent_id : null, missing: null };
}

function ensureFolderPath(db, userId, rel) {
  const clean = String(rel || "/")
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s && s !== ".");
  let parentId = null;
  let node = null;
  for (const part of clean) {
    const name = sanitizeName(part);
    node = childByName(db, userId, parentId, name);
    if (!node) node = mkdir(db, userId, parentId, name);
    else if (node.kind !== "folder") throw Object.assign(new Error("Path conflict"), { status: 409 });
    parentId = node.id;
  }
  return node;
}

function mkdir(db, userId, parentId, name) {
  name = sanitizeName(name);
  if (parentId) liveNode(db, userId, parentId);
  const exists = childByName(db, userId, parentId, name);
  if (exists) throw Object.assign(new Error("Already exists"), { status: 409 });
  const t = now();
  const info = db.prepare(
    `INSERT INTO nodes (user_id, parent_id, name, kind, size, created_at, updated_at)
     VALUES (?, ?, ?, 'folder', 0, ?, ?)`
  ).run(userId, parentId, name, t, t);
  log(db, userId, "mkdir", info.lastInsertRowid, name);
  return getNode(db, userId, Number(info.lastInsertRowid));
}

function writeBlob(buffer) {
  const key = c.random(18);
  const dest = dbx.blobPath(key);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buffer);
  return key;
}

function copyToVersion(storageKey) {
  const src = dbx.blobPath(storageKey);
  const key = "v-" + c.random(18);
  const dest = dbx.versionPath(key);
  if (fs.existsSync(src)) fs.copyFileSync(src, dest);
  return key;
}

function putFile(db, userId, parentId, name, buffer, mime) {
  name = sanitizeName(name);
  if (parentId) liveNode(db, userId, parentId);
  const hash = c.fileHash(buffer);
  const existing = childByName(db, userId, parentId, name);
  const used = usedBytes(db, userId);
  if (existing && existing.kind === "folder") throw Object.assign(new Error("Name taken by folder"), { status: 409 });

  if (existing && existing.kind === "file") {
    const extra = buffer.length - existing.size;
    if (QUOTA > 0 && used + Math.max(0, extra) > QUOTA) {
      throw Object.assign(new Error("Quota exceeded"), { status: 413 });
    }
    if (existing.storage_key) {
      const vkey = copyToVersion(existing.storage_key);
      db.prepare(
        `INSERT INTO versions (node_id, version, size, hash, storage_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(existing.id, existing.version, existing.size, existing.hash, vkey, now());
    }
    const key = writeBlob(buffer);
    const nextVer = existing.version + 1;
    db.prepare(
      `UPDATE nodes SET size = ?, mime = ?, hash = ?, storage_key = ?, version = ?, updated_at = ? WHERE id = ?`
    ).run(buffer.length, mime || existing.mime, hash, key, nextVer, now(), existing.id);
    log(db, userId, "version", existing.id, `v${nextVer}`);
    return getNode(db, userId, existing.id);
  }

  if (QUOTA > 0 && used + buffer.length > QUOTA) {
    throw Object.assign(new Error("Quota exceeded"), { status: 413 });
  }
  const key = writeBlob(buffer);
  const t = now();
  const info = db.prepare(
    `INSERT INTO nodes (user_id, parent_id, name, kind, size, mime, hash, storage_key, version, created_at, updated_at)
     VALUES (?, ?, ?, 'file', ?, ?, ?, ?, 1, ?, ?)`
  ).run(userId, parentId, name, buffer.length, mime || guessMime(name), hash, key, t, t);
  log(db, userId, "upload", info.lastInsertRowid, name);
  return getNode(db, userId, Number(info.lastInsertRowid));
}

function guessMime(name) {
  const ext = path.extname(name).toLowerCase();
  return (
    {
      ".txt": "text/plain",
      ".md": "text/markdown",
      ".json": "application/json",
      ".csv": "text/csv",
      ".html": "text/html",
      ".css": "text/css",
      ".js": "text/javascript",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".pdf": "application/pdf",
      ".zip": "application/zip",
      ".mp3": "audio/mpeg",
      ".mp4": "video/mp4",
      ".wav": "audio/wav",
      ".woff2": "font/woff2",
      ".ttf": "font/ttf",
    }[ext] || "application/octet-stream"
  );
}

function softDelete(db, userId, id) {
  const node = liveNode(db, userId, id);
  const t = now();
  const walk = (nid) => {
    db.prepare(`UPDATE nodes SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL`).run(
      t,
      t,
      nid,
      userId
    );
    const kids = db.prepare(`SELECT id FROM nodes WHERE parent_id = ? AND user_id = ? AND deleted_at IS NULL`).all(nid, userId);
    for (const k of kids) walk(k.id);
  };
  walk(node.id);
  log(db, userId, "trash", node.id, node.name);
  return { ok: true };
}

function restore(db, userId, id) {
  const node = getNode(db, userId, id);
  if (!node) throw Object.assign(new Error("Not found"), { status: 404 });
  const t = now();
  const stamp = node.deleted_at;
  const walk = (nid) => {
    db.prepare(
      `UPDATE nodes SET deleted_at = NULL, updated_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS ?`
    ).run(t, nid, userId, stamp);
    const kids = db.prepare(`SELECT id FROM nodes WHERE parent_id = ? AND user_id = ? AND deleted_at IS ?`).all(nid, userId, stamp);
    for (const k of kids) walk(k.id);
  };
  walk(node.id);
  log(db, userId, "restore", node.id, node.name);
  return getNode(db, userId, id);
}

function purge(db, userId, id) {
  const node = getNode(db, userId, id);
  if (!node) throw Object.assign(new Error("Not found"), { status: 404 });
  const collect = (nid, acc) => {
    const kids = db.prepare(`SELECT id FROM nodes WHERE parent_id = ? AND user_id = ?`).all(nid, userId);
    for (const k of kids) collect(k.id, acc);
    acc.push(nid);
  };
  const ids = [];
  collect(node.id, ids);
  for (const nid of ids) {
    const n = getNode(db, userId, nid);
    if (n && n.storage_key) {
      try {
        fs.unlinkSync(dbx.blobPath(n.storage_key));
      } catch {}
    }
    const vers = db.prepare(`SELECT storage_key FROM versions WHERE node_id = ?`).all(nid);
    for (const v of vers) {
      try {
        fs.unlinkSync(dbx.versionPath(v.storage_key));
      } catch {}
    }
    db.prepare(`DELETE FROM versions WHERE node_id = ?`).run(nid);
    db.prepare(`DELETE FROM shares WHERE node_id = ?`).run(nid);
    db.prepare(`DELETE FROM nodes WHERE id = ? AND user_id = ?`).run(nid, userId);
  }
  log(db, userId, "purge", null, node.name);
  return { ok: true };
}

function emptyTrash(db, userId) {
  const rows = db.prepare(`SELECT id FROM nodes WHERE user_id = ? AND deleted_at IS NOT NULL AND parent_id IS NULL
    UNION
    SELECT id FROM nodes WHERE user_id = ? AND deleted_at IS NOT NULL
      AND (parent_id IS NULL OR parent_id NOT IN (SELECT id FROM nodes WHERE user_id = ? AND deleted_at IS NOT NULL))
  `).all(userId, userId, userId);
  const all = db.prepare(`SELECT id FROM nodes WHERE user_id = ? AND deleted_at IS NOT NULL`).all(userId);
  for (const r of all) {
    try {
      purge(db, userId, r.id);
    } catch {}
  }
  return { ok: true, count: all.length };
}

function rename(db, userId, id, name) {
  const node = liveNode(db, userId, id);
  name = sanitizeName(name);
  const clash = childByName(db, userId, node.parent_id, name);
  if (clash && clash.id !== id) throw Object.assign(new Error("Already exists"), { status: 409 });
  db.prepare(`UPDATE nodes SET name = ?, updated_at = ? WHERE id = ?`).run(name, now(), id);
  log(db, userId, "rename", id, name);
  return getNode(db, userId, id);
}

function move(db, userId, id, newParentId) {
  const node = liveNode(db, userId, id);
  if (newParentId) {
    const dest = liveNode(db, userId, newParentId);
    if (dest.kind !== "folder") throw Object.assign(new Error("Destination is not a folder"), { status: 400 });
    let cur = dest;
    while (cur) {
      if (cur.id === id) throw Object.assign(new Error("Cannot move into itself"), { status: 400 });
      cur = cur.parent_id ? getNode(db, userId, cur.parent_id) : null;
    }
  }
  const clash = childByName(db, userId, newParentId || null, node.name);
  if (clash) throw Object.assign(new Error("Already exists in destination"), { status: 409 });
  db.prepare(`UPDATE nodes SET parent_id = ?, updated_at = ? WHERE id = ?`).run(newParentId || null, now(), id);
  log(db, userId, "move", id, String(newParentId || ""));
  return getNode(db, userId, id);
}

function search(db, userId, q) {
  const like = `%${q.replace(/[%_]/g, "")}%`;
  return db.prepare(
    `SELECT * FROM nodes WHERE user_id = ? AND deleted_at IS NULL AND name LIKE ? COLLATE NOCASE
     ORDER BY updated_at DESC LIMIT 80`
  ).all(userId, like);
}

function recents(db, userId) {
  return db.prepare(
    `SELECT * FROM nodes WHERE user_id = ? AND deleted_at IS NULL AND kind = 'file'
     ORDER BY updated_at DESC LIMIT 40`
  ).all(userId);
}

function versionsOf(db, userId, id) {
  liveNode(db, userId, id);
  const current = getNode(db, userId, id);
  const old = db.prepare(`SELECT * FROM versions WHERE node_id = ? ORDER BY version DESC`).all(id);
  return { current, history: old };
}

function restoreVersion(db, userId, id, version) {
  const node = liveNode(db, userId, id);
  const v = db.prepare(`SELECT * FROM versions WHERE node_id = ? AND version = ?`).get(id, version);
  if (!v) throw Object.assign(new Error("Version not found"), { status: 404 });
  if (node.storage_key) {
    const vkey = copyToVersion(node.storage_key);
    db.prepare(
      `INSERT INTO versions (node_id, version, size, hash, storage_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(node.id, node.version, node.size, node.hash, vkey, now());
  }
  const src = dbx.versionPath(v.storage_key);
  const key = c.random(18);
  fs.copyFileSync(src, dbx.blobPath(key));
  const nextVer = node.version + 1;
  db.prepare(
    `UPDATE nodes SET size = ?, hash = ?, storage_key = ?, version = ?, updated_at = ? WHERE id = ?`
  ).run(v.size, v.hash, key, nextVer, now(), id);
  log(db, userId, "revert", id, `v${version} → v${nextVer}`);
  return getNode(db, userId, id);
}

function createShare(db, userId, nodeId, opts = {}) {
  liveNode(db, userId, nodeId);
  const token = c.random(18);
  let ph = null;
  let ps = null;
  if (opts.password) {
    const h = c.hashPassword(opts.password);
    ph = h.pass_hash;
    ps = h.pass_salt;
  }
  const expires = opts.expiresHours ? now() + Number(opts.expiresHours) * 3600 * 1000 : null;
  db.prepare(
    `INSERT INTO shares (token, node_id, user_id, password_hash, password_salt, expires_at, max_downloads, can_write, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(token, nodeId, userId, ph, ps, expires, opts.maxDownloads || null, opts.canWrite ? 1 : 0, now());
  log(db, userId, "share", nodeId, token);
  return db.prepare(`SELECT * FROM shares WHERE token = ?`).get(token);
}

function listShares(db, userId) {
  return db.prepare(
    `SELECT s.*, n.name, n.kind, n.size FROM shares s JOIN nodes n ON n.id = s.node_id
     WHERE s.user_id = ? ORDER BY s.created_at DESC`
  ).all(userId);
}

function revokeShare(db, userId, token) {
  db.prepare(`DELETE FROM shares WHERE token = ? AND user_id = ?`).run(token, userId);
}

function getShare(db, token) {
  const s = db.prepare(
    `SELECT s.*, n.name, n.kind, n.size, n.mime, n.storage_key, n.deleted_at
     FROM shares s JOIN nodes n ON n.id = s.node_id WHERE s.token = ?`
  ).get(token);
  if (!s) return null;
  if (s.deleted_at) return null;
  if (s.expires_at && s.expires_at < now()) return null;
  if (s.max_downloads && s.downloads >= s.max_downloads) return null;
  return s;
}

function seedHome(db, userId) {
  const apps = mkdir(db, userId, null, "Apps");
  mkdir(db, userId, apps.id, "Atrium");
  mkdir(db, userId, apps.id, "Finance Manager");
  mkdir(db, userId, apps.id, "Font Manager");
  mkdir(db, userId, null, "Documents");
  mkdir(db, userId, null, "Photos");
  const welcome = Buffer.from(
    `Welcome to Potion\n\nThis is your self-hosted drive.\n\n- Drop files here from the browser\n- Map a Windows folder via WebDAV at /dav/ (or the Nextcloud-shaped /remote.php/dav/files/you/)\n- Point the desktop agent at a local folder\n- Other apps talk to /api/v1 with a token from Settings\n\nApps/ is reserved for Atrium, Finance Manager, and Font Manager.\n`,
    "utf8"
  );
  putFile(db, userId, null, "Welcome to Potion.txt", welcome, "text/plain");
}

function bootstrapAdmin(db) {
  const count = db.prepare(`SELECT COUNT(*) AS n FROM users`).get().n;
  if (count) return;
  const email = (process.env.KEEP_ADMIN_EMAIL || "admin@localhost").toLowerCase();
  const password = process.env.KEEP_ADMIN_PASSWORD || "keep-change-me";
  const name = process.env.KEEP_ADMIN_NAME || "Admin";
  const { pass_hash, pass_salt } = c.hashPassword(password);
  const info = db.prepare(
    `INSERT INTO users (email, name, pass_hash, pass_salt, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(email, name, pass_hash, pass_salt, now());
  seedHome(db, Number(info.lastInsertRowid));
  return { email, password };
}

function publicUrl(req) {
  const host = (req.headers && (req.headers.host || req.headers[":authority"])) || "127.0.0.1:4747";
  return (process.env.KEEP_PUBLIC_URL || `http://${host}`).replace(/\/$/, "");
}

function nodeDto(n, extra = {}) {
  if (!n) return null;
  return {
    id: n.id,
    parentId: n.parent_id,
    name: n.name,
    kind: n.kind,
    size: n.size,
    mime: n.mime,
    hash: n.hash,
    version: n.version,
    deletedAt: n.deleted_at,
    createdAt: n.created_at,
    updatedAt: n.updated_at,
    ...extra,
  };
}

function changesSince(db, userId, cursor) {
  const rows = db.prepare(
    `SELECT * FROM events WHERE user_id = ? AND id > ? ORDER BY id ASC LIMIT 500`
  ).all(userId, Number(cursor) || 0);
  const last = db.prepare(`SELECT COALESCE(MAX(id), 0) AS n FROM events WHERE user_id = ?`).get(userId).n;
  return { cursor: last, events: rows };
}

module.exports = {
  QUOTA,
  now,
  sanitizeName,
  usedBytes,
  log,
  getNode,
  liveNode,
  childByName,
  listChildren,
  pathOf,
  resolvePath,
  ensureFolderPath,
  mkdir,
  putFile,
  guessMime,
  softDelete,
  restore,
  purge,
  emptyTrash,
  rename,
  move,
  search,
  recents,
  versionsOf,
  restoreVersion,
  createShare,
  listShares,
  revokeShare,
  getShare,
  seedHome,
  bootstrapAdmin,
  publicUrl,
  nodeDto,
  changesSince,
};
