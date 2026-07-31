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
      resolve({
        status: code === 0 ? 'ok' : 'error',
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
    return {
      name: e.name,
      path: full,
      detected: found.length > 0,
      markers: found,
      boardroom_configured: connected,
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
          });
        }
        case '/api/folders':
          return json(res, 200, scanFolders(url.searchParams.get('base')));
        case '/api/setup':
          return json(res, 200, setupInfo());
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
        case '/api/discussion':
          return json(res, 200, core.startDiscussion(body));
        case '/api/permission-mode':
          return json(res, 200, core.setPermissionMode(body));
        case '/api/forget':
          return json(res, 200, core.forgetParticipant(body));
        case '/api/mcp-json':
          return json(res, 200, writeMcpJson(body));
        case '/api/begin-turn':
          return json(res, 200, await beginTurn(body));

        // Everything below needs the Electron shell.
        case '/api/pick-folder':
        case '/api/check-update':
        case '/api/install-update':
        case '/api/auto-start':
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
