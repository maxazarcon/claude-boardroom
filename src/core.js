'use strict';

// All boardroom behaviour lives here. The MCP server, the UI server and the
// UserPromptSubmit hook all call these same functions against the same SQLite
// file, so a session sees exactly what the UI sees.

const path = require('node:path');
const { all, get, run, now } = require('./db');

const WAITING = null; // room === null means "waiting room", i.e. unassigned

/* ------------------------------------------------------------------ helpers */

function participant(name) {
  return get('SELECT * FROM participants WHERE name = ?', name) || null;
}

function touch(name) {
  run('UPDATE participants SET last_seen = ? WHERE name = ?', now(), name);
}

function ensureRoom(room) {
  run('INSERT OR IGNORE INTO rooms (name, created_at) VALUES (?, ?)', room, now());
}

function insertMessage(room, sender, body, kind) {
  const info = run(
    'INSERT INTO messages (room, sender, body, kind, created_at) VALUES (?, ?, ?, ?, ?)',
    room,
    sender,
    body,
    kind,
    now()
  );
  return Number(info.lastInsertRowid);
}

function activeDiscussion(room) {
  if (!room) return null;
  const d = get(
    'SELECT * FROM discussions WHERE room = ? ORDER BY id DESC LIMIT 1',
    room
  );
  if (!d) return null;
  d.order = JSON.parse(d.order);
  return d;
}

function roundVotes(discussionId, round) {
  return all(
    'SELECT name, vote FROM votes WHERE discussion_id = ? AND round = ?',
    discussionId,
    round
  );
}

// Tallies for rounds that finished. A round only becomes visible once every
// participant in `order` has voted in it, which is what keeps votes secret.
function completedRounds(discussion) {
  const rows = all(
    'SELECT round, COUNT(*) AS cast, SUM(vote) AS yes FROM votes WHERE discussion_id = ? GROUP BY round ORDER BY round',
    discussion.id
  );
  const total = discussion.order.length;
  return rows
    .filter((r) => Number(r.cast) >= total)
    .map((r) => ({ round: Number(r.round), yes: Number(r.yes), total }));
}

/* -------------------------------------------------------------- registration */

function register({ name, cwd }) {
  if (!name || !String(name).trim()) {
    return { status: 'error', message: 'name is required' };
  }
  name = String(name).trim();
  const existing = participant(name);
  const folder = cwd ? String(cwd) : null;

  if (existing) {
    // Re-registering keeps the room assignment; it just refreshes the cwd.
    run(
      'UPDATE participants SET last_seen = ?, folder_path = COALESCE(?, folder_path) WHERE name = ?',
      now(),
      folder,
      name
    );
  } else {
    run(
      'INSERT INTO participants (name, room, last_seen, folder_path, since_id, permission_mode, registered_at) VALUES (?, NULL, ?, ?, 0, ?, ?)',
      name,
      now(),
      folder,
      'acceptEdits',
      now()
    );
  }

  const p = participant(name);
  return {
    status: 'ok',
    name: p.name,
    room: p.room,
    folder_path: p.folder_path,
    waiting: p.room === WAITING,
    message:
      p.room === WAITING
        ? 'Registered. You are in the waiting room until a moderator assigns you to a room.'
        : `Registered. You are assigned to room "${p.room}".`,
  };
}

// Register a folder under its own name. Used both by the hook (when a session
// starts somewhere we auto-register) and by the setup panel (when you add a
// project by hand), so the two agree on naming.
function registerFolder({ folder }) {
  if (!folder) return { status: 'error', message: 'folder is required' };

  const target = path.resolve(String(folder));
  const rows = all('SELECT name, folder_path FROM participants');

  const same = (a, b) =>
    a && b && path.resolve(a).replace(/[\\/]+$/, '').toLowerCase() ===
      path.resolve(b).replace(/[\\/]+$/, '').toLowerCase();

  const existing = rows.find((r) => same(r.folder_path, target));
  if (existing) {
    const p = participant(existing.name);
    return { status: 'exists', name: p.name, room: p.room, folder_path: p.folder_path };
  }

  const taken = new Set(rows.map((r) => r.name.toLowerCase()));
  let name = path.basename(target);
  if (taken.has(name.toLowerCase())) {
    let i = 2;
    while (taken.has(`${name}-${i}`.toLowerCase())) i++;
    name = `${name}-${i}`;
  }

  const res = register({ name, cwd: target });
  return res.status === 'ok' ? { ...res, created: true } : res;
}

