"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const dbx = require("./src/db");
const c = require("./src/crypto");
const store = require("./src/store");
const webdav = require("./src/webdav");
const hx = require("./src/http");

const PORT = Number(process.env.KEEP_PORT || 4747);
const HOST = process.env.KEEP_HOST || "0.0.0.0";
const PUBLIC = path.join(__dirname, "public");

dbx.ensureDirs();
const db = dbx.open();
const seeded = store.bootstrapAdmin(db);

const app = hx.createApp();

function header(req, name) {
  return req.headers[name.toLowerCase()] || "";
}

function bearer(req) {
  const h = header(req, "authorization");
  if (h.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
  if (req.cookies && req.cookies.keep) return req.cookies.keep;
  if (req.query.access_token) return String(req.query.access_token);
  if (h.toLowerCase().startsWith("basic ")) {
    try {
      const [email, password] = Buffer.from(h.slice(6), "base64").toString().split(":");
      const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get((email || "").toLowerCase());
      if (user && c.verifyPassword(password || "", user.pass_hash, user.pass_salt)) {
        return c.signSession({ uid: user.id, email: user.email }, 60 * 60);
      }
    } catch {}
  }
  return null;
}

function userFromToken(token) {
  const sess = c.verifySession(token);
  if (sess && sess.uid) {
    return db.prepare(`SELECT id, email, name, created_at FROM users WHERE id = ?`).get(sess.uid);
  }
  if (!token) return null;
  const hash = c.hashToken(token);
  const row = db.prepare(
    `SELECT u.id, u.email, u.name, u.created_at, t.expires_at, t.id AS tid
     FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`
  ).get(hash);
  if (!row) return null;
  if (row.expires_at && row.expires_at < Date.now()) return null;
  db.prepare(`UPDATE tokens SET last_used = ? WHERE id = ?`).run(Date.now(), row.tid);
  return { id: row.id, email: row.email, name: row.name, created_at: row.created_at };
}

function requireUser(req, res, dav) {
  const user = userFromToken(bearer(req));
  if (!user) {
    if (dav) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Potion"' });
      res.end();
      return null;
    }
    hx.send(res, 401, { error: "Sign in required" });
    return null;
  }
  req.user = user;
  return user;
}

function sendBlob(res, node, download) {
  const filePath = dbx.blobPath(node.storage_key);
  if (!fs.existsSync(filePath)) return hx.send(res, 404, { error: "Blob missing" });
  const disp = download ? "attachment" : "inline";
  return hx.sendFilePath(res, filePath, {
    "Content-Type": node.mime || "application/octet-stream",
    "Content-Disposition": `${disp}; filename="${encodeURIComponent(node.name)}"`,
  });
}

function wrap(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      const code = err.status || 500;
      if (code >= 500) console.error(err);
      if (!res.writableEnded) hx.send(res, code, { error: err.message || "Server error" });
    }
  };
}

webdav.mount(app, { db, requireUser, sendBlob });
app.use(hx.staticDir(PUBLIC));

app.get("/api/health", (_req, res) => hx.send(res, 200, { ok: true, name: "Potion", version: "1.1.0" }));

app.post("/api/auth/login", wrap((req, res) => {
  const email = String(req.body?.email || "").toLowerCase().trim();
  const password = String(req.body?.password || "");
  const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email);
  if (!user || !c.verifyPassword(password, user.pass_hash, user.pass_salt)) {
    return hx.send(res, 401, { error: "Wrong email or password" });
  }
  const token = c.signSession({ uid: user.id, email: user.email });
  hx.send(res, 200, { token, user: { id: user.id, email: user.email, name: user.name } });
}));

