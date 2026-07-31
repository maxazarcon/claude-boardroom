#!/usr/bin/env node
'use strict';

// Local moderator UI. Binds to 127.0.0.1 only. This is the one thing in the
// project that listens on a port; the MCP server itself is stdio only.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const core = require('./core');
const wiring = require('./wiring');
const config = require('./config');
const { DB_PATH, schemaVersion } = require('./db');

const PORT = Number(process.env.BOARDROOM_UI_PORT || 4737);
const HOST = '127.0.0.1';
const SERVER_JS = wiring.SERVER_JS;
const HOOK_JS = wiring.HOOK_JS;

// How Claude should launch us. The Electron app overrides this at startup so
// generated config points at the installed exe rather than at a bare `node`.
let RUNTIME = wiring.context({});
function setRuntime(ctx) {
  RUNTIME = wiring.context(ctx);
}

// Native capabilities the Electron shell provides. Absent when run from the
// command line, in which case those endpoints report themselves unavailable.
let BRIDGE = null;
function setBridge(bridge) {
  BRIDGE = bridge;
}

/* ------------------------------------------------------------ claude binary */

let cachedBin;
function findClaudeBinary() {
  if (cachedBin !== undefined) return cachedBin;
  const candidates = [];
  if (process.env.CLAUDE_BIN) candidates.push(process.env.CLAUDE_BIN);

  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, ['claude'], { encoding: 'utf8' });
    for (const line of out.split(/\r?\n/)) if (line.trim()) candidates.push(line.trim());
  } catch {
    /* not on PATH — fall through to the usual install locations */
  }

  const home = os.homedir();
  if (process.platform === 'win32') {
    candidates.push(
      path.join(home, '.local', 'bin', 'claude.exe'),
      path.join(home, '.local', 'bin', 'claude.cmd'),
      path.join(process.env.APPDATA || '', 'npm', 'claude.cmd')
    );
  } else {
    candidates.push(
      path.join(home, '.local', 'bin', 'claude'),
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude'
    );
  }

  const found = candidates.filter((c) => c && fs.existsSync(c));

  // `where claude` lists the extensionless npm shim (a bash script) before
  // claude.cmd, and Windows cannot execute the former. Prefer something the
  // OS can actually launch, and never a .ps1.
  if (process.platform === 'win32') {
    const runnable = (f) => /\.(exe|cmd|bat)$/i.test(f);
    cachedBin = found.find(runnable) || found.find((f) => !/\.ps1$/i.test(f)) || null;
  } else {
    cachedBin = found[0] || null;
  }
  return cachedBin;
}

// Our turn prompts are fixed, ASCII, and never interpolate moderator text, so
// they carry nothing a shell would reinterpret. Assert that rather than trust
// it, since this string becomes a command-line argument.
const SHELL_UNSAFE = /["'`$%&|<>^\\\r\n]/;

function beginTurn({ name }) {
  const p = core.participant(name);
  if (!p) return Promise.resolve({ status: 'unregistered', message: `no participant named "${name}"` });
  if (!p.folder_path) {
    return Promise.resolve({
      status: 'no_folder',
      message: `${name} registered without a cwd, so there is no session to trigger. Nudge it from its own app instead.`,
    });
  }
  if (!fs.existsSync(p.folder_path)) {
    return Promise.resolve({
      status: 'error',
      message: `folder does not exist: ${p.folder_path}`,
    });
  }

  const bin = findClaudeBinary();
  if (!bin) {
    return Promise.resolve({
      status: 'error',
      message:
        'Could not find the `claude` CLI. Put it on PATH or start the UI with CLAUDE_BIN=/full/path/to/claude.',
    });
  }

  const status = core.discussionStatus({ name });
  const turn = core.turnPrompt(status);
  if (SHELL_UNSAFE.test(turn.prompt)) {
    return Promise.resolve({ status: 'error', message: 'refusing to run: turn prompt contains shell metacharacters' });
  }

  const mode = p.permission_mode || 'acceptEdits';
  const args = ['-c', '-p', turn.prompt, '--permission-mode', mode];

  // A .cmd/.bat shim cannot be exec'd directly on Windows, so route it through
  // cmd.exe. Everything else is spawned without a shell at all.
  let file = bin;
  let spawnArgs = args;
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    file = process.env.ComSpec || 'cmd.exe';
    spawnArgs = ['/d', '/s', '/c', bin, ...args];
  }

  const started = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, spawnArgs, { cwd: p.folder_path, windowsHide: true });
    } catch (err) {
      return resolve({ status: 'error', message: `spawn failed: ${err.message}` });
    }

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 15 * 60 * 1000).unref?.() ?? null;

    child.stdin.end();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) =>
      resolve({ status: 'error', message: `spawn failed: ${err.message}` })
    );
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const combined = `${stdout}\n${stderr}`;
      // A turn that failed only because the CLI is not signed in is not a
      // boardroom error, and saying "exit 1" helps nobody.
      const authRequired = code !== 0 && wiring.looksLikeAuthFailure(combined);
      resolve({
        status: authRequired ? 'auth_required' : code === 0 ? 'ok' : 'error',
        name,
        folder_path: p.folder_path,
        permission_mode: mode,
        turn_state: turn.state,
        prompt: turn.prompt,
        command: `${bin} -c -p "${turn.prompt}" --permission-mode ${mode}`,
        exit_code: code,
        seconds: Math.round((Date.now() - started) / 1000),
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        message: authRequired
          ? 'The Claude Code CLI is not signed in, so the turn could not run. This is a one-time login, separate from Claude Desktop.'
          : undefined,
      });
    });
  });
}