/* -------------------------------------------------------------------- posting */

function postMessage({ name, body }) {
  const p = participant(name);
  if (!p) {
    return {
      status: 'unregistered',
      message: 'call register(name) first',
    };
  }
  touch(name);
  if (p.room === WAITING) {
    return { status: 'pending', message: 'not yet assigned to a room' };
  }
  if (body === undefined || body === null || !String(body).length) {
    return { status: 'error', message: 'body is required' };
  }

  const id = insertMessage(p.room, p.name, String(body), 'participant');

  // If this landed on the sender's speaking turn, it advances the discussion.
  let turnAdvanced = false;
  const d = activeDiscussion(p.room);
  if (
    d &&
    d.phase === 'speaking' &&
    d.order[d.turn_index] === p.name
  ) {
    turnAdvanced = true;
    const next = d.turn_index + 1;
    if (next >= d.order.length) {
      run(
        'UPDATE discussions SET phase = ?, turn_index = ? WHERE id = ?',
        'voting',
        next,
        d.id
      );
      insertMessage(
        p.room,
        'system',
        `[system] Everyone has spoken in round ${d.round}. Voting is now open — each participant should call cast_vote(name, resolved). Votes stay hidden until all ${d.order.length} are in.`,
        'system'
      );
    } else {
      run('UPDATE discussions SET turn_index = ? WHERE id = ?', next, d.id);
    }
  }

  return {
    status: 'ok',
    id,
    room: p.room,
    turn_advanced: turnAdvanced,
    discussion: discussionStatus({ room: p.room, name: p.name }),
  };
}

function broadcast({ room, body }) {
  if (!room) return { status: 'error', message: 'room is required' };
  if (!body || !String(body).length) {
    return { status: 'error', message: 'body is required' };
  }
  ensureRoom(room);
  const id = insertMessage(room, 'moderator', String(body), 'moderator');
  return { status: 'ok', id, room };
}

/* -------------------------------------------------------------------- reading */

function getMessages({ name, since_id }) {
  const p = participant(name);
  if (!p) {
    return { status: 'unregistered', messages: [], message: 'call register(name) first' };
  }
  touch(name);
  if (p.room === WAITING) {
    return {
      status: 'pending',
      room: null,
      messages: [],
      message: 'not yet assigned to a room',
    };
  }

  // An explicit since_id wins; otherwise use the cursor the server keeps for
  // this participant (assign_room resets it to 0 so a new arrival reads all).
  const since =
    since_id === undefined || since_id === null ? Number(p.since_id) : Number(since_id);

  const rows = all(
    'SELECT id, room, sender, body, kind, created_at FROM messages WHERE room = ? AND id > ? ORDER BY id',
    p.room,
    since
  );

  if (rows.length) {
    const maxId = rows[rows.length - 1].id;
    if (maxId > Number(p.since_id)) {
      run('UPDATE participants SET since_id = ? WHERE name = ?', maxId, name);
    }
  }

  return {
    status: 'ok',
    room: p.room,
    since_id: since,
    messages: rows,
    discussion: discussionStatus({ room: p.room, name: p.name }),
  };
}

