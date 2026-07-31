'use strict';

// End-to-end exercise of the boardroom rules against a throwaway database.
// Run with: npm test

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

process.env.BOARDROOM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'boardroom-test-'));

const core = require('../src/core');

let n = 0;
function check(label, fn) {
  fn();
  n++;
  console.log(`  ok  ${label}`);
}

console.log(`temp db: ${process.env.BOARDROOM_HOME}`);

/* ---------------------------------------------------- waiting-room behaviour */

core.register({ name: 'alice', cwd: '/tmp/alice' });
core.register({ name: 'bob', cwd: '/tmp/bob' });
core.register({ name: 'carol' }); // Desktop-style, no cwd

check('register with cwd stores folder_path', () => {
  assert.strictEqual(core.participant('alice').folder_path, '/tmp/alice');
  assert.strictEqual(core.participant('carol').folder_path, null);
});

check('new registrations start unassigned', () => {
  assert.strictEqual(core.participant('alice').room, null);
});

check('post_message while pending is a no-op, not an error', () => {
  const r = core.postMessage({ name: 'alice', body: 'hello?' });
  assert.strictEqual(r.status, 'pending');
  assert.strictEqual(r.message, 'not yet assigned to a room');
});

check('get_messages while pending returns an empty list', () => {
  const r = core.getMessages({ name: 'alice' });
  assert.strictEqual(r.status, 'pending');
  assert.deepStrictEqual(r.messages, []);
});

check('unregistered names are told to register, not thrown at', () => {
  assert.strictEqual(core.postMessage({ name: 'nobody', body: 'x' }).status, 'unregistered');
  assert.strictEqual(core.getMessages({ name: 'nobody' }).status, 'unregistered');
});

/* ------------------------------------------------------------- rooms & routing */

core.createRoom({ name: 'integration' });
core.createRoom({ name: 'other' });
core.broadcast({ room: 'integration', body: 'Room opened.' });

check('assign posts a system arrival message', () => {
  core.assignRoom({ name: 'alice', room: 'integration' });
  const msgs = core.roomMessages({ room: 'integration' });
  assert.ok(msgs.some((m) => m.kind === 'system' && /alice has joined/.test(m.body)));
});

check('a new arrival reads the full room history on first poll', () => {
  const r = core.getMessages({ name: 'alice' });
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.messages[0].body, 'Room opened.'); // predates the join
});

check('the cursor advances, so the same messages do not come back', () => {
  assert.deepStrictEqual(core.getMessages({ name: 'alice' }).messages, []);
});

check('sessions never name a room; the server routes by sender', () => {
  const r = core.postMessage({ name: 'alice', body: 'starting on the API' });
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.room, 'integration');
});

check('moving rooms resets the cursor to the new room history', () => {
  core.assignRoom({ name: 'alice', room: 'other' });
  assert.strictEqual(core.participant('alice').since_id, 0);
  const r = core.getMessages({ name: 'alice' });
  assert.strictEqual(r.room, 'other');
  assert.ok(r.messages.some((m) => /alice has joined/.test(m.body)));
  core.assignRoom({ name: 'alice', room: 'integration' });
});

check('a participant can be sent back to the waiting room', () => {
  core.assignRoom({ name: 'bob', room: 'integration' });
  core.assignRoom({ name: 'bob', room: 'waiting' });
  assert.strictEqual(core.participant('bob').room, null);
  core.assignRoom({ name: 'bob', room: 'integration' });
});

check('moderator broadcasts are tagged distinctly from participant messages', () => {
  core.broadcast({ room: 'integration', body: 'steering note' });
  const last = core.roomMessages({ room: 'integration' }).pop();
  assert.strictEqual(last.kind, 'moderator');
  assert.strictEqual(last.sender, 'moderator');
});

/* --------------------------------------------------------------- discussions */

core.assignRoom({ name: 'carol', room: 'integration' });

check('start_discussion rejects names not assigned to the room', () => {
  const r = core.startDiscussion({ room: 'integration', prompt: 'x', order: ['alice', 'dave'] });
  assert.strictEqual(r.status, 'error');
});

check('start_discussion opens round 1 with the first speaker up', () => {
  const r = core.startDiscussion({
    room: 'integration',
    prompt: 'Do we version the shared schema?',
    order: ['alice', 'bob', 'carol'],
  });
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.round, 1);
  assert.strictEqual(r.phase, 'speaking');
  assert.strictEqual(r.current_speaker, 'alice');
});

