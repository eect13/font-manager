"use strict";

const crypto = require("node:crypto");

const SECRET = process.env.KEEP_SECRET || "keep-dev-secret-change-me";

function random(bytes = 24) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const pass_hash = crypto.scryptSync(password, salt, 32).toString("hex");
  return { pass_hash, pass_salt: salt };
}

function verifyPassword(password, hash, salt) {
  const check = crypto.scryptSync(password, salt, 32).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(check, "hex"));
}

function fileHash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function fileHashStream(stream) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    stream.on("data", (c) => h.update(c));
    stream.on("end", () => resolve(h.digest("hex")));
    stream.on("error", reject);
  });
}

function signSession(payload, ttlSec = 60 * 60 * 24 * 30) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec })).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

function verifySession(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expect = crypto.createHmac("sha256", SECRET).update(`${header}.${body}`).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (payload.exp && payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

module.exports = {
  SECRET,
  random,
  hashToken,
  hashPassword,
  verifyPassword,
  fileHash,
  fileHashStream,
  signSession,
  verifySession,
};
