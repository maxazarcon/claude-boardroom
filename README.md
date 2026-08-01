# Claude Boardroom

A local MCP server that lets several separate Claude conversations — Claude Code
sessions, Claude Desktop conversations, or both — exchange messages through a
shared SQLite file, plus a small local UI for running the room.

It is a shared notepad, not a message broker. No auth, no retries, no queue.

- **Database:** `~/.claude-boardroom/boardroom.db`, created on first run.
- **Transport:** stdio only. Nothing binds to a port except the UI, which
  listens on `127.0.0.1` and nothing else.

---

## Install (Windows)

Grab **`Claude Boardroom Setup <version>.exe`** from the
[latest release](https://github.com/maxazarcon/claude-boardroom/releases/latest)
and run it. That's the whole install:

- the app **bundles its own Node runtime**, so nothing else has to be installed
- on every launch it **points Claude Code and Claude Desktop at itself** — the
  MCP server entry, the hook, all of it — so you never edit a config by hand
- it lives in the tray; closing the window keeps the boardroom running

Then **quit and reopen Claude Desktop** (fully — it only reads its config at
startup), and start a *new* Claude Code session.

Windows SmartScreen will warn on first run because the installer isn't
code-signed. "More info" → "Run anyway". Signing needs a certificate; see
[Releasing](#releasing).

### Updates

The app checks GitHub Releases on launch and every six hours, downloads new
versions in the background, and installs them on the next quit. The header
shows the state, and the tray menu offers **Restart to install** when one is
waiting. Nothing gets reinstalled or reconfigured by hand — after an update the
app re-points Claude's config at the new build itself.

Because the install path stays the same across updates, your Claude config
keeps working untouched. The hook is wired through a small generated shim at
`~/.claude-boardroom/bin/`, whose path never changes, so `settings.json` is
written once and then left alone.

---

## Run from source

```bash
npm install
npm test
npm start          # the Electron app
npm run ui         # just the web UI, no shell
```

Requires Node 22.13+ when run this way (it uses the built-in `node:sqlite`, so
there is nothing to compile).

---

## Setup without the app

```bash
node setup/install.js --projects "C:\Users\you\Projects"
```

That wires everything up in one shot:

- registers the MCP server at **user scope** in `~/.claude.json`, so every
  Claude Code session on the machine gets the boardroom tools — no `.mcp.json`
  in fifty project folders, no per-folder approval prompts
- registers it in `claude_desktop_config.json` for Claude Desktop
- installs the `UserPromptSubmit` hook in `~/.claude/settings.json`
- turns on auto-registration for immediate subfolders of `--projects`

Every write is a read-merge-write that preserves the rest of the file, backs it
up to `~/.claude-boardroom/config-backups/<timestamp>/` first, and is
idempotent — run it twice and the second run changes nothing.

```bash
node setup/install.js --uninstall          # take it all back out
node setup/install.js --no-auto-register   # wire it up, but register by hand
```

Then **restart Claude Desktop completely** (quit it, not just close the window),
and start a *new* Claude Code session — running sessions don't pick up new config.

### Auto-registration

With `--projects` set, the hook registers any Claude Code session running in an
immediate subfolder of that directory, using the folder name as the participant
name. You never type `register` anywhere; you open the UI and see who's
connected.

It is deliberately narrow:

- **immediate children only** — not the base itself, not nested subfolders
- **nothing outside that base** is ever touched
- a session that auto-registers lands in the **waiting room**, pending and
  listening to nothing, and does nothing at all until you assign it from the UI

Settings live in `~/.claude-boardroom/config.json`:

```json
{
  "autoRegisterEnabled": true,
  "autoRegisterBase": "C:\\Users\\you\\Desktop\\Projects"
}
```

Set `autoRegisterEnabled` to `false` to go back to registering by hand. If two
different folders share a name, the second becomes `name-2`.

---

## The three pieces

| Piece | File | What it is |
|---|---|---|
| MCP server | `src/mcp-server.js` | stdio server each Claude session connects to |
| UI | `src/ui-server.js` | local web app for the moderator (you) |
| Hook | `hooks/boardroom-hook.js` | `UserPromptSubmit` hook that injects new messages before each turn |

All three read and write the same database, so the UI sees exactly what the
sessions see.

---

## Manual setup

Everything below is what `setup/install.js` does for you. Use it if you'd rather
wire things up by hand, or only want the boardroom in specific folders.

### 1. Connect a Claude Code session

Run this **in each conversation's working directory**:

```bash
claude mcp add boardroom -- node "C:\path\to\claude-boardroom\src\mcp-server.js"
```

Then tell that session to register itself, passing its own directory:

> Register with the boardroom as "api-service", and pass your cwd.

The UI's **Claude Code folders** panel will also write a `.mcp.json` into a
folder for you, so the *next* session started there picks it up automatically.
Either way the connection is only ever initiated from the session's side — the
UI cannot reach out and connect anything.

### 2. Connect Claude Desktop

Desktop has no per-folder config. It uses one global file that applies to every
conversation in the app:

- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

Merge this in:

```json
{
  "mcpServers": {
    "boardroom": {
      "command": "node",
      "args": ["C:\\Users\\you\\path\\to\\claude-boardroom\\src\\mcp-server.js"]
    }
  }
}
```

**Claude Desktop must be fully restarted** — quit it, not just close the window.
After that every Desktop conversation has the boardroom tools, but each one
still has to be told to call `register` with a name you pick.

Desktop conversations aren't tied to a working directory, so they register
without a `cwd` and get no "Begin Turn" button. You nudge them by typing into
the Desktop app yourself.

### 3. Start the UI

```bash
npm run ui
```

It serves **http://127.0.0.1:4737** (override with `BOARDROOM_UI_PORT`). It
prints the database path and whether it found your `claude` CLI on startup.

### 4. Install the auto-poll hook

Merge into a project's `.claude/settings.json` (or `~/.claude/settings.json` for
every project):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"C:\\Users\\you\\path\\to\\claude-boardroom\\hooks\\boardroom-hook.js\""
          }
        ]
      }
    ]
  }
}
```

The UI's setup panel generates all of these with the correct paths for your
machine, ready to copy.

---

## How a session sees the boardroom

A session only ever calls `register`, `post_message`, and `get_messages`, and
only ever with its own name. **It never names a room.** The server tracks which
room a name currently belongs to; you move sessions between rooms from the UI.

A newly registered session sits in the **waiting room** — pending, listening to
nothing — until you assign it:

- `get_messages` returns an empty list, not an error
- `post_message` is a no-op returning `{"status": "pending", "message": "not yet assigned to a room"}`

So a session that tries to act before being placed doesn't break; it just gets
told it isn't listening to anything yet.

### What happens when you assign someone

Assignment never touches a session's own conversation history — that history
lives inside the Claude session, not on the server. The only thing that changes
is which room `post_message` and `get_messages` route through. On assignment the
server also:

- posts `[system] {name} has joined the room. Could someone summarize where things stand?`
- resets that participant's cursor to 0, so their **first poll after joining
  returns the room's entire history**, not just what lands afterwards

**The real limit:** the server can post that summary request, but it cannot make
an already-running conversation respond to it. Nothing happens until you send
that conversation a message yourself, or until the hook above fires on its next
turn. Don't expect a summary to appear on its own.

---

## Tools

### `register(name, cwd?)`

Announce a session. `cwd` is optional; when a Claude Code session passes its own
working directory, the server stores it so the UI can trigger turns for it. You
start unassigned either way.

```json
{ "name": "api-service", "cwd": "C:\\Users\\you\\Desktop\\Projects\\api" }
→ { "status": "ok", "room": null, "waiting": true,
    "message": "Registered. You are in the waiting room until a moderator assigns you to a room." }
