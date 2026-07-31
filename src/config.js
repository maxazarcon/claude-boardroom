'use strict';

// Optional settings, read from ~/.claude-boardroom/config.json.
// Everything here has a safe default, so the file is not required.
//
// {
//   "autoRegisterBase": "C:\\Users\\conta\\Desktop\\Projects",
//   "autoRegisterEnabled": true
// }
//
// autoRegisterBase: when the auto-poll hook runs in a folder directly under
// this path and that folder is not a known participant, it registers itself
// using the folder name. Sessions outside this path are never touched. A newly
// auto-registered session lands in the waiting room — pending, listening to
// nothing — until you assign it from the UI, so this only ever populates the
// roster, it never puts anyone into a conversation.

const fs = require('node:fs');
const path = require('node:path');
const { DB_DIR } = require('./db');

const CONFIG_PATH = path.join(DB_DIR, 'config.json');

const DEFAULTS = {
  autoRegisterEnabled: false,
  autoRegisterBase: null,
};

function read() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

function write(patch) {
  const next = { ...read(), ...patch };
  fs.mkdirSync(DB_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n');
  return next;
}

module.exports = { read, write, CONFIG_PATH };
