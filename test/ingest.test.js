'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const S = require('../store/workspace-store');
const I = require('../store/ingest');
const C = require('../store/context-index');

let root, storePath;
beforeEach(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-ing-'));
  root = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'junk'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'src', 'auth.js'),
    'function login(user){\n  // handle jwt token refresh and caching\n  return cacheToken(user);\n}\n'
  );
  fs.writeFileSync(
    path.join(root, 'README.md'),
    '# Payments\nWe handle caching in the payments module using redis.\n'
  );
  fs.writeFileSync(path.join(root, 'node_modules', 'junk', 'x.js'), 'module.exports=1;\n'); // must be skipped
  fs.writeFileSync(path.join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])); // binary skipped
  storePath = path.join(tmp, 'workspace.json');
  S.saveWorkspace(storePath, {
    version: 3,
    activeProjectId: 'CTXR',
    projects: [
      {
        id: 'CTXR',
        name: 'x',
        code: 'CTXR',
        description: '',
        tickets: [],
        decisions: [],
        milestones: [],
        questions: [],
        architecture: {},
        chat: [],
      },
    ],
  });
});

test('ingestPaths skips node_modules and binary, indexes code + docs', () => {
  const chunks = I.ingestPaths(root);
  const refs = chunks.map(c => c.ref);
  expect(refs.some(r => r.startsWith('src/auth.js'))).toBe(true);
  expect(refs.some(r => r.startsWith('README.md'))).toBe(true);
  expect(refs.some(r => r.includes('node_modules'))).toBe(false);
  expect(refs.some(r => r.includes('logo.png'))).toBe(false);
  const kinds = new Set(chunks.map(c => c.kind));
  expect(kinds.has('code')).toBe(true);
  expect(kinds.has('doc')).toBe(true);
});

test('ingestIntoStore writes contextChunks and is idempotent', () => {
  const r1 = I.ingestIntoStore(storePath, 'CTXR', root);
  expect(r1.indexed).toBeGreaterThan(0);
  const r2 = I.ingestIntoStore(storePath, 'CTXR', root);
  expect(r2.indexed).toBe(r1.indexed); // full reindex, no duplication
  const ws = S.loadWorkspace(storePath);
  expect(ws.projects[0].contextChunks.length).toBe(r1.indexed);
});

test('query_context_db finds ingested code and doc content', () => {
  I.ingestIntoStore(storePath, 'CTXR', root);
  const proj = S.loadWorkspace(storePath).projects[0];
  const res = C.search(proj, 'caching payments redis', { limit: 5 });
  expect(res.length).toBeGreaterThan(0);
  expect(res.some(r => r.ref.startsWith('README.md'))).toBe(true);
  const codeRes = C.search(proj, 'jwt token refresh', { kinds: ['code'] });
  expect(codeRes.some(r => r.ref.startsWith('src/auth.js'))).toBe(true);
});

test('unknown project throws', () => {
  expect(() => I.ingestIntoStore(storePath, 'NOPE', root)).toThrow();
});