/* ---------------------------------------------------------- folder detection */

const MARKERS = ['.claude', 'CLAUDE.md', '.mcp.json', path.join('.claude', 'settings.json')];

function scanFolders(base) {
  if (!base) return { status: 'error', message: 'base path is required' };
  let stat;
  try {
    stat = fs.statSync(base);
  } catch {
    return { status: 'error', message: `not found: ${base}` };
  }
  if (!stat.isDirectory()) return { status: 'error', message: `not a directory: ${base}` };

  const entries = fs
    .readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'node_modules');

  const folders = entries.map((e) => {
    const full = path.join(base, e.name);
    const found = MARKERS.filter((m) => {
      try {
        return fs.existsSync(path.join(full, m));
      } catch {
        return false;
      }
    });
    let connected = false;
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(full, '.mcp.json'), 'utf8'));
      connected = Boolean(cfg.mcpServers && cfg.mcpServers.boardroom);
    } catch {
      /* no .mcp.json, or not ours */
    }
    const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
    const joined = core
      .listParticipants({})
      .participants.find((p) => p.folder_path && norm(p.folder_path) === norm(full));

    return {
      name: e.name,
      path: full,
      detected: found.length > 0,
      markers: found,
      boardroom_configured: connected,
      participant: joined ? { name: joined.name, room: joined.room } : null,
    };
  });

  return { status: 'ok', base, folders };
}

function writeMcpJson({ folder }) {
  if (!folder) return { status: 'error', message: 'folder is required' };
  if (!fs.existsSync(folder)) return { status: 'error', message: `not found: ${folder}` };
  const file = path.join(folder, '.mcp.json');

  let cfg = {};
  if (fs.existsSync(file)) {
    try {
      cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return {
        status: 'error',
        message: `${file} exists but is not valid JSON — not overwriting it.`,
      };
    }
  }
  cfg.mcpServers = cfg.mcpServers || {};
  cfg.mcpServers.boardroom = wiring.mcpServerEntry(RUNTIME);
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  return {
    status: 'ok',
    file,
    message: `Wrote ${file}. The next Claude Code session started in that folder picks it up (and will ask you to approve the project server once).`,
  };
}

/* ------------------------------------------------------------------- auto-run */

// Drives a discussion round-robin: gives each participant its speaking turn in
// order, then collects votes, then follows the round the server opens next.
//
// Every step here spawns a real headless Claude run that spends quota and can
// edit files, so this is bounded on every axis and stops rather than guesses:
// one turn at a time, a hard ceiling on total turns, and it halts on anything
// it does not understand instead of retrying forever.
const autorun = {
  active: false,
  room: null,
  step: 'idle',
  detail: null,
  log: [],
  turns: 0,
  maxTurns: 0,
  stopRequested: false,
  lastResult: null,
};

