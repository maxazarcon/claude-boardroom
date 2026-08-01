#!/usr/bin/env node
'use strict';

// Claude Boardroom MCP server. stdio only — no HTTP listener, no port.

const core = require('./core');
const { DB_PATH } = require('./db');

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const str = (description) => ({ type: 'string', description });

const TOOLS = [
  {
    name: 'register',
    description:
      'Announce this session to the boardroom under a name of your choosing. Pass your own working directory as cwd (Claude Code sessions should) so the moderator can trigger turns for you from the UI. You start in the waiting room, unassigned, until the moderator places you.',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('The name this session goes by in the boardroom.'),
        cwd: str('Optional. This session\'s working directory.'),
        role: str('Optional. Your role on the board, in a sentence.'),
      },
      required: ['name'],
    },
    handler: core.register,
  },
  {
    name: 'post_message',
    description:
      'Post a message to whichever room you are currently assigned to. You never name a room — the server knows where you are. While you are still in the waiting room this is a no-op that returns status "pending".',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('Your own registered name.'),
        body: str('The message text.'),
        private: {
          type: 'boolean',
          description:
            'Send only to the moderator, in your private aside, instead of to the room. Use this only when replying to something the moderator said privately. A private message never advances a discussion turn.',
        },
      },
      required: ['name', 'body'],
    },
    handler: core.postMessage,
  },
  {
    name: 'get_messages',
    description:
      'Fetch messages newer than since_id from whichever room you are currently assigned to. Omit since_id to pick up where you last left off. Returns an empty list (not an error) while you are still in the waiting room. The response also carries the current discussion status for your room.',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('Your own registered name.'),
        since_id: {
          type: 'integer',
          description: 'Optional. Only return messages with an id greater than this.',
        },
      },
      required: ['name'],
    },
    handler: core.getMessages,
  },
  {
    name: 'list_participants',
    description: 'List participants in a room. Omit room to list everyone; pass "waiting" for the waiting room.',
    inputSchema: {
      type: 'object',
      properties: { room: str('Room name, or "waiting". Omit for all.') },
    },
    handler: core.listParticipants,
  },
  {
    name: 'list_rooms',
    description: 'List all rooms with participant counts.',
    inputSchema: { type: 'object', properties: {} },
    handler: core.listRooms,
  },
  {
    name: 'create_room',
    description: 'Create a room. Intended for the moderator UI, not for sessions.',
    inputSchema: {
      type: 'object',
      properties: { name: str('Room name.') },
      required: ['name'],
    },
    handler: core.createRoom,
  },
  {
    name: 'broadcast',
    description:
      'Post a message into a room as "moderator" rather than as a participant. Optionally address one participant, or send it privately as an aside. Intended for the moderator UI, not for sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        room: str('Room name.'),
        body: str('The message text.'),
        to: str('Optional. Address one participant: everyone sees it, only they are asked to act.'),
        aside: str('Optional. Send privately to this participant instead; nobody else ever reads it.'),
      },
      required: ['room', 'body'],
    },
    handler: core.broadcast,
  },
  {
    name: 'assign_room',
    description:
      'Move a registered participant into a room, or back to the waiting room by passing "waiting". Posts a system message announcing the arrival and resets that participant\'s cursor so their next get_messages returns the room\'s full history. Intended for the moderator UI, not for sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('Participant name.'),
        room: str('Target room name, or "waiting" to unassign.'),
      },
      required: ['name'],
    },
    handler: core.assignRoom,
  },
  {
    name: 'start_discussion',
    description:
      'Start a structured discussion in a room: posts the prompt as a moderator message and opens round 1 in the speaking phase with the first name in order up. Intended for the moderator UI, not for sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        room: str('Room name.'),
        prompt: str('The issue to resolve.'),
        order: {
          type: 'array',
          items: { type: 'string' },
          description: 'Speaking order — a subset or all of the room\'s assigned participants.',
        },
      },
      required: ['room', 'prompt', 'order'],
    },
    handler: core.startDiscussion,
  },
  {
    name: 'discussion_status',
    description:
      'Report whether a discussion is active, its round, phase (speaking or voting), whose turn it is to speak, and how many of the order have voted so far — never which way. Pass room (UI) or your own name (session).',
    inputSchema: {
      type: 'object',
      properties: {
        room: str('Room name. Use this from the UI.'),
        name: str('Your own registered name. Use this from a session; the server resolves your room.'),
      },
    },
    handler: core.discussionStatus,
  },
  {
    name: 'cast_vote',
    description:
      'Vote on whether the discussed issue has been addressed. Only counts during the voting phase of your room\'s discussion; otherwise it is a no-op that reports the current state instead of erroring. Votes stay hidden from everyone until every participant in the order has voted for that round.',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('Your own registered name.'),
        resolved: {
          type: 'boolean',
          description: 'true if you think the issue is addressed, false if it needs another round.',
        },
      },
      required: ['name', 'resolved'],
    },
    handler: core.castVote,
  },
];

const server = new Server(
  { name: 'claude-boardroom', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = TOOLS.find((t) => t.name === request.params.name);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }],
    };
  }
  try {
    const result = tool.handler(request.params.arguments || {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: `${tool.name} failed: ${err.message}` }],
    };
  }
});

async function main() {
  process.stderr.write(`[boardroom] db: ${DB_PATH}\n`);
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(`[boardroom] fatal: ${err.stack || err}\n`);
  process.exit(1);
});
