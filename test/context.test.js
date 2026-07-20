'use strict';
const C = require('../store/context-index');

const project = {
  id: 'CTXR',
  tickets: [
    {
      id: 'CTXR-5',
      title: 'GitHub code adapter',
      description: 'Ingest source files and embed them with Jina, handle rate limits.',
      acceptanceCriteria: [{ text: 'configurable repo' }, { text: 'chunks embedded' }],
      technicalNotes: 'deterministic ids',
      definitionOfDone: 'indexed end to end',
    },
  ],
  decisions: [
    {
      id: 'ADR-003',
      title: 'Vector store for retrieval',
      context: 'needs a vector backend',
      options: [{ name: 'Qdrant', pros: ['purpose-built'], cons: ['extra service'] }],
      choice: '',
      rationale: '',
    },
  ],
  milestones: [
    { id: 'MS-001', title: 'Foundation online', description: 'health endpoint and mongodb config' },
  ],
  questions: [{ id: 'Q-002', text: 'What Jina API rate limits should ingestion target?' }],
};

test('search ranks a relevant chunk first and returns a positive score', () => {
  const res = C.search(project, 'jina rate limits', { limit: 5 });
  expect(res.length).toBeGreaterThan(0);
  expect(res[0].score).toBeGreaterThan(0);
  expect(res.some(r => r.id === 'CTXR-5' || r.id === 'Q-002')).toBe(true);
});

test('kinds filter restricts result kinds', () => {
  const res = C.search(project, 'vector store retrieval', { kinds: ['decision'] });
  expect(res.length).toBeGreaterThan(0);
  expect(res.every(r => r.kind === 'decision')).toBe(true);
  expect(res[0].id).toBe('ADR-003');
});

test('empty or stopword-only query returns nothing', () => {
  expect(C.search(project, '   ')).toHaveLength(0);
  expect(C.search(project, 'the and of')).toHaveLength(0);
});

test('results carry a string snippet and a ref', () => {
  const res = C.search(project, 'github adapter');
  expect(typeof res[0].snippet).toBe('string');
  expect(res[0].ref).toMatch(/tickets\//);
});
