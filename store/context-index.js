'use strict';
/**
 * DevTracker offline context index.
 * Backs query_context_db (MCP_SERVER.md 3.1). Pure JS, no native deps, works
 * offline. This is a LEXICAL baseline (TF-IDF cosine over token vectors); the
 * search() interface is deliberately shaped so a neural embedding backend can
 * replace scoring later without changing callers (ADR-DT-003).
 */

const STOP = new Set(
  (
    'a an and are as at be by for from has have how in into is it its of on or that the ' +
    'this to was were what when where which who will with we you our your they their'
  ).split(' ')
);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(w => w.length > 1 && !STOP.has(w));
}

function termFreq(tokens) {
  const tf = new Map();
  tokens.forEach(t => tf.set(t, (tf.get(t) || 0) + 1));
  return tf;
}

/** Flatten a project into searchable chunks: kind, id, title, text, ref. */
function buildChunks(project) {
  if (!project) return [];
  const chunks = [];
  (project.tickets || []).forEach(t => {
    chunks.push({
      kind: 'ticket',
      id: t.id,
      title: t.title || t.id,
      ref: `tickets/${t.id}`,
      text: [
        t.title,
        t.description,
        t.technicalNotes,
        t.definitionOfDone,
        (t.acceptanceCriteria || []).map(a => a.text).join(' '),
      ]
        .filter(Boolean)
        .join(' '),
    });
  });
  (project.decisions || []).forEach(d => {
    const opts = (d.options || [])
      .map(o => `${o.name} pros ${(o.pros || []).join(' ')} cons ${(o.cons || []).join(' ')}`)
      .join(' ');
    chunks.push({
      kind: 'decision',
      id: d.id,
      title: d.title || d.id,
      ref: `decisions/${d.id}`,
      text: [d.title, d.context, opts, d.choice, d.rationale].filter(Boolean).join(' '),
    });
  });
  (project.milestones || []).forEach(m => {
    chunks.push({
      kind: 'milestone',
      id: m.id,
      title: m.title || m.id,
      ref: `milestones/${m.id}`,
      text: [m.title, m.description, m.sessionSummary].filter(Boolean).join(' '),
    });
  });
  (project.questions || []).forEach(q => {
    chunks.push({
      kind: 'question',
      id: q.id,
      title: q.text,
      ref: `questions/${q.id}`,
      text: q.text,
    });
  });
  // Externally supplied docs/code chunks, if present.
  (project.contextChunks || []).forEach((c, i) => {
    chunks.push({
      kind: c.kind || 'doc',
      id: c.id || `CTX-${i + 1}`,
      title: c.title || c.ref || `context ${i + 1}`,
      ref: c.ref || `context/${i + 1}`,
      text: c.text || '',
    });
  });
  return chunks;
}

function snippet(text, queryTokens, len = 200) {
  const s = String(text || '');
  const lower = s.toLowerCase();
  let at = -1;
  for (const q of queryTokens) {
    const i = lower.indexOf(q);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return s.slice(0, len) + (s.length > len ? '…' : '');
  const start = Math.max(0, at - 40);
  return (start > 0 ? '…' : '') + s.slice(start, start + len) + (s.length > start + len ? '…' : '');
}

/**
 * BM25 scoring (ADR-DT-003 interim upgrade over plain TF-IDF cosine): better
 * length normalization and term saturation for uneven chunks (short questions
 * vs long ingested code files). Titles are double-counted as a cheap field
 * boost, and an exact-phrase hit earns a bonus. Same interface as before, so a
 * neural embedding backend can still replace scoring without touching callers.
 * @param {object} project  normalized project
 * @param {string} query
 * @param {object} [opts]  { kinds?: string[], limit?: number }
 * @returns {Array<{kind,id,title,score,snippet,ref}>}
 */
function search(project, query, opts = {}) {
  const kinds = Array.isArray(opts.kinds) && opts.kinds.length ? new Set(opts.kinds) : null;
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 8;
  let chunks = buildChunks(project);
  if (kinds) chunks = chunks.filter(c => kinds.has(c.kind));
  if (!chunks.length) return [];

  const K1 = 1.5,
    B = 0.75;
  const docTokens = chunks.map(c => tokenize(c.text + ' ' + c.title + ' ' + c.title));
  const N = chunks.length;
  const avgLen = docTokens.reduce((a, t) => a + t.length, 0) / N || 1;
  const df = new Map();
  docTokens.forEach(toks => new Set(toks).forEach(t => df.set(t, (df.get(t) || 0) + 1)));
  const idf = t => Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));

  const qTokens = tokenize(query);
  if (!qTokens.length) return [];
  const qTerms = [...new Set(qTokens)];
  const phrase = qTokens.join(' ');

  const scored = chunks.map((c, i) => {
    const tf = termFreq(docTokens[i]);
    const dl = docTokens[i].length || 1;
    let score = 0;
    qTerms.forEach(t => {
      const f = tf.get(t) || 0;
      if (!f) return;
      score += (idf(t) * (f * (K1 + 1))) / (f + K1 * (1 - B + (B * dl) / avgLen));
    });
    if (
      score > 0 &&
      qTokens.length > 1 &&
      tokenize(c.text + ' ' + c.title)
        .join(' ')
        .includes(phrase)
    )
      score *= 1.25;
    return {
      kind: c.kind,
      id: c.id,
      title: c.title,
      score: Number(score.toFixed(4)),
      snippet: snippet(c.text, qTokens),
      ref: c.ref,
    };
  });

  return scored
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Cross-project search: same result shape plus project_id on every hit. */
function searchWorkspace(ws, query, opts = {}) {
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 12;
  const hits = [];
  (ws.projects || []).forEach(p => {
    search(p, query, { ...opts, limit }).forEach(r => hits.push({ project_id: p.id, ...r }));
  });
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

module.exports = { tokenize, buildChunks, search, searchWorkspace };