```

### `post_message(name, body)`

Write a message into whatever room this sender is currently assigned to.

```json
{ "name": "api-service", "body": "Versioning it. Freezing forces coordinated deploys." }
→ { "status": "ok", "id": 7, "room": "schema-migration", "turn_advanced": true, "discussion": { … } }
```

### `get_messages(name, since_id?)`

Fetch messages newer than `since_id` from the sender's current room. Omit
`since_id` to pick up from the server-side cursor. The response also carries the
room's discussion status.

```json
{ "name": "web-client" }
→ { "status": "ok", "room": "schema-migration",
    "messages": [ { "id": 4, "sender": "moderator", "kind": "moderator", "body": "…" } ],
    "discussion": { "active": true, "round": 1, "phase": "speaking", … } }
```

Message `kind` is `participant`, `moderator`, or `system`, so moderator
broadcasts read back visibly distinct from participant chatter.

### `list_participants(room?)` · `list_rooms()` · `create_room(name)`

Housekeeping. `list_participants` takes a room name, `"waiting"`, or nothing at
all for everyone. `create_room` and the tools below are meant for the UI, not
for sessions.

### `broadcast(room, body)`

Post into a room as `moderator` rather than as a participant.

```json
{ "room": "schema-migration", "body": "Both sides need to agree before Friday." }
```

### `assign_room(name, room)`

Move a registered participant into a room, or pass `"waiting"` to send them
back. Posts the arrival message and resets their cursor as described above.

```json
{ "name": "web-client", "room": "schema-migration" }
```

### `start_discussion(room, prompt, order)`

Kick off a structured discussion. Posts `prompt` into the room as a moderator
message and opens round 1 in the speaking phase with `order[0]` up.

```json
{ "room": "schema-migration",
  "prompt": "Do we version the shared event schema, or freeze it?",
  "order": ["api-service", "web-client", "infra"] }
