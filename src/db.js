'use strict';

// node:sqlite is still flagged experimental in Node 22, which prints a warning
// to stderr on import. On an MCP stdio server that noise ends up in the host's
// logs for no reason, so drop that one warning and leave everything else alone.
const originalEmit = process.emit;
process.emit = function (name, data, ...rest) {
  if (
    name === 'warning' &&
    data &&
    data.name === 'ExperimentalWarning' &&
    /SQLite/i.test(String(data.message))
  ) {
    return false;
  }
  return originalEmit.call(process, name, data, ...rest);
};

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DB_DIR =
  process.env.BOARDROOM_HOME || path.join(os.homedir(), '.claude-boardroom');
const DB_PATH = path.join(DB_DIR, 'boardroom.db');

let db = null;

function open() {
  if (db) return db;
  fs.mkdirSync(DB_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);

  // Several processes (one MCP server per Claude session, the UI, the hook)
  // hold this file open at once, so WAL + a busy timeout instead of locking.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');

  migrate(db);
  return db;
}

// Schema versions, applied in order and tracked in PRAGMA user_version.
//
// Never edit a migration that has shipped — append a new one instead, or an
// installed copy that already ran the old version will silently disagree with
// a fresh install. Keep each one additive where possible: during an app update
// a Claude session may still be holding an older MCP server process open
// against this same file.
const MIGRATIONS = [
  // v1 — the original schema. Written with IF NOT EXISTS so databases created
  // before migrations existed adopt version 1 without being rebuilt.
  function v1(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      name       TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      room       TEXT NOT NULL,
      sender     TEXT NOT NULL,
      body       TEXT NOT NULL,
      kind       TEXT NOT NULL DEFAULT 'participant',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS participants (
      name            TEXT PRIMARY KEY,
      room            TEXT,
      last_seen       TEXT,
      folder_path     TEXT,
      since_id        INTEGER NOT NULL DEFAULT 0,
      permission_mode TEXT NOT NULL DEFAULT 'acceptEdits',
      registered_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS discussions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      room       TEXT NOT NULL,
      prompt     TEXT NOT NULL,
      "order"    TEXT NOT NULL,
      round      INTEGER NOT NULL DEFAULT 1,
      phase      TEXT NOT NULL DEFAULT 'speaking',
      turn_index INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS votes (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      discussion_id INTEGER NOT NULL,
      round         INTEGER NOT NULL,
      name          TEXT NOT NULL,
      vote          INTEGER NOT NULL,
      voted_at      TEXT NOT NULL,
      UNIQUE (discussion_id, round, name)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages (room, id);
    CREATE INDEX IF NOT EXISTS idx_discussions_room ON discussions (room, id);
    `);
  },

  // v2 — roles, direct address, and private asides.
  //
  // Additive on purpose: during an app update a Claude session may still be
  // holding an older MCP server process open against this same file, and it
  // must keep working against the new schema.
  function v2(db) {
    db.exec(`
      ALTER TABLE participants ADD COLUMN role TEXT;
      -- A moderator message aimed at one participant. Everyone sees it; only
      -- the addressee is asked to act on it.
      ALTER TABLE messages ADD COLUMN addressed_to TEXT;
      -- A message in the private channel between the moderator and one
      -- participant. Nobody else ever reads it.
      ALTER TABLE messages ADD COLUMN aside_with TEXT;
      CREATE INDEX IF NOT EXISTS idx_messages_aside ON messages (room, aside_with, id);
    `);
  },
];

function migrate(db) {
  const { user_version: from } = db.prepare('PRAGMA user_version').get();
  if (from >= MIGRATIONS.length) return from;

  for (let i = from; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      MIGRATIONS[i](db);
      // PRAGMA cannot be parameterised; i is a loop index, not input.
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`boardroom migration ${i + 1} failed: ${err.message}`);
    }
  }
  return MIGRATIONS.length;
}

function schemaVersion() {
  return open().prepare('PRAGMA user_version').get().user_version;
}

const now = () => new Date().toISOString();

function all(sql, ...params) {
  return open().prepare(sql).all(...params);
}

function get(sql, ...params) {
  return open().prepare(sql).get(...params);
}

function run(sql, ...params) {
  return open().prepare(sql).run(...params);
}

function close() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  open,
  all,
  get,
  run,
  now,
  close,
  schemaVersion,
  SCHEMA_VERSION: MIGRATIONS.length,
  DB_PATH,
  DB_DIR,
};
