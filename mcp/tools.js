'use strict';
/**
 * DevTracker MCP tool definitions and dispatch — transport-agnostic.
 * Shared by the stdio server (server.js) and the Streamable HTTP server
 * (http-server.js) so the two transports can never drift. Pure/Node; unit tested.
 */
const store = require('../store/workspace-store');
const context = require('../store/context-index');

const DEFAULT_STORE_PATH = process.env.DEVTRACKER_STORE || store.defaultStorePath();

const TOOLS = [
  {
    name: 'get_briefing',
    description:
      'Call this FIRST at the start of a session. Returns everything needed to stay ' +
      'aligned: standing constraints, decided + proposed decisions, open questions, ' +
      'milestones, the next unblocked ticket, and recent activity.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project id, e.g. "CTXR".' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'query_context_db',
    description:
      "Semantic/lexical search over a project's tickets, decisions, milestones, " +
      'questions, and ingested code/docs. Use to pull relevant project context on ' +
      'demand instead of asking the human to paste it.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'Project id, e.g. "CTXR". Use "*" to search every project.',
        },
        query: { type: 'string', description: 'Natural-language query.' },
        kinds: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['ticket', 'decision', 'milestone', 'question', 'doc', 'code'],
          },
          description: 'Optional filter for result kinds.',
        },
        limit: { type: 'number', description: 'Max results (default 8).' },
      },
      required: ['project_id', 'query'],
    },
  },
  {
    name: 'capture_decision',
    description:
      'Record an architectural decision as a PROPOSAL for the Tech Lead. Provide ' +
      'options with pros and cons. You must NOT choose — the human decides in the ' +
      'DevTracker UI. Status is always set to "proposed".',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        title: { type: 'string' },
        context: { type: 'string', description: 'Why decide this now.' },
        reversibility: { type: 'string', enum: ['one-way', 'two-way', ''] },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              pros: { type: 'array', items: { type: 'string' } },
              cons: { type: 'array', items: { type: 'string' } },
            },
            required: ['name'],
          },
        },
      },
      required: ['project_id', 'title', 'options'],
    },
  },
  {
    name: 'discuss_decision',
    description:
      'Join the debate thread on an existing decision: add an argument, counterpoint, ' +
      'or analysis for the Tech Lead to weigh. You cannot set the choice or status — ' +
      'the human decides in the DevTracker UI.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        decision_id: { type: 'string', description: 'Decision id, e.g. "ADR-003".' },
        comment: {
          type: 'string',
          description: 'Your argument or analysis. Keep it under ~150 words.',
        },
      },
      required: ['project_id', 'decision_id', 'comment'],
    },
  },
  {
    name: 'flag_milestone',
    description:
      'Record a completed feature as a milestone candidate, with a distilled ' +
      'session summary (not the raw transcript) and an optional git diff range.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        session_summary: { type: 'string' },
        status: { type: 'string', enum: ['planned', 'done'] },
        diff: {
          type: 'object',
          properties: { from: { type: 'string' }, to: { type: 'string' } },
          description: 'Git commit range for the milestone diff.',
        },
      },
      required: ['project_id', 'title'],
    },
  },
  {
    name: 'update_acceptance_criteria',
    description:
      'Mark acceptance criteria complete (1-based indices), optionally set ticket ' +
      'status, and append a session note. Same effect as pasting a session report.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        ticket_id: { type: 'string' },
        completed_ac: {
          type: 'array',
          items: { type: 'number' },
          description: '1-based AC numbers.',
        },
        status: { type: 'string', enum: ['todo', 'in_progress', 'done'] },
        session: {
          type: 'object',
          properties: { summary: { type: 'string' }, next_steps: { type: 'string' } },
        },
      },
      required: ['project_id', 'ticket_id'],
    },
  },
];

/** Pure tool dispatch — testable without any MCP transport. */
function handleCall(name, args, storePath = DEFAULT_STORE_PATH) {
  args = args || {};
  switch (name) {
    case 'get_briefing': {
      const ws = store.loadWorkspace(storePath);
      return store.buildBriefing(ws, args.project_id);
    }
    case 'query_context_db': {
      const ws = store.loadWorkspace(storePath);
      if (args.project_id === '*') {
        return {
          results: context.searchWorkspace(ws, args.query, {
            kinds: args.kinds,
            limit: args.limit,
          }),
        };
      }
      const project = store.getProject(ws, args.project_id);
      if (!project) throw new Error(`Unknown project: ${args.project_id}`);
      return {
        results: context.search(project, args.query, { kinds: args.kinds, limit: args.limit }),
      };
    }
    case 'capture_decision': {
      const d = store.withStore(storePath, ws =>
        store.addDecision(ws, args.project_id, args, { forceProposed: true })
      );
      return { id: d.id, status: d.status };
    }
    case 'discuss_decision': {
      return store.withStore(storePath, ws =>
        store.addDecisionComment(ws, args.project_id, args.decision_id, {
          role: 'agent',
          text: args.comment,
        })
      );
    }
    case 'flag_milestone': {
      const m = store.withStore(storePath, ws => store.addMilestone(ws, args.project_id, args));
      return { id: m.id, status: m.status };
    }
    case 'update_acceptance_criteria': {
      return store.withStore(storePath, ws =>
        store.updateAcceptanceCriteria(ws, args.project_id, args.ticket_id, args)
      );
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

module.exports = { TOOLS, handleCall, DEFAULT_STORE_PATH };
