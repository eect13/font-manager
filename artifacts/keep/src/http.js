"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");

function send(res, status, body, headers = {}) {
  const json = typeof body !== "string" && !Buffer.isBuffer(body);
  const data = json ? Buffer.from(JSON.stringify(body)) : Buffer.isBuffer(body) ? body : Buffer.from(body || "");
  res.writeHead(status, {
    "Content-Type": json ? "application/json; charset=utf-8" : headers["Content-Type"] || "text/plain; charset=utf-8",
    "Content-Length": data.length,
    ...headers,
  });
  res.end(data);
}

function sendFilePath(res, filePath, headers = {}) {
  if (!fs.existsSync(filePath)) return send(res, 404, { error: "Missing" });
  const stream = fs.createReadStream(filePath);
  const stat = fs.statSync(filePath);
  res.writeHead(200, { "Content-Length": stat.size, ...headers });
  stream.pipe(res);
}

function mimeFor(file) {
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".ico": "image/x-icon",
      ".webmanifest": "application/manifest+json",
    }[path.extname(file)] || "application/octet-stream"
  );
}

function parseQuery(url) {
  const q = {};
  const i = url.indexOf("?");
  if (i < 0) return q;
  new URLSearchParams(url.slice(i + 1)).forEach((v, k) => {
    q[k] = v;
  });
  return q;
}

function pathname(url) {
  const i = url.indexOf("?");
  return decodeURIComponent((i < 0 ? url : url.slice(0, i)) || "/");
}

async function readRaw(req, limit = 1024 * 1024 * 1024) {
  const chunks = [];
  let n = 0;
  for await (const chunk of req) {
    n += chunk.length;
    if (n > limit) throw Object.assign(new Error("Payload too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k) out[k] = decodeURIComponent(rest.join("="));
  }
  return out;
}

function parseMultipart(buf, contentType) {
  const m = /boundary=([^;]+)/i.exec(contentType || "");
  if (!m) throw Object.assign(new Error("No multipart boundary"), { status: 400 });
  const boundary = Buffer.from("--" + m[1].replace(/^"|"$/g, ""));
  const files = [];
  const fields = {};
  let start = indexOf(buf, boundary, 0);
  while (start !== -1) {
    const headStart = start + boundary.length + 2;
    const next = indexOf(buf, boundary, headStart);
    if (next === -1) break;
    const part = buf.subarray(headStart, next - 2);
    const sep = indexOf(part, Buffer.from("\r\n\r\n"), 0);
    if (sep === -1) {
      start = next;
      continue;
    }
    const header = part.subarray(0, sep).toString("utf8");
    const body = part.subarray(sep + 4);
    const name = /name="([^"]+)"/.exec(header);
    const filename = /filename="([^"]*)"/.exec(header);
    const ctype = /Content-Type:\s*([^\r\n]+)/i.exec(header);
    if (filename && name) {
      files.push({
        field: name[1],
        originalname: filename[1] || "upload",
        mimetype: ctype ? ctype[1].trim() : "application/octet-stream",
        buffer: Buffer.from(body),
      });
    } else if (name) {
      fields[name[1]] = body.toString("utf8");
    }
    start = next;
  }
  return { files, fields };
}

function indexOf(buf, needle, from) {
  return buf.indexOf(needle, from);
}

function createApp() {
  const routes = [];
  const app = {
    use(fn) {
      routes.push({ method: "*", pattern: "*", handler: fn, middleware: true });
    },
    on(method, pattern, handler) {
      routes.push({ method, pattern, handler, middleware: false });
    },
    async handle(req, res) {
      req.path = pathname(req.url);
      req.query = parseQuery(req.url);
      req.cookies = parseCookies(req);
      req.body = {};
      req.files = [];
      const ct = String(req.headers["content-type"] || "");
      try {
        if (
          req.method !== "GET" &&
          req.method !== "HEAD" &&
          req.method !== "OPTIONS" &&
          !req.path.startsWith("/dav") &&
          !req.path.startsWith("/remote.php")
        ) {
          if (ct.includes("multipart/form-data")) {
            const raw = await readRaw(req);
            const parsed = parseMultipart(raw, ct);
            req.body = parsed.fields;
            req.files = parsed.files;
          } else if (ct.includes("application/json")) {
            const raw = await readRaw(req, 4 * 1024 * 1024);
            req.body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
          } else if (ct.includes("application/x-www-form-urlencoded")) {
            const raw = await readRaw(req, 1024 * 1024);
            req.body = Object.fromEntries(new URLSearchParams(raw.toString("utf8")));
          }
        }
      } catch (err) {
        if (err.status) return send(res, err.status, { error: err.message });
        if (req.method !== "PUT") return send(res, 400, { error: "Bad request body" });
      }

      for (const route of routes) {
        if (route.middleware) {
          let nextCalled = false;
          await route.handler(req, res, () => {
            nextCalled = true;
          });
          if (res.writableEnded) return;
          if (!nextCalled) return;
          continue;
        }
        if (route.method !== req.method && route.method !== "*") continue;
        const params = match(route.pattern, req.path);
        if (!params) continue;
        req.params = params;
        try {
          await route.handler(req, res);
        } catch (err) {
          if (res.writableEnded) return;
          const code = err.status || 500;
          if (code >= 500) console.error(err);
          send(res, code, { error: err.message || "Server error" });
        }
        return;
      }
      if (!res.writableEnded) send(res, 404, { error: "Not found" });
    },
  };
  for (const m of ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"]) {
    app[m.toLowerCase()] = (pattern, handler) => app.on(m, pattern, handler);
  }
  return app;
}

function match(pattern, pathName) {
  if (pattern === "*") return {};
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    if (pathName.startsWith(prefix)) return { rest: pathName.slice(prefix.length) };
    return null;
  }
  const pa = pattern.split("/").filter(Boolean);
  const pb = pathName.split("/").filter(Boolean);
  if (pa.length !== pb.length) return null;
  const params = {};
  for (let i = 0; i < pa.length; i++) {
    if (pa[i].startsWith(":")) params[pa[i].slice(1)] = pb[i];
    else if (pa[i] !== pb[i]) return null;
  }
  return params;
}

function staticDir(root) {
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    let rel = req.path;
    if (rel.startsWith("/assets/")) rel = rel.slice("/assets".length);
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root)) return next();
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      return sendFilePath(res, file, { "Content-Type": mimeFor(file), "Cache-Control": "public, max-age=3600" });
    }
    next();
  };
}

module.exports = {
  send,
  sendFilePath,
  mimeFor,
  readRaw,
  createApp,
  staticDir,
  Readable,
};
