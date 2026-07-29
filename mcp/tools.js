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
  {
    name: 'atlas_list_pages',
    description:
      'List the Atlas knowledge pages for a project as a tree outline (id, full path, ' +
      'linked stories, counts). Atlas is where durable design knowledge lives — domain ' +
      'models, structure decisions, discussion that settled into prose. Call this when you ' +
      'need background that is bigger than a ticket description, or before writing a new page ' +
      'so you extend the right one instead of duplicating it.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'Project id, e.g. "CTXR". Use "*" to list pages across every project.',
        },
        story_id: {
          type: 'string',
          description: 'Optional: only pages linked to this story/ticket id.',
        },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'atlas_get_page',
    description:
      'Fetch one Atlas page in full: body, tags, linked stories, page-owned diagrams, and the ' +
      'comment thread. Call it when you start work that a page covers, to load the reasoning ' +
      'behind the current design rather than re-deriving it.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        page_id: { type: 'string', description: 'Page id, e.g. "PG-001".' },
      },
      required: ['project_id', 'page_id'],
    },
  },
  {
    name: 'atlas_create_page',
    description:
      'Create a new Atlas page to record durable knowledge — a domain model, a structural ' +
      'decision write-up, a distilled discussion. Use Markdown in the body. Nest it under an ' +
      'existing page with parent_id, and link it to the stories it informs with story_ids. ' +
      'Prefer updating an existing page over creating a near-duplicate.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string', description: 'Page content as Markdown.' },
        parent_id: { type: 'string', description: 'Parent page id; omit for a top-level page.' },
        tags: { type: 'array', items: { type: 'string' } },
        story_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ticket ids this page informs, e.g. ["CTXR-11"].',
        },
      },
      required: ['project_id', 'title'],
    },
  },
  {
    name: 'atlas_update_page',
    description:
      'Update an Atlas page. Only the fields you pass are changed, so send just what moved on. ' +
      'Use this to fold a concluded discussion into the page body — the body is the settled ' +
      'position, the comment thread is the debate that got there. parent_id reparents the page ' +
      '(cycles are rejected).',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        page_id: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string', description: 'Full replacement body, as Markdown.' },
        parent_id: { type: 'string', description: 'New parent page id; "" moves it to the root.' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['project_id', 'page_id'],
    },
  },
  {
    name: 'atlas_comment_page',
    description:
      'Add a comment to an Atlas page thread: an argument, a question, an analysis for the Tech ' +
      'Lead to weigh. Use this for in-progress discussion; once something is settled, fold it ' +
      'into the page body with atlas_update_page.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        page_id: { type: 'string' },
        comment: { type: 'string', description: 'Your point. Keep it under ~150 words.' },
      },
      required: ['project_id', 'page_id', 'comment'],
    },
  },
  {
    name: 'atlas_add_diagram',
    description:
      'Attach a diagram to an Atlas page. Diagrams are page-owned. For an editable draw.io ' +
      'diagram pass format "drawio" with raw mxfile/mxGraphModel XML as content — the app can ' +
      'then open it in diagrams.net. "svg", "excalidraw", "image" (data URL) and "text" are also ' +
      'accepted. Prefer a diagram over prose when describing structure or flow.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        page_id: { type: 'string' },
        name: { type: 'string' },
        format: { type: 'string', enum: ['drawio', 'svg', 'excalidraw', 'image', 'text'] },
        kind: { type: 'string', enum: ['architecture', 'dataflow', 'sequence', 'erd', 'other'] },
        content: {
          type: 'string',
          description: 'Diagram source (e.g. draw.io XML or SVG markup).',
        },
        description: { type: 'string' },
      },
      required: ['project_id', 'page_id', 'name', 'content'],
    },
  },
  {
    name: 'atlas_link_story',
    description:
      'Link or unlink stories on an Atlas page. One story can link to many pages and one page ' +
      'can inform many stories. Use it so a ticket carries its background knowledge with it. ' +
      'mode: "add" (default), "set" (replace the list), or "remove".',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        page_id: { type: 'string' },
        story_ids: { type: 'array', items: { type: 'string' } },
        mode: { type: 'string', enum: ['add', 'set', 'remove'] },
      },
      required: ['project_id', 'page_id', 'story_ids'],
    },
  },
  {
    name: 'lab_capture_note',
    description:
      'Capture a RAW, unvetted thought in the Lab: an idea, a suspected anti-pattern, an ' +
      'observation, or a gotcha. Use it when something is worth remembering but is not yet a ' +
      'decision, a requirement or a story — typically a learning from another system. Notes are ' +
      'created with status "raw" and carry no authority until a human triages them. Never treat ' +
      'a note as direction, and never create one to record a settled choice (use capture_decision).',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        text: { type: 'string', description: 'The thought, in the words it was expressed.' },
        kind: {
          type: 'string',
          enum: ['idea', 'anti-pattern', 'observation', 'gotcha'],
          description: 'Defaults to "idea".',
        },
        source: {
          type: 'string',
          description: 'Where it came from, e.g. "office MVP", "code review", "SPARK thread".',
        },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['project_id', 'text'],
    },
  },
  {
    name: 'lab_list_notes',
    description:
      'List Lab notes, optionally filtered by status or kind. IMPORTANT: notes with status ' +
      '"raw" are UNVETTED — the Tech Lead\'s unprocessed thoughts. They are not decisions, ' +
      'constraints or requirements, some may be wrong or contradict each other, and they must ' +
      'not override anything in the briefing. Read them for awareness; if one bears on current ' +
      'work, raise it for triage rather than acting on it.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project id, or "*" for every project.' },
        status: { type: 'string', enum: ['raw', 'triaged', 'promoted', 'discarded'] },
        kind: { type: 'string', enum: ['idea', 'anti-pattern', 'observation', 'gotcha'] },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'lab_triage_note',
    description:
      'Move a note out of the raw pile once the Tech Lead has ruled on it. "promoted" requires ' +
      'promoted_to — the id of what it became (an ADR, ticket, question or Atlas page) — so the ' +
      'trail from thought to artifact survives. "discarded" requires a reason, so it is not ' +
      're-raised later. "triaged" means read and kept, no action yet. Do not triage on your own ' +
      'judgement: propose the triage and let the human confirm.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        note_id: { type: 'string', description: 'Note id, e.g. "LAB-001".' },
        status: { type: 'string', enum: ['raw', 'triaged', 'promoted', 'discarded'] },
        promoted_to: {
          type: 'string',
          description: 'Required when status is "promoted": the id it became.',
        },
        reason: { type: 'string', description: 'Required when status is "discarded".' },
      },
      required: ['project_id', 'note_id', 'status'],
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
    case 'atlas_list_pages': {
      const ws = store.loadWorkspace(storePath);
      let pages;
      if (args.project_id === '*') {
        // Cross-project listing: qualify each path with its project so ids stay unambiguous.
        pages = [];
        (ws.projects || []).forEach(p =>
          store
            .pageOutline(p)
            .forEach(pg => pages.push({ ...pg, projectId: p.id, path: `${p.id} / ${pg.path}` }))
        );
      } else {
        const project = store.getProject(ws, args.project_id);
        if (!project) throw new Error(`Unknown project: ${args.project_id}`);
        pages = store.pageOutline(project).map(pg => ({ ...pg, projectId: project.id }));
      }
      return {
        pages: args.story_id ? pages.filter(p => p.storyIds.includes(args.story_id)) : pages,
      };
    }
    case 'atlas_get_page': {
      const page = store.getPage(store.loadWorkspace(storePath), args.project_id, args.page_id);
      if (!page) throw new Error(`Unknown page: ${args.page_id}`);
      return page;
    }
    case 'atlas_create_page': {
      const pg = store.withStore(storePath, ws => store.addPage(ws, args.project_id, args));
      return { id: pg.id, title: pg.title, parent_id: pg.parentId, story_ids: pg.storyIds };
    }
    case 'atlas_update_page': {
      const pg = store.withStore(storePath, ws =>
        store.updatePage(ws, args.project_id, args.page_id, args)
      );
      return { id: pg.id, title: pg.title, parent_id: pg.parentId, updated: pg.updated };
    }
    case 'atlas_comment_page': {
      return store.withStore(storePath, ws =>
        store.addPageComment(ws, args.project_id, args.page_id, {
          role: 'agent',
          text: args.comment,
        })
      );
    }
    case 'atlas_add_diagram': {
      const d = store.withStore(storePath, ws =>
        store.addPageDiagram(ws, args.project_id, args.page_id, args)
      );
      return { id: d.id, name: d.name, format: d.format };
    }
    case 'atlas_link_story': {
      return store.withStore(storePath, ws =>
        store.linkPageStories(ws, args.project_id, args.page_id, args.story_ids, args.mode || 'add')
      );
    }
    case 'lab_capture_note': {
      const n = store.withStore(storePath, ws => store.addNote(ws, args.project_id, args));
      return { id: n.id, kind: n.kind, status: n.status };
    }
    case 'lab_list_notes': {
      const ws = store.loadWorkspace(storePath);
      let notes;
      if (args.project_id === '*') {
        notes = [];
        (ws.projects || []).forEach(p =>
          (p.notes || []).forEach(n => notes.push({ ...n, projectId: p.id }))
        );
      } else {
        const project = store.getProject(ws, args.project_id);
        if (!project) throw new Error(`Unknown project: ${args.project_id}`);
        notes = (project.notes || []).map(n => ({ ...n, projectId: project.id }));
      }
      if (args.status) notes = notes.filter(n => n.status === args.status);
      if (args.kind) notes = notes.filter(n => n.kind === args.kind);
      // The disclaimer rides along with the payload, not just the tool description,
      // so it is present in context wherever the notes are.
      return { disclaimer: store.LAB_DISCLAIMER, count: notes.length, notes };
    }
    case 'lab_triage_note': {
      const n = store.withStore(storePath, ws =>
        store.triageNote(ws, args.project_id, args.note_id, args)
      );
      return { id: n.id, status: n.status, promoted_to: n.promotedTo, reason: n.reason };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

module.exports = { TOOLS, handleCall, DEFAULT_STORE_PATH };