function listParticipants({ room } = {}) {
  let rows;
  if (room === undefined) {
    rows = all('SELECT * FROM participants ORDER BY name');
  } else if (room === null || room === '' || room === 'waiting') {
    rows = all('SELECT * FROM participants WHERE room IS NULL ORDER BY name');
  } else {
    rows = all('SELECT * FROM participants WHERE room = ? ORDER BY name', room);
  }
  return {
    status: 'ok',
    participants: rows.map((p) => ({
      name: p.name,
      room: p.room,
      last_seen: p.last_seen,
      folder_path: p.folder_path,
      permission_mode: p.permission_mode,
      can_begin_turn: Boolean(p.folder_path),
    })),
  };
}

function listRooms() {
  const rooms = all('SELECT name, created_at FROM rooms ORDER BY name').map((r) => {
    const count = get(
      'SELECT COUNT(*) AS n FROM participants WHERE room = ?',
      r.name
    ).n;
    const last = get(
      'SELECT MAX(id) AS id FROM messages WHERE room = ?',
      r.name
    ).id;
    return {
      name: r.name,
      created_at: r.created_at,
      participants: Number(count),
      last_message_id: last ? Number(last) : 0,
    };
  });
  const waiting = Number(
    get('SELECT COUNT(*) AS n FROM participants WHERE room IS NULL').n
  );
  return { status: 'ok', rooms, waiting_room: waiting };
}

function createRoom({ name }) {
  if (!name || !String(name).trim()) {
    return { status: 'error', message: 'name is required' };
  }
  name = String(name).trim();
  const existed = Boolean(get('SELECT name FROM rooms WHERE name = ?', name));
  ensureRoom(name);
  return { status: existed ? 'exists' : 'ok', room: name };
}

/* ------------------------------------------------------------------ assignment */

function assignRoom({ name, room }) {
  const p = participant(name);
  if (!p) return { status: 'unregistered', message: `no participant named "${name}"` };

  const target = room === undefined || room === null || room === '' || room === 'waiting'
    ? WAITING
    : String(room).trim();

  if (target === WAITING) {
    run(
      'UPDATE participants SET room = NULL, since_id = 0, last_seen = ? WHERE name = ?',
      now(),
      name
    );
    return {
      status: 'ok',
      name,
      room: null,
      message: `${name} was sent back to the waiting room.`,
    };
  }

  ensureRoom(target);
  // since_id back to 0 so the first poll after joining returns the room's
  // whole history, not just what lands after the join.
  run(
    'UPDATE participants SET room = ?, since_id = 0, last_seen = ? WHERE name = ?',
    target,
    now(),
    name
  );
  insertMessage(
    target,
    'system',
    `[system] ${name} has joined the room. Could someone summarize where things stand?`,
    'system'
  );

  return {
    status: 'ok',
    name,
    room: target,
    previous_room: p.room,
    message: `${name} assigned to "${target}". Their next get_messages returns the full room history.`,
  };
}

function setPermissionMode({ name, permission_mode }) {
  const modes = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
  if (!modes.includes(permission_mode)) {
    return { status: 'error', message: `permission_mode must be one of ${modes.join(', ')}` };
  }
  const p = participant(name);
  if (!p) return { status: 'unregistered', message: `no participant named "${name}"` };
  run('UPDATE participants SET permission_mode = ? WHERE name = ?', permission_mode, name);
  return { status: 'ok', name, permission_mode };
}

function forgetParticipant({ name }) {
  const p = participant(name);
  if (!p) return { status: 'unregistered', message: `no participant named "${name}"` };
  run('DELETE FROM participants WHERE name = ?', name);
  return { status: 'ok', name };
}

/* ------------------------------------------------------------------ discussion */

