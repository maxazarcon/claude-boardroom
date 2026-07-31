#!/usr/bin/env node
'use strict';

// UserPromptSubmit hook. Runs before each turn in a connected Claude Code
// session (including headless `claude -p` runs, which is what makes Begin Turn
// work), pulls anything new out of the boardroom and injects it into context.
//
// It identifies the session by matching the hook's `cwd` against the
// folder_path a participant registered with. Set BOARDROOM_NAME in the
// environment to override that, e.g. if one folder hosts two names.
//
// It reads the same SQLite file the MCP server writes, calling the same
// getMessages() the tool calls, so the cursor advances exactly once — messages
// injected here will not come back again from a manual get_messages call.

const path = require('node:path');
const core = require('../src/core');
const config = require('../src/config');
const { all } = require('../src/db');

const norm = (p) =>
  !p ? '' : path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
    setTimeout(() => resolve(data), 2000).unref();
  });
}

function resolveName(cwd) {
  if (process.env.BOARDROOM_NAME) return process.env.BOARDROOM_NAME;
  const target = norm(cwd);
  if (!target) return null;
  const rows = all('SELECT name, folder_path FROM participants WHERE folder_path IS NOT NULL');
  const hit = rows.find((r) => norm(r.folder_path) === target);
  if (hit) return hit.name;
  return autoRegister(cwd);
}

// Optional: register a session the first time it runs in a folder directly
// under the configured projects directory, so nothing has to be registered by
// hand. It lands in the waiting room and stays inert until assigned.
function autoRegister(cwd) {
  const { autoRegisterEnabled, autoRegisterBase } = config.read();
  if (!autoRegisterEnabled || !autoRegisterBase) return null;

  const base = norm(autoRegisterBase);
  const folder = norm(cwd);
  // Immediate children of the base only — not the base itself, not deeper.
  if (path.dirname(folder) !== base) return null;

  const taken = new Set(
    all('SELECT name FROM participants').map((r) => r.name.toLowerCase())
  );
  let name = path.basename(path.resolve(cwd));
  if (taken.has(name.toLowerCase())) {
    // Same folder name in a different location — keep both distinguishable.
    let i = 2;
    while (taken.has(`${name}-${i}`.toLowerCase())) i++;
    name = `${name}-${i}`;
  }

  const res = core.register({ name, cwd });
  return res.status === 'ok' ? res.name : null;
}

function render(name, res) {
  const lines = [];
  lines.push('=== Claude Boardroom ===');
  lines.push(`You are participant "${name}".`);

  if (res.status === 'pending') {
    lines.push(
      'You are in the waiting room — not assigned to any room yet, so there is nothing to read and post_message is a no-op. Carry on with whatever the user asked.'
    );
    return lines.join('\n');
  }

  lines.push(`Room: ${res.room}`);

  if (res.messages.length === 0) {
    lines.push('No new messages since your last turn.');
  } else {
    lines.push(
      `${res.messages.length} new message(s). These have already been delivered to you — calling get_messages again will not return them a second time.`
    );
    lines.push('');
    for (const m of res.messages) {
      const who =
        m.kind === 'moderator'
          ? `MODERATOR (${m.sender})`
          : m.kind === 'system'
            ? 'SYSTEM'
            : m.sender;
      lines.push(`[#${m.id}] ${who}: ${m.body}`);
    }
  }

  const d = res.discussion;
  if (d && d.active) {
    lines.push('');
    lines.push(`--- Discussion in progress: round ${d.round}, ${d.phase} phase ---`);
    lines.push(`Issue: ${d.prompt}`);
    lines.push(`Speaking order: ${d.order.join(' -> ')}`);
    if (d.rounds.length) {
      lines.push(
        `Previous rounds: ${d.rounds
          .map((r) => `round ${r.round} — ${r.yes}/${r.total} agreed`)
          .join('; ')}`
      );
    }
    const you = d.you || {};
    if (!you.in_discussion) {
      lines.push('You are not in this discussion\'s speaking order — read along, but stay out of the turn order.');
    } else if (d.phase === 'speaking' && you.is_your_turn) {
      lines.push(
        'IT IS YOUR TURN TO SPEAK. Post your contribution with post_message; that both records it and advances the turn to the next participant.'
      );
    } else if (d.phase === 'speaking') {
      lines.push(
        `Waiting on ${d.current_speaker} to speak. You may still post normal messages, but they will not advance the turn.`
      );
    } else if (d.phase === 'voting' && !you.has_voted) {
      lines.push(
        `IT IS VOTING TIME AND YOU HAVE NOT VOTED. Call cast_vote(name, resolved) — true if the issue has been addressed, false if it needs another round. ${d.votes_cast} of ${d.votes_total} have voted so far; nobody can see which way until all are in.`
      );
    } else if (d.phase === 'voting') {
      lines.push(
        `You have already voted this round. ${d.votes_cast} of ${d.votes_total} votes are in; waiting on the rest.`
      );
    }
  } else if (d && d.resolved) {
    const last = d.rounds[d.rounds.length - 1];
    lines.push('');
    lines.push(
      `--- The discussion in this room is resolved${
        last ? ` (${last.yes}/${last.total} agreed in round ${last.round})` : ''
      }. Nothing to vote on until the moderator starts a new one. ---`
    );
  }

  return lines.join('\n');
}

async function main() {
  let input = {};
  try {
    input = JSON.parse((await readStdin()) || '{}');
  } catch {
    input = {};
  }

  const cwd = input.cwd || process.cwd();
  const name = resolveName(cwd);
  if (!name) return; // this folder is not a registered participant — stay silent

  const res = core.getMessages({ name });
  if (res.status === 'unregistered') return;

  const context = render(name, res);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: context,
      },
    })
  );
}

// A hook must never break the turn it runs before.
main()
  .catch((err) => {
    process.stderr.write(`[boardroom-hook] ${err.message}\n`);
  })
  .finally(() => process.exit(0));
