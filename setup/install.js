#!/usr/bin/env node
'use strict';

// Wires the boardroom into Claude Code and Claude Desktop.
//
//   node setup/install.js [--projects <dir>] [--no-auto-register]
//   node setup/install.js --uninstall
//
// Also importable: the packaged app calls apply() on every launch so the
// config keeps pointing at the current install after an update, without the
// user ever re-running anything.
//
// Every write is a read-merge-write that preserves the rest of the file, is
// backed up first, and is idempotent — applying twice changes nothing the
// second time. Nothing here connects a session; it only puts config in place
// so the next session started picks the boardroom up.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const wiring = require('../src/wiring');
const { DB_DIR } = require('../src/db');

const HOME = os.homedir();
const CLAUDE_JSON = path.join(HOME, '.claude.json');
const CLAUDE_SETTINGS = path.join(HOME, '.claude', 'settings.json');
const DESKTOP_CONFIG =
  process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
    : path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');

/* ----------------------------------------------------------------- file I/O */

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw); // throw loudly rather than clobber a file we can't parse
}

function makeBackupDir() {
  return path.join(DB_DIR, 'config-backups', new Date().toISOString().replace(/[:.]/g, '-'));
}

function writeJson(file, data, state) {
  if (fs.existsSync(file)) {
    fs.mkdirSync(state.backupDir, { recursive: true });
    fs.copyFileSync(file, path.join(state.backupDir, path.basename(file)));
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write beside the target then rename, so a crash cannot leave a torn config.
  const tmp = `${file}.boardroom-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/* ------------------------------------------------------------------- targets */

function mcpServers(file, label, { create, remove, entry }, state) {
  let cfg;
  try {
    cfg = readJson(file);
  } catch (err) {
    state.problems.push(`${label}: ${path.basename(file)} is not valid JSON, left alone (${err.message})`);
    return;
  }
  if (cfg === null) {
    if (!create) return state.skipped.push(`${label}: ${file} does not exist`);
    cfg = {};
  }

  if (remove) {
    if (cfg.mcpServers && cfg.mcpServers.boardroom) {
      delete cfg.mcpServers.boardroom;
      if (!Object.keys(cfg.mcpServers).length) delete cfg.mcpServers;
      writeJson(file, cfg, state);
      state.changes.push(`${label}: removed`);
    } else {
      state.skipped.push(`${label}: nothing to remove`);
    }
    return;
  }

  const current = cfg.mcpServers && cfg.mcpServers.boardroom;
  if (current && JSON.stringify(current) === JSON.stringify(entry)) {
    return state.skipped.push(`${label}: already correct`);
  }
  cfg.mcpServers = cfg.mcpServers || {};
  cfg.mcpServers.boardroom = entry;
  writeJson(file, cfg, state);
  state.changes.push(`${label}: ${current ? 'updated to current install' : 'registered'}`);
}

function hook({ remove, command }, state) {
  const label = 'Claude Code hook';
  let cfg;
  try {
    cfg = readJson(CLAUDE_SETTINGS) || {};
  } catch (err) {
    state.problems.push(`${label}: settings.json is not valid JSON, left alone (${err.message})`);
    return;
  }

  const groups = (cfg.hooks && cfg.hooks.UserPromptSubmit) || [];
  const isOurs = (h) => typeof h.command === 'string' && h.command.includes('boardroom-hook');

  if (remove) {
    if (!groups.some((g) => (g.hooks || []).some(isOurs))) {
      return state.skipped.push(`${label}: nothing to remove`);
    }
    const cleaned = groups
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length);
    cfg.hooks.UserPromptSubmit = cleaned;
    if (!cleaned.length) delete cfg.hooks.UserPromptSubmit;
    if (cfg.hooks && !Object.keys(cfg.hooks).length) delete cfg.hooks;
    writeJson(CLAUDE_SETTINGS, cfg, state);
    return state.changes.push(`${label}: removed`);
  }

  const ours = groups.flatMap((g) => (g.hooks || []).filter(isOurs));
  if (ours.length === 1 && ours[0].command === command) {
    return state.skipped.push(`${label}: already correct`);
  }

  // Drop any stale entries of ours (e.g. one pointing at a previous install
  // layout) and add exactly one current entry.
  const cleaned = groups
    .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) }))
    .filter((g) => g.hooks.length);

  cfg.hooks = cfg.hooks || {};
  cfg.hooks.UserPromptSubmit = cleaned.concat([
    { hooks: [{ type: 'command', command }] },
  ]);
  writeJson(CLAUDE_SETTINGS, cfg, state);
  state.changes.push(`${label}: ${ours.length ? 'updated to current install' : 'installed'}`);
}

function autoRegister({ remove, projectsDir }, state) {
  const label = 'auto-register';
  const file = path.join(DB_DIR, 'config.json');
  const existing = (() => {
    try {
      return readJson(file) || {};
    } catch {
      return {};
    }
  })();

  if (remove) {
    if (!fs.existsSync(file)) return state.skipped.push(`${label}: nothing to remove`);
    writeJson(file, { ...existing, autoRegisterEnabled: false }, state);
    return state.changes.push(`${label}: disabled`);
  }

  // No --projects on a re-apply must not switch auto-register off; leave
  // whatever the user already chose alone.
  if (!projectsDir) return state.skipped.push(`${label}: left as-is`);

  if (!fs.existsSync(projectsDir)) {
    return state.problems.push(`${label}: ${projectsDir} does not exist`);
  }
  const next = {
    ...existing,
    autoRegisterEnabled: true,
    autoRegisterBase: path.resolve(projectsDir),
  };
  if (JSON.stringify(next) === JSON.stringify(existing)) {
    return state.skipped.push(`${label}: already correct`);
  }
  writeJson(file, next, state);
  state.changes.push(`${label}: enabled for ${next.autoRegisterBase}`);
}

/* ---------------------------------------------------------------------- API */

// ctx: { packaged, execPath } — how Claude should launch us.
// opts: { projectsDir, remove, disableAutoRegister }
function apply(ctx = {}, opts = {}) {
  const state = { changes: [], skipped: [], problems: [], backupDir: makeBackupDir() };
  const remove = Boolean(opts.remove);

  const shim = remove ? { path: wiring.SHIM } : wiring.writeHookShim(ctx);
  if (!remove && shim.changed) state.changes.push('hook shim: written');

  const entry = wiring.mcpServerEntry(ctx);

  mcpServers(CLAUDE_JSON, 'Claude Code MCP', { create: true, remove, entry }, state);
  hook({ remove, command: wiring.hookCommand() }, state);
  autoRegister(
    { remove: remove || opts.disableAutoRegister, projectsDir: opts.projectsDir },
    state
  );
  mcpServers(DESKTOP_CONFIG, 'Claude Desktop MCP', { create: false, remove, entry }, state);

  return {
    ...state,
    entry,
    hookCommand: wiring.hookCommand(),
    desktopConfigPath: DESKTOP_CONFIG,
    backupDir: state.changes.length ? state.backupDir : null,
  };
}

module.exports = { apply, CLAUDE_JSON, CLAUDE_SETTINGS, DESKTOP_CONFIG };

/* ---------------------------------------------------------------------- CLI */

if (require.main === module) {
  const args = process.argv.slice(2);
  const projectsIdx = args.indexOf('--projects');
  const opts = {
    remove: args.includes('--uninstall'),
    disableAutoRegister: args.includes('--no-auto-register'),
    projectsDir: projectsIdx >= 0 ? args[projectsIdx + 1] : null,
  };

  console.log(opts.remove ? 'Removing Claude Boardroom wiring...\n' : 'Installing Claude Boardroom...\n');
  const res = apply({}, opts);

  for (const c of res.changes) console.log(`  ok  ${c}`);
  for (const s of res.skipped) console.log(`  --  ${s}`);
  for (const p of res.problems) console.log(`  !!  ${p}`);

  console.log('\n' + '-'.repeat(64));
  if (!res.changes.length) {
    console.log('Nothing to do — everything was already in the state you asked for.');
  } else if (res.backupDir) {
    console.log(`Backups of every file touched: ${res.backupDir}`);
  }

  if (!opts.remove) {
    console.log('\nNext:');
    console.log('  1. Restart Claude Desktop completely (quit it, not just close the window).');
    console.log('  2. Start a new Claude Code session — running ones keep their old config.');
  }
  process.exit(res.problems.length ? 1 : 0);
}
