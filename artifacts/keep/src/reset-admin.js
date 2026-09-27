"use strict";

const dbx = require("./db");
const c = require("./crypto");

const db = dbx.open();
const email = (process.env.KEEP_ADMIN_EMAIL || "admin@localhost").toLowerCase();
const password = process.env.KEEP_ADMIN_PASSWORD || "keep-change-me";
const name = process.env.KEEP_ADMIN_NAME || "Admin";
const { pass_hash, pass_salt } = c.hashPassword(password);
const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email);
if (existing) {
  db.prepare(`UPDATE users SET pass_hash = ?, pass_salt = ?, name = ? WHERE id = ?`).run(pass_hash, pass_salt, name, existing.id);
  console.log("Updated password for", email);
} else {
  db.prepare(`INSERT INTO users (email, name, pass_hash, pass_salt, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    email, name, pass_hash, pass_salt, Date.now()
  );
  console.log("Created", email);
}
