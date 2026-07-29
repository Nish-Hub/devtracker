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

test('exposes exactly the documented tools', () => {
  expect(TOOLS.map(t => t.name).sort()).toEqual([
    'atlas_add_diagram',
    'atlas_comment_page',
    'atlas_create_page',
    'atlas_get_page',
    'atlas_link_story',
    'atlas_list_pages',
    'atlas_update_page',
    'capture_decision',
    'discuss_decision',
    'flag_milestone',
    'get_briefing',
    'lab_capture_note',
    'lab_list_notes',
    'lab_triage_note',
    'query_context_db',
    'update_acceptance_criteria',
  ]);
});

test('every tool has a non-trivial description and an object input schema', () => {
  TOOLS.forEach(t => {
    expect(t.description.length).toBeGreaterThan(40);
    expect(t.inputSchema.type).toBe('object');
  });
});

describe('lab notes', () => {
  test('captures raw notes and rejects empty text', () => {
    const n = handleCall(
      'lab_capture_note',
      { project_id: 'CTXR', text: 'Mongo for relations felt wrong', kind: 'anti-pattern' },
      storePath
    );
    expect(n.status).toBe('raw');
    expect(n.kind).toBe('anti-pattern');
    expect(() =>
      handleCall('lab_capture_note', { project_id: 'CTXR', text: '   ' }, storePath)
    ).toThrow(/required/i);
  });

  test('triage refuses to promote without a target or discard without a reason', () => {
    const n = handleCall('lab_capture_note', { project_id: 'CTXR', text: 'a thought' }, storePath);
    expect(() =>
      handleCall(
        'lab_triage_note',
        { project_id: 'CTXR', note_id: n.id, status: 'promoted' },
        storePath
      )
    ).toThrow(/promoted_to/);
    expect(() =>
      handleCall(
        'lab_triage_note',
        { project_id: 'CTXR', note_id: n.id, status: 'discarded' },
        storePath
      )
    ).toThrow(/reason/);
    const done = handleCall(
      'lab_triage_note',
      { project_id: 'CTXR', note_id: n.id, status: 'promoted', promoted_to: 'ADR-009' },
      storePath
    );
    expect(done).toMatchObject({ status: 'promoted', promoted_to: 'ADR-009' });
  });

  test('raw notes are always accompanied by the unvetted disclaimer', () => {
    handleCall('lab_capture_note', { project_id: 'CTXR', text: 'half-formed idea' }, storePath);
    const listed = handleCall('lab_list_notes', { project_id: 'CTXR', status: 'raw' }, storePath);
    expect(listed.disclaimer).toMatch(/UNVETTED/);
    expect(listed.disclaimer).toMatch(/NOT decisions/);
    listed.notes.forEach(n => expect(n.status).toBe('raw'));

    const briefing = handleCall('get_briefing', { project_id: 'CTXR' }, storePath);
    expect(briefing.lab_notes.disclaimer).toMatch(/Do NOT act/);
    expect(briefing.lab_notes.counts.total).toBeGreaterThan(0);
    // Only raw notes are surfaced in the briefing body.
    briefing.lab_notes.raw.forEach(n => expect(n.id).toBeTruthy());
  });
});

describe('atlas pages', () => {
  test('creates a nested tree, rejects cycles, and links stories', () => {
    const parent = handleCall(
      'atlas_create_page',
      { project_id: 'CTXR', title: 'Domain structure', body: '# Model' },
      storePath
    );
    const child = handleCall(
      'atlas_create_page',
      { project_id: 'CTXR', title: 'Ports', parent_id: parent.id },
      storePath
    );
    const outline = handleCall('atlas_list_pages', { project_id: 'CTXR' }, storePath).pages;
    expect(outline.find(p => p.id === child.id).path).toBe('Domain structure / Ports');
    expect(outline.find(p => p.id === child.id).depth).toBe(1);

    expect(() =>
      handleCall(
        'atlas_update_page',
        { project_id: 'CTXR', page_id: parent.id, parent_id: child.id },
        storePath
      )
    ).toThrow(/cycle/i);

    expect(() =>
      handleCall(
        'atlas_create_page',
        { project_id: 'CTXR', title: 'Orphan', parent_id: 'PG-999' },
        storePath
      )
    ).toThrow(/parent/i);
  });

  test('project_id "*" lists pages across projects with qualified paths', () => {
    handleCall('atlas_create_page', { project_id: 'CTXR', title: 'Scoped' }, storePath);
    const all = handleCall('atlas_list_pages', { project_id: '*' }, storePath).pages;
    expect(all.length).toBeGreaterThan(0);
    all.forEach(p => {
      expect(p.projectId).toBeTruthy();
      expect(p.path.startsWith(`${p.projectId} / `)).toBe(true);
    });
    expect(() => handleCall('atlas_list_pages', { project_id: 'NOPE' }, storePath)).toThrow();
  });

  test('comments, page-owned diagrams, and story links persist', () => {
    const pg = handleCall('atlas_create_page', { project_id: 'CTXR', title: 'Notes' }, storePath);
    handleCall(
      'atlas_comment_page',
      { project_id: 'CTXR', page_id: pg.id, comment: 'an argument' },
      storePath
    );
    handleCall(
      'atlas_add_diagram',
      {
        project_id: 'CTXR',
        page_id: pg.id,
        name: 'Flow',
        format: 'drawio',
        content: '<mxfile/>',
      },
      storePath
    );
    handleCall(
      'atlas_link_story',
      { project_id: 'CTXR', page_id: pg.id, story_ids: ['CTXR-5', 'NOPE-1'] },
      storePath
    );
    const full = handleCall('atlas_get_page', { project_id: 'CTXR', page_id: pg.id }, storePath);
    expect(full.comments).toHaveLength(1);
    expect(full.comments[0].role).toBe('agent');
    expect(full.diagrams[0].format).toBe('drawio');
    // Unknown story ids are filtered out so links can never dangle.
    expect(full.storyIds).toEqual(['CTXR-5']);
    const filtered = handleCall(
      'atlas_list_pages',
      { project_id: 'CTXR', story_id: 'CTXR-5' },
      storePath
    ).pages;
    expect(filtered.map(p => p.id)).toContain(pg.id);
  });
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