check('the prompt lands in the room as a moderator message', () => {
  const msgs = core.roomMessages({ room: 'integration' });
  assert.ok(msgs.some((m) => m.kind === 'moderator' && /version the shared schema/.test(m.body)));
});

check('posting out of turn is allowed but does not advance the turn', () => {
  const r = core.postMessage({ name: 'bob', body: 'jumping in early' });
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.turn_advanced, false);
  assert.strictEqual(core.discussionStatus({ room: 'integration' }).current_speaker, 'alice');
});

check('cast_vote during the speaking phase is a no-op with a clear status', () => {
  const r = core.castVote({ name: 'alice', resolved: true });
  assert.strictEqual(r.status, 'not_voting');
});

check('posting in turn advances to the next speaker', () => {
  core.postMessage({ name: 'alice', body: 'I say yes' });
  assert.strictEqual(core.discussionStatus({ room: 'integration' }).current_speaker, 'bob');
});

check('the last speaker flips the phase to voting', () => {
  core.postMessage({ name: 'bob', body: 'agreed' });
  core.postMessage({ name: 'carol', body: 'sure' });
  const d = core.discussionStatus({ room: 'integration' });
  assert.strictEqual(d.phase, 'voting');
  assert.strictEqual(d.current_speaker, null);
});

check('votes stay hidden while the round is still open', () => {
  core.castVote({ name: 'alice', resolved: true });
  core.castVote({ name: 'bob', resolved: false });
  const d = core.discussionStatus({ room: 'integration' });
  assert.strictEqual(d.votes_cast, 2);
  assert.strictEqual(d.votes_total, 3);
  assert.deepStrictEqual(d.rounds, []); // nothing revealed yet
  assert.ok(!JSON.stringify(d).includes('"vote"'));
});

check('a split vote starts the next round without revealing who voted how', () => {
  const r = core.castVote({ name: 'carol', resolved: true });
  assert.strictEqual(r.round_complete, true);
  assert.strictEqual(r.resolved, false);
  assert.strictEqual(r.yes, 2);
  const d = core.discussionStatus({ room: 'integration' });
  assert.strictEqual(d.round, 2);
  assert.strictEqual(d.phase, 'speaking');
  assert.strictEqual(d.turn_index, 0);
  assert.deepStrictEqual(d.rounds, [{ round: 1, yes: 2, total: 3 }]);
  const sys = core.roomMessages({ room: 'integration' }).pop();
  assert.match(sys.body, /2\/3 agreed\. Starting round 2/);
  // Naming the next speaker is fine; naming a voter is not.
  assert.ok(!/alice|bob|carol/.test(sys.body.replace(/\S+ is up first/, '')));
});

check('round 2 votes are scoped to round 2, not carried over', () => {
  core.postMessage({ name: 'alice', body: 'round 2 from alice' });
  core.postMessage({ name: 'bob', body: 'round 2 from bob' });
  core.postMessage({ name: 'carol', body: 'round 2 from carol' });
  assert.strictEqual(core.discussionStatus({ room: 'integration' }).votes_cast, 0);
});

check('a unanimous round resolves the discussion and announces the tally', () => {
  core.castVote({ name: 'alice', resolved: true });
  core.castVote({ name: 'bob', resolved: true });
  const r = core.castVote({ name: 'carol', resolved: true });
  assert.strictEqual(r.resolved, true);
  const d = core.discussionStatus({ room: 'integration' });
  assert.strictEqual(d.active, false);
  assert.strictEqual(d.resolved, true);
  assert.match(core.roomMessages({ room: 'integration' }).pop().body, /3\/3 agreed/);
});

check('voting after resolution is a no-op', () => {
  assert.strictEqual(core.castVote({ name: 'alice', resolved: true }).status, 'resolved');
});

/* ------------------------------------------------- per-session status & prompts */

check('discussion_status resolves a room from a session name alone', () => {
  const d = core.discussionStatus({ name: 'alice' });
  assert.strictEqual(d.room, 'integration');
});

check('turn prompts fall back to generic once resolved', () => {
  const t = core.turnPrompt(core.discussionStatus({ name: 'alice' }));
  assert.strictEqual(t.state, 'generic');
  assert.strictEqual(t.label, 'Begin Turn');
});