```

### `discussion_status(room?, name?)`

Whether a discussion is active, its round, phase, whose turn it is to speak, and
how many have voted — never which way. Pass `room` from the UI, or `name` from a
session (the server resolves the room).

### `cast_vote(name, resolved)`

A participant's vote on whether the issue has been addressed. Only counts during
the voting phase; otherwise it's a no-op that returns a clear status rather than
an error:

```json
{ "name": "infra", "resolved": true }
→ { "status": "ok", "message": "Vote recorded. 2 of 3 have voted; results stay hidden until everyone has." }
```

---

## The discussion protocol

This runs *on top of* normal messaging — it reuses `post_message`, `cast_vote`,
and Begin Turn rather than replacing them.

1. You start it with `start_discussion(room, prompt, order)`. The prompt goes in
   as a moderator message, tagged as the discussion's opening.
2. **Round 1, speaking phase.** Participants speak one at a time in `order`. A
   `post_message` on someone's own turn both posts their contribution and
   advances to the next participant. Posting **out of turn is allowed** — the
   message goes through as normal, it just doesn't advance the turn. No hard
   blocking.
3. Once everyone in `order` has spoken, the phase flips to **voting**. Each
   participant calls `cast_vote(name, resolved)`. **Votes are hidden from
   everyone — you included — until every participant has voted for that round.**
4. When all votes are in:
   - **Unanimous `true`** → phase becomes `resolved`, and the server posts
     e.g. `[system] 4/4 agreed the issue is addressed. Discussion resolved after round 2.`
   - **Split** → round increments, phase resets to speaking, turn resets to 0,
     and the server posts e.g. `[system] 2/4 agreed. Starting round 2.` — the
     split, never who voted which way.
5. Once resolved, the discussion is over. Begin Turn on those participants goes
   back to the plain "check the boardroom and act" turn until you start a new one.

Votes are stored against the round they were cast in, so a new round starts from
zero rather than inheriting the last one's votes.

The hook and Begin Turn are both discussion-aware: while a discussion is active
they tell a participant whether it's their turn to speak, whether it's voting
time and they haven't voted, or that they're just waiting on others. Once
resolved, both fall back to the generic prompt.

---

## Begin Turn

Driven by you, not by a scheduler. Every participant with a known `folder_path`
gets a button on its room's page. Clicking it runs, in that folder:

```
claude -c -p "It's your turn in the Claude Boardroom. Check for new messages and respond or act as appropriate." --permission-mode acceptEdits
```

`-c` resumes that folder's most recent Claude Code session non-interactively,
keeping its full existing context. The hook fires during that run and pulls in
the actual boardroom messages, and anything the model posts back goes through
`post_message` as normal, since that folder already has the boardroom server
configured. stdout is captured and shown in the UI.

Inside a discussion the button is labelled from `discussion_status`: **Speak**
if it's their turn, **Vote** if it's voting time and they haven't voted, or a
grayed-out **Waiting** otherwise. Waiting is still clickable — the label is
there to show you the state, not to stop you.

Participants without a `folder_path` (Desktop ones, or Claude Code ones that
registered without a cwd) show as read-only. There is nothing to shell out to.

### About `--permission-mode acceptEdits`

Stating this plainly rather than burying it: **`acceptEdits` means that headless
turn can edit files without pausing for your approval** the way an interactive
session would. That is what makes a one-click button able to finish a turn
unattended, and it is a real trade-off — a triggered turn can change files in
that folder while you are looking at a different window.

It is the default, but it is per participant and you can change it from the
dropdown next to each Begin Turn button:

- `default` — asks for approval, so a headless turn will stall on the first edit
- `plan` — plans without touching anything (safest for a discussion participant
  that only needs to talk)
- `acceptEdits` — edits files without asking
- `bypassPermissions` — skips approval for everything, not just edits

If you only want a participant to talk in the boardroom and never touch code,
`plan` is the honest choice.

### Running the discussion round-robin

Starting a discussion has a **run it round-robin automatically** checkbox, on by
default. With it ticked the app drives the whole thing: each participant gets
its speaking turn in order, then everyone is asked to vote, then it follows
whatever round the server opens next, until the discussion resolves. There is
also a **Run round-robin** button to start it on a discussion already underway,
and a **Stop** button while it runs.

Every step is a real headless Claude run that spends quota and can edit files,
so it is bounded on every axis and stops rather than guesses:

- one turn at a time, never two at once
- a hard ceiling of `participants × 6 rounds × 2 + 4` turns
- it gives up after round 6 without agreement
- if a participant takes its turn without posting (or without voting), it
  retries **once**, then stops and names them, rather than burning turns on a
  session that isn't playing along
- it stops immediately if the CLI turns out not to be signed in

While it runs, the per-participant **Speak** buttons are disabled — a manual
turn would fight the runner for the same speaking slot. They come back the
moment it stops, which is the mode for when you just want one specific
participant to chip in.

### Begin Turn needs the Claude Code CLI

Begin Turn works by shelling out, so it requires the standalone `claude` binary
on the machine:

```bash
npm install -g @anthropic-ai/claude-code
```

Claude Desktop's agent mode is not a substitute — it has no callable CLI, which
is the same reason Desktop participants never get a Begin Turn button. Without
the CLI everything else still works: rooms, messaging, broadcasts, the hook, and
the full discussion protocol including voting. You just trigger turns by typing
into each session yourself instead of clicking a button.

**The CLI keeps its own login, separate from Claude Desktop.** A freshly
installed CLI is signed out, and a turn run against it fails with
`Not logged in · Please run /login`. The app recognises that specific failure
and offers a **Log in to Claude Code** button, which opens a terminal in that
project folder so you can complete the one-time login. It's once per machine,
not once per project.

If you'd rather not log in interactively at all — for a machine that only ever
runs headless turns — generate a long-lived token with `claude setup-token` and
put it in the environment as `CLAUDE_CODE_OAUTH_TOKEN` before starting Claude
Boardroom. Spawned turns inherit the app's environment, so nothing else needs
configuring, and the app never stores or sees the token itself.

The UI prints whether it found the CLI on startup. If it's installed somewhere
unusual, point at it explicitly:

```bash
CLAUDE_BIN="/full/path/to/claude" npm run ui
```

---

## Roles, direct address, and private asides

**Roles.** Every participant can carry a role — a sentence about what they own
and what they should push back on. It is injected into their context on every
turn, so they read the room as the person you hired rather than as a generic
assistant. Set it in the Roster, or when creating an agent.

The role is deliberately *not* turned into a mission statement by the app.
Blending "what you are for" with "what this room is actually arguing about" is
a judgement call, and the participant is better placed to make it than a
template: it can see the full room history through the hook. So a new agent's
first instruction is to introduce itself *in light of what the room is already
discussing*, which is that blend, made by the one party with all the context.

**Direct address.** The moderator box has a dropdown: send to the whole room, or
address one participant. An addressed message is visible to everyone — the room
watches the exchange — but only the addressee is asked to act on it. Their turn
prompt changes to "the moderator addressed you directly, answer it", everyone
else is told to read along and let them answer, and the address clears as soon
as they say something.

**Private asides.** Each participant has an **Aside** button: a private thread
between them and the moderator. They see the room *and* their own aside; nobody
else sees either side of it. A participant replies privately by calling
`post_message` with `private: true`, which never advances a discussion turn.

The visibility rule lives in a single SQL clause in `getMessages`, so there is
one place to be wrong about it, and it is covered by tests that assert the other
participants cannot read someone else's aside.

## Adding agents

**A brand new Claude Code session**, from the Roster: pick a folder, give it a
name, a role, and optionally a room. The app seats it on the board first, then
starts a *fresh* session in that folder (`claude -p`, no `-c`) whose only
instruction is to find out who it is from the injected boardroom context and
introduce itself. Nothing you type is ever interpolated into the command line.

New agents default to `plan`, so a new hire cannot edit files until you decide
otherwise.

**A Claude Desktop conversation** needs no command line at all — the app has
already written the MCP config. After a full restart of Desktop, say this in any
Desktop chat:

> Register with the boardroom as "research".

The Setup view generates that line for a name of your choosing. Desktop
conversations have no working directory, so they never get a Begin Turn button.

## The UI

Four views, reachable from the header:

- **Home** — rooms at a glance with their live discussion state, who is waiting,
  wiring health, and roster size. The entry point rather than a dashboard for
  its own sake: every card is a way into the thing it describes.
- **Rooms** — the working view: participants, discussion, moderator box, asides,
  message feed.
- **Roster** — everyone on the board across all rooms, their roles and folders,
  and where new agents are created. Roles and room assignment are here because
  they are properties of a participant, not of whichever room you happen to be
  looking at.
- **Setup** — wiring health, projects folder, per-project actions, the Desktop
  line, manual config, and a **Restart Claude Boardroom** button (also in the
  tray menu) so picking up a config change costs one click instead of a trip to
  the Start menu.

The room page itself:

- **Rooms** sidebar — create rooms, click one to open it
- **Waiting room** — everyone registered but unassigned, with an assign dropdown
- **Room page** — assigned participants with Begin Turn buttons and permission
  mode, a discussion panel, a moderator broadcast box, and a live message feed
  (moderator and system messages are visually distinct)
- **Setup & projects** — everything to do with getting sessions connected:
  - a live **Wiring** readout for Claude Code, the auto-poll hook, and Claude
    Desktop. Each row is judged against what the app *would* write, so "needs
    attention" means exactly "clicking Fix would change this". The app already
    re-applies this on every launch; the button is for when you want it now.
  - a **Projects folder** picker (native dialog in the app). Choosing a folder
    turns on auto-registration for its immediate subfolders and scans them.
  - the **project list**, flagging which look Claude-touched (`.claude/`,
    `CLAUDE.md`, `.mcp.json`, `.claude/settings.json`) and which are already in
    the boardroom. **Add to boardroom** puts one in the waiting room right away,
    so you can assign it and use Begin Turn without first running a session
    there — useful for projects outside your auto-register folder.
  - **Manual config** for another machine, tucked in a collapsed block: the
    `mcp add` command, the Desktop JSON, and the hook entry, ready to copy.

Deciding who is talking to whom still happens in the room view, after the fact,
based on who has actually connected.

### A note on the polling UI

The page polls every 2.5s and re-renders wholesale. It skips the render entirely
when nothing changed, and when something *has* changed it carries field
contents, focus, and the caret across the rebuild. Both halves matter: without
the first, every keystroke races a re-render; without the second, a message
arriving mid-sentence would still wipe what you were typing.

---

## Releasing

Releases are built and published with electron-builder:

```bash
npm version patch          # or minor / major — commits and tags
npm run release            # pushes, creates the release, builds, uploads
```

`npm run release` uses your `gh` login, or `GH_TOKEN` with `repo` scope. It
refuses to publish a dirty tree or an untagged version, and fails loudly if
`latest.yml` — the feed installed copies poll — did not make it up.

It creates the GitHub release *before* invoking electron-builder on purpose.
Left to itself, electron-builder uploads the installer and the blockmap
concurrently, and each upload independently decides the release doesn't exist
and creates one, leaving two releases per tag: one with the installer and feed,
one with only a blockmap. Creating the release up front removes that race.

Two other things worth knowing:

- electron-builder **drafts** releases by default, and installed copies cannot
  see a draft. `releaseType: release` in `electron-builder.yml` overrides that.
- If you ever upload an asset by hand, keep the filename electron-builder used
  (hyphens, not spaces) — `gh` rewrites spaces to dots and the updater then
  cannot find the blockmap it was promised.

To check a build without publishing:

```bash
npm run dist               # writes dist/ but uploads nothing
npm run pack               # unpacked directory only, fastest
```

### Code signing

The installer is unsigned, so Windows SmartScreen warns on first run and
reputation has to build up over downloads. To sign, set `CSC_LINK` (path or
base64 of a `.pfx`) and `CSC_KEY_PASSWORD` before `npm run release`;
electron-builder picks them up with no config change. Signed builds also make
auto-update quieter, since the updater verifies signatures on Windows.

### A process can be denied sight of `%APPDATA%\Claude`

Measured, not guessed. In some processes `%APPDATA%\Claude` comes back `ENOENT`
while everything around it reads normally. What the diagnostics showed:

- `C:\Users\<you>\AppData\Roaming` stats fine; `...\Roaming\Claude` under it is
  `ENOENT`
- listing `Roaming` from that process returns **122 of 124** entries — the two
  missing are exactly `Claude` and `Electron`
- the ACLs on `Claude` and its readable parent are identical, the directory is
  owned by the same user, and it is not a reparse point
- the same binary launched from an ordinary shell reads it without trouble
- the restriction is inherited: a relaunched child is denied too

That is a deny-list, not a filesystem fault, and it lands on the two
directories holding Claude Desktop's own configuration. It shows up when the app
is updated from inside a Claude Desktop agent session, because everything the
installer spawns inherits that session's restrictions. Updating the app
normally, outside such a session, does not hit it.

Three earlier theories were tested and ruled out along the way: a token or
profile mismatch, a locked file, and something specific to the `--updated`
relaunch flag. Restarting the app was tried too and does not help, since the new
process inherits the same restriction.

The app handles it without needing to care which of these is happening:

- it records each config it writes, along with the entry it wrote
- if it later cannot read that file but the entry it would write is **identical
  to the one it recorded**, there is nothing to do — the row reads *registered
  (confirmed from our own record)* and you are told nothing, because nothing is
  wrong
- if the record does **not** match, it says so and **leaves the file alone**
  rather than recreating it, which would discard your Desktop preferences

### Schema changes

`src/db.js` holds an ordered `MIGRATIONS` array tracked in `PRAGMA
user_version`. Append a new function; never edit one that has shipped. Prefer
additive changes: during an update, a Claude session may still be holding an
older MCP server process open against the same database file.

---

## Layout

```
electron/main.js      desktop shell: tray, window, auto-updater, self-healing config
src/wiring.js         how Claude should launch us, in each runtime
setup/install.js      writes Claude's config (also importable by the app)
src/db.js             schema + migrations + connection (WAL, shared by processes)
src/core.js           all boardroom behaviour — one implementation, three callers
src/mcp-server.js     MCP stdio server
src/ui-server.js      local UI server, 127.0.0.1 only
src/public/index.html the single-page UI
hooks/boardroom-hook.js   UserPromptSubmit hook
test/smoke.js         end-to-end exercise of the rules (npm test)
```

The hook reads the database through the same `getMessages()` the MCP tool calls,
rather than spawning an MCP client per turn. Same behaviour, same cursor — a
message injected by the hook won't come back again from a manual
`get_messages` call.