function startDiscussion({ room, prompt, order }) {
  if (!room) return { status: 'error', message: 'room is required' };
  if (!prompt || !String(prompt).trim()) {
    return { status: 'error', message: 'prompt is required' };
  }
  if (!Array.isArray(order) || order.length === 0) {
    return { status: 'error', message: 'order must be a non-empty list of participant names' };
  }

  const assigned = new Set(
    all('SELECT name FROM participants WHERE room = ?', room).map((r) => r.name)
  );
  const missing = order.filter((n) => !assigned.has(n));
  if (missing.length) {
    return {
      status: 'error',
      message: `not assigned to "${room}": ${missing.join(', ')}`,
    };
  }

  ensureRoom(room);
  const info = run(
    'INSERT INTO discussions (room, prompt, "order", round, phase, turn_index, created_at) VALUES (?, ?, ?, 1, ?, 0, ?)',
    room,
    String(prompt),
    JSON.stringify(order),
    'speaking',
    now()
  );
  const id = Number(info.lastInsertRowid);

  insertMessage(room, 'moderator', String(prompt), 'moderator');
  insertMessage(
    room,
    'system',
    `[system] Discussion started. Round 1, speaking phase. Speaking order: ${order.join(
      ' -> '
    )}. ${order[0]} is up first.`,
    'system'
  );

  return { status: 'ok', discussion_id: id, ...discussionStatus({ room }) };
}

function discussionStatus({ room, name } = {}) {
  // A session knows its own name but never a room name, so allow either.
  let targetRoom = room;
  if (!targetRoom && name) {
    const p = participant(name);
    if (!p) return { status: 'unregistered', active: false };
    if (p.room === WAITING) return { status: 'pending', active: false };
    targetRoom = p.room;
  }
  if (!targetRoom) return { status: 'error', active: false, message: 'room or name is required' };

  const d = activeDiscussion(targetRoom);
  if (!d) return { status: 'ok', active: false, room: targetRoom };

  const resolved = d.phase === 'resolved';
  const votes = roundVotes(d.id, d.round);
  const out = {
    status: 'ok',
    active: !resolved,
    resolved,
    room: targetRoom,
    discussion_id: d.id,
    prompt: d.prompt,
    order: d.order,
    round: d.round,
    phase: d.phase,
    turn_index: d.turn_index,
    current_speaker: d.phase === 'speaking' ? d.order[d.turn_index] || null : null,
    votes_cast: d.phase === 'voting' ? votes.length : 0,
    votes_total: d.order.length,
    rounds: completedRounds(d),
  };

  if (name) {
    const inOrder = d.order.includes(name);
    out.you = {
      name,
      in_discussion: inOrder,
      is_your_turn: !resolved && d.phase === 'speaking' && d.order[d.turn_index] === name,
      voting_open: !resolved && d.phase === 'voting' && inOrder,
      has_voted: votes.some((v) => v.name === name),
    };
  }

  return out;
}

