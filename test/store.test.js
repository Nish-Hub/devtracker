'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const S = require('../store/workspace-store');

function seed() {
  return {
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
            effort: 'M',
            deps: ['CTXR-3'],
            description: 'Ingest source files and embed them with Jina, handle rate limits.',
            acceptanceCriteria: [
              { text: 'configurable repo', done: false },
              { text: 'chunks embedded', done: false },
              { text: 'idempotent reruns', done: false },
            ],
            definitionOfDone: 'indexed end to end',
            technicalNotes: 'deterministic ids',
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
            context: 'needs a backend',
            options: [{ name: 'Qdrant', pros: ['purpose-built'], cons: ['extra service'] }],
            choice: '',
            rationale: '',
          },
        ],
        milestones: [
          {
            id: 'MS-001',
            title: 'Foundation online',
            description: 'health endpoint',
            status: 'done',
            date: '2026-07-19',
          },
        ],
        questions: [
          { id: 'Q-002', lane: 'agent', text: 'What Jina rate limits to target?', resolved: false },
        ],
        architecture: { name: '', type: '', content: '', description: '' },
        chat: [],
      },
    ],
  };
}

let tmp, storePath;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-store-'));
  storePath = path.join(tmp, 'nested', 'workspace.json');
  S.saveWorkspace(storePath, seed());
});

test('save creates nested dirs and load round-trips', () => {
  expect(fs.existsSync(storePath)).toBe(true);
  const ws = S.loadWorkspace(storePath);
  expect(ws.projects[0].tickets[0].id).toBe('CTXR-5');
});

test('load of a missing file returns an empty normalized workspace', () => {
  const ws = S.loadWorkspace(path.join(tmp, 'missing.json'));
  expect(ws.version).toBe(3);
  expect(ws.projects).toEqual([]);
});

test('normalizeWorkspace backfills missing ticket arrays', () => {
  const ws = S.normalizeWorkspace({ projects: [{ id: 'X', tickets: [{ id: 'X-1' }] }] });
  const tk = ws.projects[0].tickets[0];
  expect(Array.isArray(tk.acceptanceCriteria)).toBe(true);
  expect(Array.isArray(tk.sessions)).toBe(true);
  expect(tk.status).toBe('todo');
});

test('addDecision with forceProposed strips choice/status and avoids id collision', () => {
  const out = S.withStore(storePath, ws =>
    S.addDecision(
      ws,
      'CTXR',
      {
        title: 'Adopt Qdrant',
        choice: 'Qdrant',
        status: 'decided',
        options: [{ name: 'Qdrant', pros: ['x'], cons: ['y'] }],
      },
      { forceProposed: true }
    )
  );
  expect(out.status).toBe('proposed');
  expect(out.choice).toBe('');
  expect(out.id).toBe('ADR-004'); // one past existing ADR-003, not length-based
});

test('addDecisionComment appends a thread entry that survives normalization', () => {
  S.withStore(storePath, ws =>
    S.addDecisionComment(ws, 'CTXR', 'ADR-003', { role: 'agent', text: 'consider pgvector too' })
  );
  const d = S.loadWorkspace(storePath).projects[0].decisions[0];
  expect(d.discussion).toHaveLength(1);
  expect(d.discussion[0].role).toBe('agent');
  expect(d.discussion[0].text).toBe('consider pgvector too');
  expect(d.discussion[0].ts).toBeTruthy();
  expect(() =>
    S.withStore(storePath, ws => S.addDecisionComment(ws, 'CTXR', 'ADR-999', { text: 'x' }))
  ).toThrow();
  expect(() =>
    S.withStore(storePath, ws => S.addDecisionComment(ws, 'CTXR', 'ADR-003', { text: '  ' }))
  ).toThrow();
});

test('addMilestone applies defaults and stores diff ref + summary', () => {
  const out = S.withStore(storePath, ws =>
    S.addMilestone(ws, 'CTXR', {
      title: 'MVP',
      status: 'done',
      session_summary: 'wired it',
      diff: { from: 'a', to: 'b' },
    })
  );
  expect(out.status).toBe('done');
  expect(out.date).toBeTruthy();
  expect(out.sessionSummary).toBe('wired it');
  expect(out.diffRef).toEqual({ from: 'a', to: 'b' });
});

test('updateAcceptanceCriteria is 1-based and appends a session', () => {
  const out = S.withStore(storePath, ws =>
    S.updateAcceptanceCriteria(ws, 'CTXR', 'CTXR-5', {
      completed_ac: [1, 3],
      status: 'in_progress',
      session: { summary: 's', next_steps: 'n' },
    })
  );
  expect(out.done_ac).toBe(2);
  expect(out.status).toBe('in_progress');
  const ws = S.loadWorkspace(storePath);
  const ac = ws.projects[0].tickets[0].acceptanceCriteria;
  expect(ac[0].done).toBe(true);
  expect(ac[1].done).toBe(false);
  expect(ac[2].done).toBe(true);
  expect(ws.projects[0].tickets[0].sessions).toHaveLength(1);
});

test('mutators append to the project activity feed', () => {
  S.withStore(storePath, ws => {
    S.addMilestone(ws, 'CTXR', { title: 'MVP', status: 'done' });
    S.addDecision(ws, 'CTXR', { title: 'X', options: [] }, { forceProposed: true });
  });
  const p = S.loadWorkspace(storePath).projects[0];
  expect(p.activity.length).toBe(2);
  expect(p.activity[0].type).toBe('milestone');
  expect(p.activity[1].type).toBe('decision');
  expect(p.activity.every(e => e.ts && e.text)).toBe(true);
});

test('buildBriefing surfaces constraints and the next unblocked ticket', () => {
  S.withStore(storePath, ws => {
    const p = S.getProject(ws, 'CTXR');
    p.constraints = [
      { id: 'CON-001', text: 'Privacy-first: no telemetry', active: true },
      { id: 'CON-002', text: 'inactive rule', active: false },
    ];
    p.tickets[0].deps = []; // make it unblocked
  });
  const b = S.buildBriefing(S.loadWorkspace(storePath), 'CTXR');
  expect(b.constraints).toEqual(['Privacy-first: no telemetry']);
  expect(b.next_ticket.id).toBe('CTXR-5');
  expect(b.next_ticket.acceptance_criteria[0].n).toBe(1);
  expect(b.decisions.proposed[0].id).toBe('ADR-003');
});

test('normalizeWorkspace migrates a legacy architecture upload into diagrams once', () => {
  const ws = S.normalizeWorkspace({
    projects: [
      {
        id: 'X',
        architecture: { name: 'arch.svg', type: 'svg', content: '<svg/>', description: 'd' },
      },
    ],
  });
  expect(ws.projects[0].diagrams).toHaveLength(1);
  expect(ws.projects[0].diagrams[0].format).toBe('svg');
  const again = S.normalizeWorkspace(ws);
  expect(again.projects[0].diagrams).toHaveLength(1); // no duplicate on re-normalize
});

test('unknown project or ticket throws', () => {
  expect(() => S.withStore(storePath, ws => S.addMilestone(ws, 'NOPE', { title: 'x' }))).toThrow();
  expect(() =>
    S.withStore(storePath, ws => S.updateAcceptanceCriteria(ws, 'CTXR', 'NOPE', {}))
  ).toThrow();
});