const MAX_ROUNDS = 6;
const STALL_RETRIES = 1;

function autorunState() {
  return {
    active: autorun.active,
    room: autorun.room,
    step: autorun.step,
    detail: autorun.detail,
    turns: autorun.turns,
    max_turns: autorun.maxTurns,
    log: autorun.log.slice(-12),
  };
}

function note(step, detail) {
  autorun.step = step;
  autorun.detail = detail;
  autorun.log.push({ at: new Date().toISOString(), step, detail });
  if (autorun.log.length > 200) autorun.log = autorun.log.slice(-100);
}

function halt(step, detail) {
  note(step, detail);
  autorun.active = false;
  autorun.room = null;
}

function startAutorun({ room }) {
  if (autorun.active) {
    return { status: 'error', message: `already running for "${autorun.room}"` };
  }
  if (!room) return { status: 'error', message: 'room is required' };

  const d = core.discussionStatus({ room });
  if (!d.active) {
    return { status: 'error', message: 'no discussion is running in that room' };
  }

  const drivable = d.order.filter((n) => {
    const p = core.participant(n);
    return p && p.folder_path;
  });
  if (!drivable.length) {
    return {
      status: 'error',
      message:
        'none of the participants in this discussion can be driven — they have no folder to run a turn in',
    };
  }

  autorun.active = true;
  autorun.room = room;
  autorun.stopRequested = false;
  autorun.turns = 0;
  autorun.log = [];
  // Speaking turn + vote per participant per round, plus slack.
  autorun.maxTurns = d.order.length * MAX_ROUNDS * 2 + 4;
  note('starting', `round ${d.round}, ${d.phase} phase`);

  loop().catch((err) => halt('error', err.message));
  return { status: 'ok', ...autorunState() };
}

function stopAutorun() {
  if (!autorun.active) return { status: 'ok', ...autorunState() };
  autorun.stopRequested = true;
  note('stopping', 'will stop after the turn in flight');
  return { status: 'ok', ...autorunState() };
}

async function loop() {
  let stalls = 0;

  while (autorun.active && !autorun.stopRequested) {
    if (autorun.turns >= autorun.maxTurns) {
      return halt('stopped', `hit the ${autorun.maxTurns}-turn ceiling without resolving`);
    }

    const room = autorun.room;
    const d = core.discussionStatus({ room });

    if (!d.active) {
      const last = d.rounds && d.rounds[d.rounds.length - 1];
      return halt(
        'finished',
        d.resolved
          ? `resolved${last ? ` — ${last.yes}/${last.total} agreed in round ${last.round}` : ''}`
          : 'no discussion is running any more'
      );
    }
    if (d.round > MAX_ROUNDS) {
      return halt('stopped', `reached round ${d.round} without agreement`);
    }

    // Who is up: the current speaker, or the first person yet to vote.
    let who = null;
    if (d.phase === 'speaking') {
      who = d.current_speaker;
    } else if (d.phase === 'voting') {
      who = d.order.find((n) => {
        const s = core.discussionStatus({ room, name: n });
        return s.you && !s.you.has_voted;
      });
    }
    if (!who) {
      return halt('stopped', `nothing to do in the ${d.phase} phase`);
    }

    const p = core.participant(who);
    if (!p || !p.folder_path) {
      return halt(
        'waiting',
        `${who} has no folder to run a turn in — nudge it yourself, then start auto-run again`
      );
    }

    const before = JSON.stringify([d.round, d.phase, d.turn_index, d.votes_cast]);
    note('running', `${who} — ${d.phase === 'speaking' ? `speaking, round ${d.round}` : `voting, round ${d.round}`}`);

    const res = await beginTurn({ name: who });
    autorun.turns++;
    autorun.lastResult = { ...res, name: who };

    if (res.status === 'auth_required') {
      return halt('auth_required', 'the Claude Code CLI is not signed in — log in, then start auto-run again');
    }
    if (res.status === 'no_folder' || (res.status === 'error' && !res.exit_code)) {
      return halt('error', `${who}: ${res.message || 'could not start a turn'}`);
    }

    const after = core.discussionStatus({ room });
    const moved = JSON.stringify([after.round, after.phase, after.turn_index, after.votes_cast]) !== before;

    if (moved) {
      stalls = 0;
      continue;
    }

    // The turn ran but the discussion did not move: the participant did not
    // post on its turn, or did not vote. Retry once, then stop and say so
    // rather than burning turns on a participant that is not playing along.
    stalls++;
    if (stalls > STALL_RETRIES) {
      return halt(
        'stalled',
        `${who} took a turn without ${d.phase === 'speaking' ? 'posting' : 'voting'}. ` +
          `Stopped so it does not keep retrying — nudge it yourself, or start auto-run again.`
      );
    }
    note('retrying', `${who} did not ${d.phase === 'speaking' ? 'post' : 'vote'} — trying once more`);
  }

  if (autorun.stopRequested) halt('stopped', 'stopped by you');
}

