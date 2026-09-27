"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = path.resolve(process.env.KEEP_DATA || path.join(__dirname, "..", "data"));
const BLOBS = path.join(DATA_DIR, "blobs");
const VERSIONS = path.join(DATA_DIR, "versions");
const DB_PATH = path.join(DATA_DIR, "keep.db");

function ensureDirs() {
  for (const d of [DATA_DIR, BLOBS, VERSIONS]) fs.mkdirSync(d, { recursive: true });
}

function open() {
  ensureDirs();
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      pass_hash TEXT NOT NULL,
      pass_salt TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      token_hash TEXT UNIQUE NOT NULL,
      label TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      last_used INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      platform TEXT,
      cursor INTEGER NOT NULL DEFAULT 0,
      last_seen INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      parent_id INTEGER,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      mime TEXT,
      hash TEXT,
      storage_key TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      deleted_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (user_id, parent_id, name),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id INTEGER NOT NULL,
      version INTEGER NOT NULL,
      size INTEGER NOT NULL,
      hash TEXT,
      storage_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT UNIQUE NOT NULL,
      node_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      password_hash TEXT,
      password_salt TEXT,
      expires_at INTEGER,
      max_downloads INTEGER,
      downloads INTEGER NOT NULL DEFAULT 0,
      can_write INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      node_id INTEGER,
      detail TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(user_id, parent_id, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_nodes_updated ON nodes(user_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id, id);
  `);
  return db;
}

function blobPath(key) {
  return path.join(BLOBS, key);
}

function versionPath(key) {
  return path.join(VERSIONS, key);
}

module.exports = {
  DATA_DIR,
  BLOBS,
  VERSIONS,
  DB_PATH,
  ensureDirs,
  open,
  blobPath,
  versionPath,
};
