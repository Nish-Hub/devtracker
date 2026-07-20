'use strict';
/**
 * DevTracker repo ingestion.
 * Walks a project's source tree, chunks code and docs, and writes them into
 * project.contextChunks in the shared store so query_context_db (context-index.js)
 * covers real code and documentation - not just workspace items (design section 3.4).
 * Pure Node; the walk/chunk logic is unit tested.
 */
const fs = require('fs');
const path = require('path');
const store = require('./workspace-store');

const CODE_EXT = new Set([
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.py',
  '.java',
  '.go',
  '.rs',
  '.rb',
  '.php',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.kt',
  '.swift',
  '.scala',
  '.sh',
  '.sql',
]);
const DOC_EXT = new Set(['.md', '.markdown', '.txt', '.rst', '.adoc']);
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'out',
  'coverage',
  '__pycache__',
  'vendor',
  '.cache',
  '.venv',
  'venv',
]);

const DEFAULTS = {
  maxFileBytes: 200 * 1024,
  linesPerChunk: 60,
  maxChunksPerFile: 40,
  maxTotalChunks: 4000,
};

function kindFor(ext) {
  if (DOC_EXT.has(ext)) return 'doc';
  if (CODE_EXT.has(ext)) return 'code';
  return null;
}

function looksBinary(content) {
  return content.indexOf('\x00') !== -1;
}

function walk(rootDir, opts, acc, dir) {
  acc = acc || [];
  dir = dir || rootDir;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return acc;
  }
  for (const ent of entries) {
    if (acc.length >= opts.maxTotalChunks) break;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name) || ent.name.startsWith('.')) continue;
      walk(rootDir, opts, acc, full);
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name).toLowerCase();
      const kind = kindFor(ext);
      if (!kind) continue;
      let stat;
      try {
        stat = fs.statSync(full);
      } catch (e) {
        continue;
      }
      if (stat.size > opts.maxFileBytes || stat.size === 0) continue;
      let content;
      try {
        content = fs.readFileSync(full, 'utf8');
      } catch (e) {
        continue;
      }
      if (looksBinary(content)) continue;
      const rel = path.relative(rootDir, full).split(path.sep).join('/');
      buildFileChunks(rel, content, kind, opts).forEach(c => {
        if (acc.length < opts.maxTotalChunks) acc.push(c);
      });
    }
  }
  return acc;
}

function buildFileChunks(relPath, content, kind, opts) {
  opts = { ...DEFAULTS, ...(opts || {}) };
  const lines = content.split('\n');
  const chunks = [];
  const per = opts.linesPerChunk;
  for (let i = 0; i < lines.length && chunks.length < opts.maxChunksPerFile; i += per) {
    const text = lines
      .slice(i, i + per)
      .join('\n')
      .trim();
    if (!text) continue;
    const startLine = i + 1;
    chunks.push({
      id: `${relPath}#L${startLine}`,
      kind,
      title: `${relPath} (line ${startLine})`,
      ref: `${relPath}#L${startLine}`,
      text,
    });
  }
  return chunks;
}

/** Walk rootDir and return context chunks (pure; no store writes). */
function ingestPaths(rootDir, options) {
  const opts = { ...DEFAULTS, ...(options || {}) };
  return walk(rootDir, opts, [], rootDir);
}

/** Full reindex: replace project.contextChunks with a fresh crawl of rootDir. */
function ingestIntoStore(storePath, projectId, rootDir, options) {
  const chunks = ingestPaths(rootDir, options);
  return store.withStore(storePath, ws => {
    const project = store.getProject(ws, projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    project.contextChunks = chunks;
    return { projectId, indexed: chunks.length, root: rootDir };
  });
}

module.exports = {
  CODE_EXT,
  DOC_EXT,
  SKIP_DIRS,
  kindFor,
  buildFileChunks,
  ingestPaths,
  ingestIntoStore,
};

if (require.main === module) {
  const [, , projectId, rootArg] = process.argv;
  if (!projectId) {
    console.error('Usage: node store/ingest.js <projectId> [rootDir]');
    process.exit(1);
  }
  const rootDir = rootArg ? path.resolve(rootArg) : path.resolve(__dirname, '..');
  const storePath = process.env.DEVTRACKER_STORE || store.defaultStorePath();
  const res = ingestIntoStore(storePath, projectId, rootDir);
  console.log(
    `Indexed ${res.indexed} chunks from ${res.root} into project ${res.projectId} (${storePath}).`
  );
}