/* -------------------------------------------------------------- project setup */

// Point auto-registration at a projects folder, or switch it off. Sessions
// started in an immediate subfolder then join the waiting room by themselves.
function setProjectsDir({ base, enabled }) {
  if (enabled === false) {
    return { status: 'ok', ...config.write({ autoRegisterEnabled: false }) };
  }
  if (!base) return { status: 'error', message: 'base is required' };
  if (!fs.existsSync(base)) return { status: 'error', message: `not found: ${base}` };
  if (!fs.statSync(base).isDirectory()) return { status: 'error', message: `not a directory: ${base}` };

  const next = config.write({
    autoRegisterEnabled: enabled === undefined ? true : Boolean(enabled),
    autoRegisterBase: path.resolve(base),
  });
  return {
    status: 'ok',
    ...next,
    message: `Sessions started in immediate subfolders of ${next.autoRegisterBase} will join the waiting room on their next turn.`,
  };
}

// Add one folder as a participant without waiting for a session to run there.
// Useful for projects outside the auto-register base.
function addProject({ folder }) {
  if (!folder) return { status: 'error', message: 'folder is required' };
  if (!fs.existsSync(folder)) return { status: 'error', message: `not found: ${folder}` };
  const res = core.registerFolder({ folder });
  if (res.status === 'exists') {
    return { ...res, message: `Already in the boardroom as "${res.name}".` };
  }
  if (res.status !== 'ok') return res;
  return {
    ...res,
    message: `Added as "${res.name}", waiting for you to assign it to a room.`,
  };
}

/* ---------------------------------------------------------------- setup info */

function setupInfo() {
  const desktopConfigPath =
    process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
      : path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');

  const entry = wiring.mcpServerEntry(RUNTIME);
  const addArgs = [entry.command, ...entry.args].map((a) => `"${a}"`).join(' ');
  const envFlags = Object.entries(entry.env || {})
    .map(([k, v]) => `-e ${k}=${v} `)
    .join('');

  return {
    status: 'ok',
    db_path: DB_PATH,
    schema_version: schemaVersion(),
    server_js: SERVER_JS,
    hook_js: HOOK_JS,
    hook_shim: wiring.SHIM,
    platform: process.platform,
    packaged: RUNTIME.packaged,
    mcp_add_command: `claude mcp add boardroom ${envFlags}-- ${addArgs}`,
    desktop_config_path: desktopConfigPath,
    desktop_config_block: JSON.stringify({ mcpServers: { boardroom: entry } }, null, 2),
    hook_block: JSON.stringify(
      {
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: wiring.hookCommand() }] },
          ],
        },
      },
      null,
      2
    ),
  };
}

