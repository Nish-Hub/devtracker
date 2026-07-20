'use strict';
// Exercises the real MCP tool dispatch (handleCall) exported by mcp/server.js.
// Requiring the module does NOT start the server (guarded by require.main).
const os = require('os');
const fs = require('fs');
const path = require('path');
const S = require('../store/workspace-store');
const { TOOLS, handleCall } = require('../mcp/server');

let storePath;
beforeEach(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-mcp-'));
  storePath = path.join(tmp, 'workspace.json');
  S.saveWorkspace(storePath, {
    version: 3,
    activeProjectId: 'CTXR',
    projects: [
      {
        id: 'CTXR',
        name: 'ContextRAG MVP',
        code: 'CTXR',
        description: 'retrieval',
        tickets: [
          {
            id: 'CTXR-5',
            title: 'GitHub code adapter',
            deps: [],
            description: 'ingest and embed with jina, handle rate limits',
            acceptanceCriteria: [
              { text: 'repo configurable', done: false },
              { text: 'chunks embedded', done: false },
            ],
            definitionOfDone: '',
            technicalNotes: '',
            status: 'todo',
            sessions: [],
            scratchpad: '',
          },
        ],
        decisions: [
          {
            id: 'ADR-003',
            title: 'Vector store for retrieval',
            status: 'proposed',
            context: 'needs a vector backend',
            options: [{ name: 'Qdrant', pros: ['fast'], cons: ['ops'] }],
            choice: '',
            rationale: '',
          },
        ],
        milestones: [],
        questions: [],
        architecture: {},
        chat: [],
      },
    ],
  });
});

test('exposes exactly the six documented tools', () => {
  expect(TOOLS.map(t => t.name).sort()).toEqual([
    'capture_decision',
    'discuss_decision',
    'flag_milestone',
    'get_briefing',
    'query_context_db',
    'update_acceptance_criteria',
  ]);
});

test('get_briefing returns constraints, decisions, next ticket, and rules', () => {
  const r = handleCall('get_briefing', { project_id: 'CTXR' }, storePath);
  expect(r.project.id).toBe('CTXR');
  expect(r.rules).toMatch(/decided/i);
  expect(r.decisions.proposed.some(d => d.id === 'ADR-003')).toBe(true);
  expect(r.next_ticket.id).toBe('CTXR-5');
  expect(Array.isArray(r.constraints)).toBe(true);
  expect(() => handleCall('get_briefing', { project_id: 'NOPE' }, storePath)).toThrow();
});

test('query_context_db with project_id "*" searches across projects and tags hits', () => {
  const r = handleCall(
    'query_context_db',
    { project_id: '*', query: 'vector store retrieval' },
    storePath
  );
  expect(r.results.length).toBeGreaterThan(0);
  expect(r.results[0].project_id).toBe('CTXR');
});

test('capture_decision forces proposed even when the agent tries to decide', () => {
  const r = handleCall(
    'capture_decision',
    {
      project_id: 'CTXR',
      title: 'Adopt Qdrant now',
      choice: 'Qdrant',
      status: 'decided',
      options: [{ name: 'Qdrant', pros: ['x'], cons: ['y'] }],
    },
    storePath
  );
  expect(r.status).toBe('proposed');
  const d = S.loadWorkspace(storePath).projects[0].decisions.find(x => x.id === r.id);
  expect(d.choice).toBe('');
  expect(d.status).toBe('proposed');
  expect(d.source).toBe('agent');
});

test('discuss_decision appends to the debate thread without touching status or choice', () => {
  const r = handleCall(
    'discuss_decision',
    {
      project_id: 'CTXR',
      decision_id: 'ADR-003',
      comment: 'The ops burden of Qdrant is overstated for a single-node deployment.',
    },
    storePath
  );
  expect(r.comments).toBe(1);
  const d = S.loadWorkspace(storePath).projects[0].decisions.find(x => x.id === 'ADR-003');
  expect(d.discussion).toHaveLength(1);
  expect(d.discussion[0].role).toBe('agent');
  expect(d.status).toBe('proposed');
  expect(d.choice).toBe('');
  expect(() =>
    handleCall(
      'discuss_decision',
      { project_id: 'CTXR', decision_id: 'ADR-999', comment: 'x' },
      storePath
    )
  ).toThrow();
});

test('flag_milestone records a candidate milestone', () => {
  const r = handleCall(
    'flag_milestone',
    {
      project_id: 'CTXR',
      title: 'MVP retrieval',
      session_summary: 'wired pipeline',
      diff: { from: 'a', to: 'b' },
      status: 'done',
    },
    storePath
  );
  expect(r.status).toBe('done');
});

test('update_acceptance_criteria applies 1-based AC indices', () => {
  const r = handleCall(
    'update_acceptance_criteria',
    {
      project_id: 'CTXR',
      ticket_id: 'CTXR-5',
      completed_ac: [2],
      status: 'in_progress',
      session: { summary: 'did it', next_steps: 'next' },
    },
    storePath
  );
  expect(r.done_ac).toBe(1);
  const tk = S.loadWorkspace(storePath).projects[0].tickets[0];
  expect(tk.acceptanceCriteria[1].done).toBe(true);
});

test('query_context_db returns ranked results', () => {
  const r = handleCall(
    'query_context_db',
    { project_id: 'CTXR', query: 'jina rate limits' },
    storePath
  );
  expect(r.results.length).toBeGreaterThan(0);
  expect(r.results[0].score).toBeGreaterThan(0);
});

test('unknown project and unknown tool throw', () => {
  expect(() =>
    handleCall('capture_decision', { project_id: 'NOPE', title: 'x', options: [] }, storePath)
  ).toThrow();
  expect(() => handleCall('bogus', {}, storePath)).toThrow();
});