app.post("/api/auth/register", wrap((req, res) => {
  const email = String(req.body?.email || "").toLowerCase().trim();
  const password = String(req.body?.password || "");
  const name = String(req.body?.name || email.split("@")[0] || "User").slice(0, 80);
  if (!email.includes("@") || password.length < 8) {
    return hx.send(res, 400, { error: "Need a valid email and an 8+ character password" });
  }
  const exists = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email);
  if (exists) return hx.send(res, 409, { error: "Email already in use" });
  const { pass_hash, pass_salt } = c.hashPassword(password);
  const info = db.prepare(
    `INSERT INTO users (email, name, pass_hash, pass_salt, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(email, name, pass_hash, pass_salt, Date.now());
  store.seedHome(db, Number(info.lastInsertRowid));
  const token = c.signSession({ uid: Number(info.lastInsertRowid), email });
  hx.send(res, 200, { token, user: { id: Number(info.lastInsertRowid), email, name } });
}));

app.get("/api/me", wrap((req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  hx.send(res, 200, {
    user,
    storage: { used: store.usedBytes(db, user.id), quota: store.QUOTA },
    webdav: "/dav/",
    api: "/api/v1",
  });
}));

app.post("/api/me/password", wrap((req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const full = db.prepare(`SELECT * FROM users WHERE id = ?`).get(user.id);
  if (!c.verifyPassword(String(req.body?.current || ""), full.pass_hash, full.pass_salt)) {
    return hx.send(res, 401, { error: "Current password is wrong" });
  }
  const next = String(req.body?.next || "");
  if (next.length < 8) return hx.send(res, 400, { error: "New password must be 8+ characters" });
  const h = c.hashPassword(next);
  db.prepare(`UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?`).run(h.pass_hash, h.pass_salt, user.id);
  hx.send(res, 200, { ok: true });
}));

app.get("/api/tokens", wrap((req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const rows = db.prepare(
    `SELECT id, kind, label, created_at, last_used FROM tokens WHERE user_id = ? ORDER BY created_at DESC`
  ).all(user.id);
  hx.send(res, 200, { tokens: rows });
}));

app.post("/api/tokens", wrap((req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const raw = "keep_" + c.random(24);
  const label = String(req.body?.label || "App token").slice(0, 80);
  db.prepare(
    `INSERT INTO tokens (user_id, kind, token_hash, label, created_at) VALUES (?, 'api', ?, ?, ?)`
  ).run(user.id, c.hashToken(raw), label, Date.now());
  hx.send(res, 200, { token: raw, label });
}));

app.delete("/api/tokens/:id", wrap((req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  db.prepare(`DELETE FROM tokens WHERE id = ? AND user_id = ?`).run(Number(req.params.id), user.id);
  hx.send(res, 200, { ok: true });
}));

app.get("/api/devices", wrap((req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  hx.send(res, 200, { devices: db.prepare(`SELECT * FROM devices WHERE user_id = ? ORDER BY last_seen DESC`).all(user.id) });
}));

app.post("/api/devices", wrap((req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const name = String(req.body?.name || "Device").slice(0, 80);
  const platform = String(req.body?.platform || "unknown").slice(0, 40);
  const info = db.prepare(
    `INSERT INTO devices (user_id, name, platform, cursor, last_seen) VALUES (?, ?, ?, 0, ?)`
  ).run(user.id, name, platform, Date.now());
  hx.send(res, 200, { id: Number(info.lastInsertRowid), name, platform });
}));

function listFiles(req, res) {
  const user = requireUser(req, res);
  if (!user) return;
  const parent = req.query.parent ? Number(req.query.parent) : null;
  const trash = req.query.trash === "1";
  const q = String(req.query.q || "").trim();
  if (q) return hx.send(res, 200, { items: store.search(db, user.id, q).map((n) => store.nodeDto(n)) });
  if (req.query.recent === "1") return hx.send(res, 200, { items: store.recents(db, user.id).map((n) => store.nodeDto(n)) });
  const items = store.listChildren(db, user.id, parent, { trash }).map((n) => store.nodeDto(n));
  const folder = parent ? store.getNode(db, user.id, parent) : null;
  const crumbs = folder ? store.pathOf(db, user.id, folder) : [];
  hx.send(res, 200, { items, crumbs, parent });
}

app.get("/api/v1/files", wrap(listFiles));
app.get("/api/files", wrap(listFiles));

app.post("/api/files/mkdir", wrap((req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const node = store.mkdir(db, user.id, req.body?.parentId || null, req.body?.name);
  hx.send(res, 200, store.nodeDto(node));
}));

app.post("/api/files/upload", wrap((req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const parentId = req.body?.parentId ? Number(req.body.parentId) : null;
  const out = [];
  for (const f of req.files || []) {
    out.push(store.nodeDto(store.putFile(db, user.id, parentId, path.basename(f.originalname), f.buffer, f.mimetype)));
  }
  hx.send(res, 200, { items: out });
}));

app.get("/api/files/:id", wrap((req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const node = store.getNode(db, user.id, Number(req.params.id));
  if (!node) return hx.send(res, 404, { error: "Not found" });
  hx.send(res, 200, { ...store.nodeDto(node), path: store.pathOf(db, user.id, node) });
}));

app.get("/api/files/:id/download", wrap((req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const node = store.getNode(db, user.id, Number(req.params.id));
  if (!node || node.kind !== "file") return hx.send(res, 404, { error: "Not found" });
  sendBlob(res, node, req.query.dl === "1");
}));

app.post("/api/files/:id/rename", wrap((req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  hx.send(res, 200, store.nodeDto(store.rename(db, user.id, Number(req.params.id), req.body?.name)));
}));

app.post("/api/files/:id/move", wrap((req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  hx.send(res, 200, store.nodeDto(store.move(db, user.id, Number(req.params.id), req.body?.parentId || null)));
}));

app.post("/api/files/:id/trash", wrap((req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  hx.send(res, 200, store.softDelete(db, user.id, Number(req.params.id)));
}));

app.post("/api/files/:id/restore", wrap((req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  hx.send(res, 200, store.nodeDto(store.restore(db, user.id, Number(req.params.id))));
}));

app.delete("/api/files/:id", wrap((req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  hx.send(res, 200, store.purge(db, user.id, Number(req.params.id)));
}));

app.post("/api/trash/empty", wrap((req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  hx.send(res, 200, store.emptyTrash(db, user.id));
}));

app.get("/api/files/:id/versions", wrap((req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const v = store.versionsOf(db, user.id, Number(req.params.id));
  hx.send(res, 200, { current: store.nodeDto(v.current), history: v.history });
}));

app.get("/api/versions/:vid/download", wrap((req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const v = db.prepare(
    `SELECT v.*, n.user_id, n.name, n.mime FROM versions v JOIN nodes n ON n.id = v.node_id WHERE v.id = ?`
  ).get(Number(req.params.vid));
  if (!v || v.user_id !== user.id) return hx.send(res, 404, { error: "Not found" });
  const filePath = dbx.versionPath(v.storage_key);
  if (!fs.existsSync(filePath)) return hx.send(res, 404, { error: "Missing" });
  hx.sendFilePath(res, filePath, {
    "Content-Type": v.mime || "application/octet-stream",
    "Content-Disposition": `attachment; filename="${encodeURIComponent("v" + v.version + "-" + v.name)}"`,
  });
}));

app.post("/api/files/:id/revert", wrap((req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  hx.send(res, 200, store.nodeDto(store.restoreVersion(db, user.id, Number(req.params.id), Number(req.body?.version))));
}));

app.get("/api/shares", wrap((req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const origin = store.publicUrl(req);
  hx.send(res, 200, {
    shares: store.listShares(db, user.id).map((s) => ({ ...s, url: `${origin}/s/${s.token}` })),
  });
}));

app.post("/api/files/:id/share", wrap((req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const s = store.createShare(db, user.id, Number(req.params.id), req.body || {});
  hx.send(res, 200, { ...s, url: `${store.publicUrl(req)}/s/${s.token}` });
}));

app.delete("/api/shares/:token", wrap((req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  store.revokeShare(db, user.id, req.params.token);
  hx.send(res, 200, { ok: true });
}));

app.get("/api/share/:token", wrap((req, res) => {
  const s = store.getShare(db, req.params.token);
  if (!s) return hx.send(res, 404, { error: "Link expired or missing" });
  hx.send(res, 200, {
    name: s.name,
    kind: s.kind,
    size: s.size,
    mime: s.mime,
    locked: Boolean(s.password_hash),
    expiresAt: s.expires_at,
  });
}));

app.post("/api/share/:token/unlock", wrap((req, res) => {
  const s = store.getShare(db, req.params.token);
  if (!s) return hx.send(res, 404, { error: "Link expired or missing" });
  if (s.password_hash && !c.verifyPassword(String(req.body?.password || ""), s.password_hash, s.password_salt)) {
    return hx.send(res, 401, { error: "Wrong password" });
  }
  hx.send(res, 200, { ok: true, pass: c.signSession({ share: s.token }, 60 * 60 * 6) });
}));

app.get("/s/:token/download", wrap((req, res) => {
  const s = store.getShare(db, req.params.token);
  if (!s) return hx.send(res, 404, "Link expired or missing");
  if (s.password_hash) {
    const p = c.verifySession(req.query.p || bearer(req));
    if (!p || p.share !== s.token) return hx.send(res, 401, "Password required");
  }
  if (s.kind !== "file") return hx.send(res, 400, "Open the folder link in the browser");
  db.prepare(`UPDATE shares SET downloads = downloads + 1 WHERE token = ?`).run(s.token);
  sendBlob(res, s, true);
}));

app.get("/api/sync/changes", wrap((req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  hx.send(res, 200, store.changesSince(db, user.id, req.query.cursor));
}));

app.get("/api/v1/tree", wrap((req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const rows = db.prepare(
    `SELECT id, parent_id, name, kind, size, hash, version, updated_at FROM nodes
     WHERE user_id = ? AND deleted_at IS NULL`
  ).all(user.id);
  hx.send(res, 200, { items: rows });
}));

app.post("/api/v1/put", wrap((req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const file = (req.files || [])[0];
  if (!file) return hx.send(res, 400, { error: "file required" });
  const rel = String(req.body?.path || file.originalname);
  const bits = rel.replace(/\\/g, "/").split("/").filter(Boolean);
  const name = bits.pop();
  const folder = bits.length ? store.ensureFolderPath(db, user.id, bits.join("/")) : null;
  const node = store.putFile(db, user.id, folder ? folder.id : null, name, file.buffer, file.mimetype);
  hx.send(res, 200, store.nodeDto(node));
}));

app.get("/api/activity", wrap((req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  hx.send(res, 200, { events: db.prepare(`SELECT * FROM events WHERE user_id = ? ORDER BY id DESC LIMIT 60`).all(user.id) });
}));

app.get("/s/:token", wrap((_req, res) => {
  hx.sendFilePath(res, path.join(PUBLIC, "share.html"), { "Content-Type": "text/html; charset=utf-8" });
}));

app.get("/manifest.json", wrap((_req, res) => {
  hx.sendFilePath(res, path.join(PUBLIC, "manifest.json"), { "Content-Type": "application/manifest+json" });
}));

app.get("/sw.js", wrap((_req, res) => {
  hx.sendFilePath(res, path.join(PUBLIC, "sw.js"), { "Content-Type": "text/javascript; charset=utf-8" });
}));

function spa(_req, res) {
  hx.sendFilePath(res, path.join(PUBLIC, "index.html"), { "Content-Type": "text/html; charset=utf-8" });
}
for (const p of ["/", "/app", "/trash", "/shares", "/settings", "/recent"]) app.get(p, wrap(spa));

const server = http.createServer((req, res) => app.handle(req, res));
server.listen(PORT, HOST, () => {
  console.log(`Potion is running on http://${HOST}:${PORT}`);
  if (seeded) {
    console.log(`First admin: ${seeded.email}  /  ${seeded.password}`);
    console.log("Change KEEP_ADMIN_PASSWORD and KEEP_SECRET before exposing this.");
  }
});