check('turn prompts are discussion-aware while one is running', () => {
  core.startDiscussion({ room: 'integration', prompt: 'round two topic', order: ['alice', 'bob'] });
  assert.strictEqual(core.turnPrompt(core.discussionStatus({ name: 'alice' })).state, 'speak');
  assert.strictEqual(core.turnPrompt(core.discussionStatus({ name: 'bob' })).state, 'waiting');
  assert.strictEqual(core.turnPrompt(core.discussionStatus({ name: 'carol' })).state, 'generic');

  core.postMessage({ name: 'alice', body: 'a' });
  core.postMessage({ name: 'bob', body: 'b' });
  assert.strictEqual(core.turnPrompt(core.discussionStatus({ name: 'alice' })).state, 'vote');
  core.castVote({ name: 'alice', resolved: true });
  assert.strictEqual(core.turnPrompt(core.discussionStatus({ name: 'alice' })).state, 'waiting');
});

check('turn prompts carry nothing a shell would reinterpret', () => {
  const unsafe = /["'`$%&|<>^\\\r\n]/;
  for (const name of ['alice', 'bob', 'carol']) {
    const p = core.turnPrompt(core.discussionStatus({ name })).prompt;
    assert.ok(!unsafe.test(p), `unsafe prompt for ${name}: ${p}`);
  }
});

/* ------------------------------------------------------------------- listings */

check('list_rooms and list_participants report the right shape', () => {
  const rooms = core.listRooms();
  assert.ok(rooms.rooms.some((r) => r.name === 'integration' && r.participants === 3));
  const carol = core.listParticipants({ room: 'integration' }).participants.find((p) => p.name === 'carol');
  assert.strictEqual(carol.can_begin_turn, false); // no folder_path -> read-only in the UI
});

check('permission mode is per participant and validated', () => {
  assert.strictEqual(core.setPermissionMode({ name: 'alice', permission_mode: 'plan' }).status, 'ok');
  assert.strictEqual(core.participant('alice').permission_mode, 'plan');
  assert.strictEqual(core.setPermissionMode({ name: 'alice', permission_mode: 'yolo' }).status, 'error');
});

/* ------------------------------------------------------------------- wiring */

const wiring = require('../src/wiring');

check('a plain Node runtime needs no special environment', () => {
  const e = wiring.mcpServerEntry({ execPath: '/usr/bin/node', isElectron: false });
  assert.strictEqual(e.command, '/usr/bin/node');
  assert.strictEqual(e.env, undefined);
});

check('ANY Electron binary gets ELECTRON_RUN_AS_NODE, packaged or not', () => {
  // Regression: keying this off `packaged` produced a config that launched an
  // Electron app instead of running the MCP server, so the server loaded but
  // never spoke on stdout.
  for (const packaged of [true, false]) {
    const e = wiring.mcpServerEntry({ execPath: '/apps/boardroom.exe', isElectron: true, packaged });
    assert.deepStrictEqual(e.env, { ELECTRON_RUN_AS_NODE: '1' }, `packaged=${packaged}`);
  }
});

check('the hook shim path is stable, so settings.json survives updates', () => {
  const before = wiring.SHIM;
  wiring.writeHookShim({ execPath: '/v1/boardroom.exe', isElectron: true });
  const after = wiring.SHIM;
  assert.strictEqual(before, after);
  // A new install location changes the shim's contents, never its path.
  const second = wiring.writeHookShim({ execPath: '/v2/boardroom.exe', isElectron: true });
  assert.strictEqual(second.path, before);
  assert.ok(fs.readFileSync(second.path, 'utf8').includes('/v2/boardroom.exe'));
});

/* ------------------------------------------------------------------ install */

const installer = require('../setup/install');

check('status reports a genuinely absent Desktop config as absent, not unreadable', () => {
  const st = installer.status({ execPath: '/usr/bin/node', isElectron: false });
  // Whatever this machine looks like, the two states must stay distinguishable:
  // conflating them is how an existing config gets silently skipped.
  for (const key of ['claude_code', 'desktop']) {
    const s = st[key];
    assert.ok(typeof s.ok === 'boolean', `${key} needs an ok flag`);
    assert.ok(!(s.missing && s.unreadable), `${key} cannot be both absent and unreadable`);
    if (!s.ok) assert.ok(s.detail && s.detail.length, `${key} needs a reason`);
  }
});

check('an unreadable config is a problem, never a silent skip', () => {
  // A path whose parent cannot exist stands in for the post-update process
  // that could not see %APPDATA%. It must not be quietly treated as absent.
  const st = installer.status({ execPath: '/usr/bin/node', isElectron: false });
  assert.ok(st.desktop.path, 'desktop status carries the path it looked at');
  assert.strictEqual(typeof st.shim.ok, 'boolean');
});

console.log(`\n${n} checks passed.`);
require('../src/db').close();
fs.rmSync(process.env.BOARDROOM_HOME, { recursive: true, force: true });