/* -------------------------------------------------------------------- routing */

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const route = url.pathname;

  try {
    if (req.method === 'GET' && (route === '/' || route === '/index.html')) {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (req.method === 'GET') {
      switch (route) {
        case '/api/state':
          return json(res, 200, {
            ...core.listRooms(),
            participants: core.listParticipants({}).participants,
          });
        case '/api/room': {
          const room = url.searchParams.get('name');
          if (!room) return json(res, 400, { status: 'error', message: 'name is required' });
          return json(res, 200, {
            status: 'ok',
            room,
            participants: core.listParticipants({ room }).participants.map((p) => ({
              ...p,
              turn: core.turnPrompt(core.discussionStatus({ name: p.name })),
            })),
            messages: core.roomMessages({ room }),
            discussion: core.discussionStatus({ room }),
            autorun: autorunState(),
          });
        }
        case '/api/folders':
          return json(res, 200, scanFolders(url.searchParams.get('base')));
        case '/api/setup':
          return json(res, 200, setupInfo());
        case '/api/status':
          return json(res, 200, require('../setup/install').status(RUNTIME));
        case '/api/app':
          return json(res, 200, BRIDGE ? await BRIDGE.appInfo() : { status: 'ok', shell: false });
      }
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      switch (route) {
        case '/api/rooms':
          return json(res, 200, core.createRoom(body));
        case '/api/assign':
          return json(res, 200, core.assignRoom(body));
        case '/api/broadcast':
          return json(res, 200, core.broadcast(body));
        case '/api/discussion': {
          const started = core.startDiscussion(body);
          // Starting the round-robin with the discussion is the normal case —
          // the moderator sets the topic and order, then it runs itself.
          if (started.status === 'ok' && body.autorun) {
            const run = startAutorun({ room: body.room });
            return json(res, 200, { ...started, autorun: run });
          }
          return json(res, 200, started);
        }
        case '/api/permission-mode':
          return json(res, 200, core.setPermissionMode(body));
        case '/api/forget':
          return json(res, 200, core.forgetParticipant(body));
        case '/api/mcp-json':
          return json(res, 200, writeMcpJson(body));
        case '/api/begin-turn':
          return json(res, 200, await beginTurn(body));
        case '/api/projects-dir':
          return json(res, 200, setProjectsDir(body));
        case '/api/add-project':
          return json(res, 200, addProject(body));
        case '/api/autorun/start':
          return json(res, 200, startAutorun(body));
        case '/api/autorun/stop':
          return json(res, 200, stopAutorun());

        // Everything below needs the Electron shell.
        case '/api/pick-folder':
        case '/api/check-update':
        case '/api/install-update':
        case '/api/auto-start':
        case '/api/open-login':
        case '/api/rewire': {
          if (!BRIDGE) {
            return json(res, 200, {
              status: 'unavailable',
              message: 'only available in the Claude Boardroom app, not the command-line UI',
            });
          }
          const fn = {
            '/api/pick-folder': 'pickFolder',
            '/api/check-update': 'checkUpdate',
            '/api/install-update': 'installUpdate',
            '/api/auto-start': 'setAutoStart',
            '/api/open-login': 'openLogin',
            '/api/rewire': 'rewire',
          }[route];
          return json(res, 200, await BRIDGE[fn](body));
        }
      }
    }

    json(res, 404, { status: 'error', message: 'not found' });
  } catch (err) {
    json(res, 500, { status: 'error', message: err.message });
  }
});

// Listens on the given port, falling back to the next few if it is taken —
// otherwise a stale instance would stop the app from starting at all.
function listen(port = PORT, attemptsLeft = 5) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
        server.removeListener('error', onError);
        return resolve(listen(port + 1, attemptsLeft - 1));
      }
      reject(err);
    };
    server.once('error', onError);
    server.listen(port, HOST, () => {
      server.removeListener('error', onError);
      resolve({ port, url: `http://${HOST}:${port}` });
    });
  });
}

module.exports = {
  findClaudeBinary,
  scanFolders,
  setupInfo,
  startAutorun,
  stopAutorun,
  autorunState,
  server,
  listen,
  setBridge,
  setRuntime,
  HOST,
  PORT,
};

// Only listen when run directly, so the pieces above stay importable.
if (require.main !== module) return;

listen().then(({ url }) => {
  process.stdout.write(`Claude Boardroom UI  ->  ${url}\n`);
  process.stdout.write(`Database             ->  ${DB_PATH}\n`);
  const bin = findClaudeBinary();
  process.stdout.write(
    bin
      ? `claude CLI           ->  ${bin}\n`
      : 'claude CLI           ->  NOT FOUND (Begin Turn will be unavailable; set CLAUDE_BIN)\n'
  );
});
