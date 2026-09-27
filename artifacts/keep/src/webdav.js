"use strict";

/**
 * WebDAV (RFC 4918 class 1 + class 2 locks) for Potion.
 *
 * Mounts:
 *   /dav/                                  — generic clients (Windows, macOS, rclone, Cyberduck)
 *   /remote.php/dav/files/{user}/          — Nextcloud-shaped URL so existing NC recipes work
 *   /remote.php/webdav/                    — Nextcloud legacy
 *
 * This is not a Nextcloud server. Official Nextcloud desktop/mobile apps speak
 * extra OCS + chunked-upload APIs and will not sync against Potion. Generic
 * WebDAV clients will.
 */

const fs = require("node:fs");
const crypto = require("node:crypto");
const store = require("./store");
const dbx = require("./db");
const { readRaw } = require("./http");

const locks = new Map();

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, """);
}

function header(req, name) {
  return req.headers[name.toLowerCase()] || "";
}

function davMount(req) {
  const p = req.path;
  const ncFiles = p.match(/^\/remote\.php\/dav\/files\/[^/]*\/?(.*)$/);
  if (ncFiles) return { rel: decodeURIComponent(ncFiles[1] || "").replace(/\\/g, "/"), hrefBase: p.slice(0, p.length - (ncFiles[1] || "").length) };
  const ncLegacy = p.match(/^\/remote\.php\/webdav\/?(.*)$/);
  if (ncLegacy) return { rel: decodeURIComponent(ncLegacy[1] || "").replace(/\\/g, "/"), hrefBase: "/remote.php/webdav/" };
  if (p.startsWith("/dav")) {
    return { rel: decodeURIComponent(p.replace(/^\/dav\/?/, "")).replace(/\\/g, "/"), hrefBase: "/dav/" };
  }
  return null;
}

function hrefFor(base, trail, isDir) {
  const rest = trail.map((t) => encodeURIComponent(t.name)).join("/");
  const root = base.endsWith("/") ? base : base + "/";
  if (!rest) return root;
  return root + rest + (isDir ? "/" : "");
}

function parseDest(req) {
  const raw = header(req, "destination");
  try {
    const host = header(req, "host") || "localhost";
    const u = new URL(raw, `http://${host}`);
    const fake = { path: u.pathname };
    const m = davMount(fake);
    return m ? m.rel : decodeURIComponent(u.pathname);
  } catch {
    return decodeURIComponent(raw.replace(/^.*\/(dav|webdav)\//, "") || "/");
  }
}

function etag(node) {
  const raw = (node && (node.hash || String(node.id) + "-" + node.version)) || "root";
  return `"${raw}"`;
}

function lockKey(userId, rel) {
  return userId + ":" + (rel.replace(/\/+$/, "") || "/");
}

function activeLock(userId, rel) {
  const k = lockKey(userId, rel);
  const L = locks.get(k);
  if (!L) return null;
  if (L.expires < Date.now()) {
    locks.delete(k);
    return null;
  }
  return L;
}

function lockXml(L) {
  if (!L) return "<D:lockdiscovery/>";
  return `<D:lockdiscovery>
        <D:activelock>
          <D:locktype><D:write/></D:locktype>
          <D:lockscope><D:exclusive/></D:lockscope>
          <D:depth>${escapeXml(L.depth)}</D:depth>
          <D:owner>${escapeXml(L.owner || "Potion")}</D:owner>
          <D:timeout>Second-${Math.max(1, Math.floor((L.expires - Date.now()) / 1000))}</D:timeout>
          <D:locktoken><D:href>opaquelocktoken:${escapeXml(L.token)}</D:href></D:locktoken>
        </D:activelock>
      </D:lockdiscovery>`;
}

function propfindXml(href, node, isRoot, userId, quota) {
  const isDir = isRoot || (node && node.kind === "folder");
  const name = isRoot ? "Potion" : node.name;
  const modified = new Date(isRoot ? Date.now() : node.updated_at).toUTCString();
  const created = new Date(isRoot ? Date.now() : node.created_at).toISOString();
  const tag = etag(isRoot ? { hash: "root", version: 1, id: 0 } : node);
  const used = quota.used;
  const avail = quota.quota > 0 ? Math.max(0, quota.quota - used) : 1024 * 1024 * 1024 * 1024;
  const L = !isRoot && node ? activeLock(userId, href) : null;
  return `
  <D:response>
    <D:href>${escapeXml(href)}</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>${escapeXml(name)}</D:displayname>
        <D:getlastmodified>${modified}</D:getlastmodified>
        <D:creationdate>${created}</D:creationdate>
        <D:getetag>${escapeXml(tag)}</D:getetag>
        <D:supportedlock>
          <D:lockentry>
            <D:lockscope><D:exclusive/></D:lockscope>
            <D:locktype><D:write/></D:locktype>
          </D:lockentry>
        </D:supportedlock>
        ${lockXml(L)}
        <D:quota-available-bytes>${avail}</D:quota-available-bytes>
        <D:quota-used-bytes>${used}</D:quota-used-bytes>
        ${isDir ? "<D:resourcetype><D:collection/></D:resourcetype>" : `<D:resourcetype/>
        <D:getcontentlength>${node.size || 0}</D:getcontentlength>
        <D:getcontenttype>${escapeXml(node.mime || "application/octet-stream")}</D:getcontenttype>`}
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`;
}

function davHeaders(extra = {}) {
  return {
    DAV: "1, 2",
    "MS-Author-Via": "DAV",
    Allow: "OPTIONS, GET, HEAD, PUT, DELETE, MKCOL, PROPFIND, PROPPATCH, MOVE, COPY, LOCK, UNLOCK",
    ...extra,
  };
}

function parseLockOwner(xml) {
  const m = /<[^>]*owner[^>]*>([^<]*)</i.exec(xml || "");
  return m ? m[1] : "Potion";
}

function mount(app, { db, requireUser, sendBlob }) {
  app.use(async (req, res, next) => {
    const mountInfo = davMount(req);
    if (!mountInfo) return next();
    try {
      const user = requireUser(req, res, true);
      if (!user) return;
      const rel = mountInfo.rel;
      const base = mountInfo.hrefBase.endsWith("/") ? mountInfo.hrefBase : mountInfo.hrefBase + "/";
      const resolved = store.resolvePath(db, user.id, rel);
      const depth = (header(req, "depth") || "1").toLowerCase();
      const quota = { used: store.usedBytes(db, user.id), quota: store.QUOTA };

      if (req.method === "OPTIONS") {
        res.writeHead(200, davHeaders());
        return res.end();
      }

      if (req.method === "PROPFIND") {
        await readRaw(req, 256 * 1024).catch(() => Buffer.alloc(0));
        if (rel && rel !== "/" && !resolved.node) {
          res.writeHead(404, davHeaders());
          return res.end();
        }
        const parts = [];
        if (!resolved.node) {
          parts.push(propfindXml(base, null, true, user.id, quota));
          if (depth !== "0") {
            for (const child of store.listChildren(db, user.id, null)) {
              parts.push(
                propfindXml(hrefFor(base, [{ name: child.name }], child.kind === "folder"), child, false, user.id, quota)
              );
            }
          }
        } else {
          const trail = store.pathOf(db, user.id, resolved.node);
          const selfHref = hrefFor(base, trail, resolved.node.kind === "folder");
          parts.push(propfindXml(selfHref, resolved.node, false, user.id, quota));
          if (depth !== "0" && resolved.node.kind === "folder") {
            for (const child of store.listChildren(db, user.id, resolved.node.id)) {
              parts.push(
                propfindXml(hrefFor(base, [...trail, { name: child.name }], child.kind === "folder"), child, false, user.id, quota)
              );
            }
          }
        }
        const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">${parts.join("")}
</D:multistatus>`;
        res.writeHead(207, davHeaders({ "Content-Type": "application/xml; charset=utf-8" }));
        return res.end(xml);
      }

      if (req.method === "PROPPATCH") {
        await readRaw(req, 256 * 1024).catch(() => Buffer.alloc(0));
        if (!resolved.node && rel && rel !== "/") {
          res.writeHead(404, davHeaders());
          return res.end();
        }
        const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>${escapeXml(req.path)}</D:href>
    <D:propstat>
      <D:prop/>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;
        res.writeHead(207, davHeaders({ "Content-Type": "application/xml; charset=utf-8" }));
        return res.end(xml);
      }

      if (req.method === "LOCK") {
        const body = (await readRaw(req, 64 * 1024).catch(() => Buffer.alloc(0))).toString("utf8");
        const existing = activeLock(user.id, rel);
        const ifHdr = header(req, "if");
        if (existing && body.includes("<") && !ifHdr.includes(existing.token)) {
          res.writeHead(423, davHeaders());
          return res.end();
        }
        const token = existing && ifHdr.includes(existing.token) ? existing.token : crypto.randomUUID();
        const L = {
          token,
          owner: parseLockOwner(body),
          depth: depth === "infinity" ? "infinity" : "0",
          expires: Date.now() + 600 * 1000,
        };
        locks.set(lockKey(user.id, rel), L);
        if (!resolved.node && rel) {
          const bits = rel.split("/").filter(Boolean);
          const name = bits.pop();
          const parentRel = bits.join("/");
          const parent = parentRel ? store.ensureFolderPath(db, user.id, parentRel) : null;
          store.putFile(db, user.id, parent ? parent.id : null, name, Buffer.alloc(0), "application/octet-stream");
        }
        const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:prop xmlns:D="DAV:">
  ${lockXml(L)}
</D:prop>`;
        res.writeHead(200, davHeaders({
          "Content-Type": "application/xml; charset=utf-8",
          "Lock-Token": `<opaquelocktoken:${token}>`,
          Timeout: "Second-600",
        }));
        return res.end(xml);
      }

      if (req.method === "UNLOCK") {
        await readRaw(req, 16 * 1024).catch(() => Buffer.alloc(0));
        const tok = header(req, "lock-token").replace(/[<>]/g, "").replace(/^opaquelocktoken:/, "");
        const L = activeLock(user.id, rel);
        if (!L || L.token !== tok) {
          res.writeHead(409, davHeaders());
          return res.end();
        }
        locks.delete(lockKey(user.id, rel));
        res.writeHead(204, davHeaders());
        return res.end();
      }

      if (req.method === "MKCOL") {
        await readRaw(req, 16 * 1024).catch(() => Buffer.alloc(0));
        const bits = rel.split("/").filter(Boolean);
        const name = bits.pop();
        const parentRel = bits.join("/");
        const parent = parentRel ? store.resolvePath(db, user.id, parentRel).node : null;
        if (parentRel && !parent) {
          res.writeHead(409, davHeaders());
          return res.end();
        }
        store.mkdir(db, user.id, parent ? parent.id : null, name);
        res.writeHead(201, davHeaders());
        return res.end();
      }

      if (req.method === "PUT") {
        const bits = rel.split("/").filter(Boolean);
        const name = bits.pop();
        const parentRel = bits.join("/");
        const parent = parentRel ? store.ensureFolderPath(db, user.id, parentRel) : null;
        const buf = await readRaw(req);
        const node = store.putFile(db, user.id, parent ? parent.id : null, name, buf, store.guessMime(name));
        res.writeHead(201, davHeaders({ ETag: etag(node) }));
        return res.end();
      }

      if (req.method === "GET" || req.method === "HEAD") {
        if (!resolved.node || resolved.node.kind !== "file") {
          res.writeHead(404, davHeaders());
          return res.end();
        }
        if (req.method === "HEAD") {
          res.writeHead(200, davHeaders({
            "Content-Length": String(resolved.node.size),
            "Content-Type": resolved.node.mime || "application/octet-stream",
            ETag: etag(resolved.node),
          }));
          return res.end();
        }
        return sendBlob(res, resolved.node, false);
      }

      if (req.method === "DELETE") {
        if (!resolved.node) {
          res.writeHead(404, davHeaders());
          return res.end();
        }
        store.softDelete(db, user.id, resolved.node.id);
        locks.delete(lockKey(user.id, rel));
        res.writeHead(204, davHeaders());
        return res.end();
      }

      if (req.method === "MOVE" || req.method === "COPY") {
        if (!resolved.node) {
          res.writeHead(404, davHeaders());
          return res.end();
        }
        const destRel = parseDest(req);
        const overwrite = (header(req, "overwrite") || "T").toUpperCase() !== "F";
        const bits = destRel.split("/").filter(Boolean);
        const newName = bits.pop();
        const parentRel = bits.join("/");
        const parent = parentRel ? store.ensureFolderPath(db, user.id, parentRel) : null;
        const clash = store.childByName(db, user.id, parent ? parent.id : null, newName || resolved.node.name);
        if (clash && !overwrite) {
          res.writeHead(412, davHeaders());
          return res.end();
        }
        if (req.method === "MOVE") {
          store.move(db, user.id, resolved.node.id, parent ? parent.id : null);
          if (newName && newName !== resolved.node.name) store.rename(db, user.id, resolved.node.id, newName);
        } else if (resolved.node.kind === "file") {
          const buf = fs.readFileSync(dbx.blobPath(resolved.node.storage_key));
          store.putFile(db, user.id, parent ? parent.id : null, newName || resolved.node.name, buf, resolved.node.mime);
        }
        res.writeHead(201, davHeaders());
        return res.end();
      }

      res.writeHead(405, davHeaders());
      res.end();
    } catch (err) {
      const code = err.status || 500;
      if (code >= 500) console.error(err);
      if (!res.writableEnded) {
        res.writeHead(code, { DAV: "1, 2" });
        res.end();
      }
    }
  });
}

module.exports = { mount };