function castVote({ name, resolved }) {
  const p = participant(name);
  if (!p) return { status: 'unregistered', message: 'call register(name) first' };
  touch(name);
  if (p.room === WAITING) {
    return { status: 'pending', message: 'not yet assigned to a room' };
  }

  const d = activeDiscussion(p.room);
  if (!d) {
    return { status: 'no_discussion', message: `no discussion is running in "${p.room}"` };
  }
  if (d.phase === 'resolved') {
    return { status: 'resolved', message: 'this discussion is already resolved; nothing to vote on' };
  }
  if (d.phase !== 'voting') {
    return {
      status: 'not_voting',
      message: `round ${d.round} is still in the speaking phase; ${d.order[d.turn_index]} is up`,
      round: d.round,
      phase: d.phase,
    };
  }
  if (!d.order.includes(name)) {
    return { status: 'not_in_discussion', message: `${name} is not in this discussion's order` };
  }
  if (typeof resolved !== 'boolean') {
    return { status: 'error', message: 'resolved must be a boolean' };
  }

  run(
    'INSERT INTO votes (discussion_id, round, name, vote, voted_at) VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT (discussion_id, round, name) DO UPDATE SET vote = excluded.vote, voted_at = excluded.voted_at',
    d.id,
    d.round,
    name,
    resolved ? 1 : 0,
    now()
  );

  const votes = roundVotes(d.id, d.round);
  const total = d.order.length;

  if (votes.length < total) {
    return {
      status: 'ok',
      message: `Vote recorded. ${votes.length} of ${total} have voted; results stay hidden until everyone has.`,
      votes_cast: votes.length,
      votes_total: total,
    };
  }

  // Round complete — now, and only now, the tally becomes visible.
  const yes = votes.filter((v) => v.vote === 1).length;
  if (yes === total) {
    run('UPDATE discussions SET phase = ? WHERE id = ?', 'resolved', d.id);
    insertMessage(
      p.room,
      'system',
      `[system] ${yes}/${total} agreed the issue is addressed. Discussion resolved after round ${d.round}.`,
      'system'
    );
    return {
      status: 'ok',
      round_complete: true,
      resolved: true,
      yes,
      total,
      message: `${yes}/${total} agreed. Discussion resolved.`,
    };
  }

  const nextRound = d.round + 1;
  run(
    'UPDATE discussions SET round = ?, phase = ?, turn_index = 0 WHERE id = ?',
    nextRound,
    'speaking',
    d.id
  );
  insertMessage(
    p.room,
    'system',
    `[system] ${yes}/${total} agreed. Starting round ${nextRound}, speaking phase. ${d.order[0]} is up first.`,
    'system'
  );
  return {
    status: 'ok',
    round_complete: true,
    resolved: false,
    yes,
    total,
    next_round: nextRound,
    message: `${yes}/${total} agreed. Starting round ${nextRound}.`,
  };
}

/* --------------------------------------------------------------- UI read model */

function roomMessages({ room, limit = 200 }) {
  return all(
    'SELECT id, room, sender, body, kind, created_at FROM (SELECT * FROM messages WHERE room = ? ORDER BY id DESC LIMIT ?) ORDER BY id',
    room,
    Number(limit)
  );
}

/* -------------------------------------------------------- turn prompt builder */

// The text handed to `claude -p` for Begin Turn, and the gist of what the hook
// injects. Deliberately plain ASCII with no quotes or shell metacharacters:
// this string is passed as a command-line argument, and the moderator's own
// discussion prompt is never interpolated into it (participants read that from
// the room messages instead).
function turnPrompt(status) {
  const generic =
    'It is your turn in the Claude Boardroom. Check for new messages and respond or act as appropriate.';
  if (!status || !status.active || !status.you || !status.you.in_discussion) {
    return { label: 'Begin Turn', state: 'generic', prompt: generic };
  }
  const { round, phase } = status;
  if (phase === 'speaking' && status.you.is_your_turn) {
    return {
      label: 'Speak',
      state: 'speak',
      prompt: `It is your turn to speak in the Claude Boardroom discussion, round ${round}. Read the room with get_messages, including the moderator prompt that opened the discussion, then post your contribution with post_message. Posting on your turn advances the order to the next participant, so send one message when you are ready.`,
    };
  }
  if (phase === 'voting' && !status.you.has_voted) {
    return {
      label: 'Vote',
      state: 'vote',
      prompt: `The Claude Boardroom discussion is in the voting phase for round ${round} and you have not voted yet. Read the room with get_messages, then call cast_vote with resolved set to true if you believe the issue has been addressed, or false if it needs another round. Votes are hidden from everyone until all of them are in.`,
    };
  }
  return {
    label: 'Waiting',
    state: 'waiting',
    prompt: `A Claude Boardroom discussion is active, round ${round}, ${phase} phase, but it is not your turn. Check for new messages and respond or act as appropriate. Do not post a discussion contribution or a vote out of turn.`,
  };
}

module.exports = {
  register,
  registerFolder,
  postMessage,
  getMessages,
  listParticipants,
  listRooms,
  createRoom,
  broadcast,
  assignRoom,
  startDiscussion,
  discussionStatus,
  castVote,
  setPermissionMode,
  forgetParticipant,
  roomMessages,
  turnPrompt,
  participant,
};
