'use strict';
/**
 * DevTracker shared workspace store.
 * CommonJS module usable by the Electron main process and the MCP server.
 * Source of truth is a single JSON file on disk (ADR-DT-001, JSON-start option).
 * All logic here is pure/Node-only so it can be unit tested without a browser.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const SCHEMA_VERSION = 3;

function defaultStorePath() {
  if (process.env.DEVTRACKER_STORE) return process.env.DEVTRACKER_STORE;
  // Mirror Electron app.getPath('userData') location when possible.
  const home = os.homedir();
  const base =
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'DevTracker')
      : process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'DevTracker')
      : path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'DevTracker');
  return path.join(base, 'workspace.json');
}

function emptyWorkspace() {
  return { version: SCHEMA_VERSION, activeProjectId: '', projects: [] };
}

function normalizeDecision(d) {
  d = d || {};
  return {
    id: d.id,
    date: d.date || '',
    title: d.title || d.decision || 'Untitled decision',
    context: d.context || '',
    reversibility: d.reversibility || '',
    options: Array.isArray(d.options)
      ? d.options.map(o => ({
          name: o.name || '',
          pros: Array.isArray(o.pros) ? o.pros : [],
          cons: Array.isArray(o.cons) ? o.cons : [],
        }))
      : [],
    choice: d.choice || '',
    rationale: d.rationale || '',
    status: d.status || (d.choice || d.decision ? 'decided' : 'proposed'),
    source: d.source || '',
    discussion: Array.isArray(d.discussion)
      ? d.discussion.map(m => ({
          role: ['lead', 'ai', 'agent'].includes(m && m.role) ? m.role : 'agent',
          text: m && m.text != null ? String(m.text) : '',
          ts: (m && m.ts) || '',
          ...(m && Array.isArray(m.updates) ? { updates: m.updates } : {}),
        }))
      : [],
    review:
      d.review && typeof d.review === 'object'
        ? { date: d.review.date || '', model: d.review.model || '', text: d.review.text || '' }
        : null,
  };
}

function normalizeDiagram(g, i) {
  g = g && typeof g === 'object' ? g : {};
  return {
    id: g.id || `DGM-${String(i + 1).padStart(3, '0')}`,
    name: g.name || `Diagram ${i + 1}`,
    kind: ['architecture', 'dataflow', 'sequence', 'erd', 'other'].includes(g.kind)
      ? g.kind
      : 'architecture',
    format: ['svg', 'image', 'drawio', 'excalidraw', 'text'].includes(g.format) ? g.format : 'text',
    type: g.type || '',
    content: typeof g.content === 'string' ? g.content : '',
    description: typeof g.description === 'string' ? g.description : '',
    updated: g.updated || '',
  };
}

// A "journey" is a manually-runnable simulation of one project flow (Postman-style):
// an ordered list of steps, each either a mock API request/response or a mock UI
// screen (HTML), that the tech lead steps through with a live preview.
function normalizeStep(s, i) {
  s = s && typeof s === 'object' ? s : {};
  return {
    id: s.id || `STP-${String(i + 1).padStart(3, '0')}`,
    name: s.name || `Step ${i + 1}`,
    kind: s.kind === 'screen' ? 'screen' : 'request',
    method: s.method || 'GET',
    path: s.path || '',
    request: typeof s.request === 'string' ? s.request : '',
    response: typeof s.response === 'string' ? s.response : '',
    status: Number.isFinite(s.status) ? s.status : 200,
    latencyMs: Number.isFinite(s.latencyMs) ? s.latencyMs : 0,
    note: typeof s.note === 'string' ? s.note : '',
  };
}
function normalizeJourney(j, i) {
  j = j && typeof j === 'object' ? j : {};
  const steps = (Array.isArray(j.steps) ? j.steps : []).map(normalizeStep);
  return {
    id: j.id || `JNY-${String(i + 1).padStart(3, '0')}`,
    name: j.name || `Journey ${i + 1}`,
    description: typeof j.description === 'string' ? j.description : '',
    baseUrl: typeof j.baseUrl === 'string' ? j.baseUrl : '',
    activeStepId: j.activeStepId || (steps[0] ? steps[0].id : ''),
    steps,
  };
}

// An Atlas "page" is a durable knowledge document: a discussion that settled into
// prose, with its own diagrams and a comment thread. Pages form a tree via parentId
// (''  = root) and may be linked to many stories (tickets).
function normalizePageComment(c) {
  c = c && typeof c === 'object' ? c : {};
  return {
    role: ['lead', 'ai', 'agent'].includes(c.role) ? c.role : 'agent',
    text: c && c.text != null ? String(c.text) : '',
    ts: c.ts || '',
  };
}
function normalizePage(pg, i) {
  pg = pg && typeof pg === 'object' ? pg : {};
  return {
    id: pg.id || `PG-${String(i + 1).padStart(3, '0')}`,
    title: pg.title || `Untitled page ${i + 1}`,
    parentId: typeof pg.parentId === 'string' ? pg.parentId : '',
    body: typeof pg.body === 'string' ? pg.body : '',
    tags: Array.isArray(pg.tags) ? pg.tags.map(String) : [],
    storyIds: Array.isArray(pg.storyIds) ? pg.storyIds.map(String) : [],
    diagrams: (Array.isArray(pg.diagrams) ? pg.diagrams : []).map(normalizeDiagram),
    comments: (Array.isArray(pg.comments) ? pg.comments : []).map(normalizePageComment),
    created: pg.created || '',
    updated: pg.updated || '',
  };
}

// A Lab "note" is a RAW capture — an idea, an anti-pattern, an observation, a gotcha.
// Notes are explicitly unvetted: they are not decisions, constraints or direction until
// a human triages them. Status moves raw -> triaged -> promoted | discarded.
const NOTE_KINDS = ['idea', 'anti-pattern', 'observation', 'gotcha'];
const NOTE_STATUSES = ['raw', 'triaged', 'promoted', 'discarded'];
function normalizeNote(n, i) {
  n = n && typeof n === 'object' ? n : {};
  return {
    id: n.id || `LAB-${String(i + 1).padStart(3, '0')}`,
    kind: NOTE_KINDS.includes(n.kind) ? n.kind : 'idea',
    text: n && n.text != null ? String(n.text) : '',
    source: typeof n.source === 'string' ? n.source : '',
    tags: Array.isArray(n.tags) ? n.tags.map(String) : [],
    status: NOTE_STATUSES.includes(n.status) ? n.status : 'raw',
    // Where a promoted note ended up: an ADR / ticket / question / page id.
    promotedTo: typeof n.promotedTo === 'string' ? n.promotedTo : '',
    // Triage rationale — especially why something was discarded.
    reason: typeof n.reason === 'string' ? n.reason : '',
    created: n.created || '',
    updated: n.updated || '',
  };
}

/** Drop unresolvable parent links and break cycles, so tree walks can never loop. */
function repairPageTree(pages) {
  const ids = new Set(pages.map(pg => pg.id));
  pages.forEach(pg => {
    if (pg.parentId && !ids.has(pg.parentId)) pg.parentId = '';
  });
  pages.forEach(pg => {
    const seen = new Set([pg.id]);
    let cur = pg.parentId;
    while (cur) {
      if (seen.has(cur)) {
        pg.parentId = '';
        break;
      }
      seen.add(cur);
      cur = (pages.find(x => x.id === cur) || {}).parentId || '';
    }
  });
  return pages;
}

// A "problem statement" is a project-level framing document (refined problem +
// solution + top design concerns) with its own discussion thread. It lives in its
// own nav section, deliberately outside the Atlas page tree.
function normalizeProblem(ps) {
  ps = ps && typeof ps === 'object' ? ps : {};
  return {
    body: typeof ps.body === 'string' ? ps.body : '',
    updated: ps.updated || '',
    comments: (Array.isArray(ps.comments) ? ps.comments : []).map(c => ({
      role: c && ['lead', 'reviewer', 'agent'].includes(c.role) ? c.role : 'agent',
      text: c && c.text != null ? String(c.text) : '',
      ts: (c && c.ts) || '',
    })),
  };
}

function normalizeWorkspace(ws) {
  ws = ws && typeof ws === 'object' ? ws : emptyWorkspace();
  if (!Array.isArray(ws.projects)) ws.projects = [];
  ws.version = SCHEMA_VERSION;
  ws.prompts = (Array.isArray(ws.prompts) ? ws.prompts : [])
    .filter(pr => pr && (pr.text || pr.name))
    .map((pr, i) => ({
      id: pr.id || `PR-${String(i + 1).padStart(3, '0')}`,
      name: pr.name || `Prompt ${i + 1}`,
      text: typeof pr.text === 'string' ? pr.text : '',
      model: pr.model || '',
      notes: pr.notes || '',
      uses: Number.isFinite(pr.uses) ? pr.uses : 0,
      outTokens: Number.isFinite(pr.outTokens) ? pr.outTokens : 0,
      updated: pr.updated || '',
    }));
  ws.projects.forEach(p => {
    p.tickets = Array.isArray(p.tickets) ? p.tickets : [];
    p.tickets.forEach(t => {
      t.acceptanceCriteria = Array.isArray(t.acceptanceCriteria) ? t.acceptanceCriteria : [];
      t.sessions = Array.isArray(t.sessions) ? t.sessions : [];
      t.deps = Array.isArray(t.deps) ? t.deps : [];
      if (typeof t.scratchpad !== 'string') t.scratchpad = '';
      if (!t.status) t.status = 'todo';
    });
    p.decisions = (Array.isArray(p.decisions) ? p.decisions : []).map(normalizeDecision);
    p.milestones = Array.isArray(p.milestones) ? p.milestones : [];
    p.questions = Array.isArray(p.questions) ? p.questions : [];
    p.chat = Array.isArray(p.chat) ? p.chat : [];
    p.activity = Array.isArray(p.activity) ? p.activity.filter(e => e && e.ts && e.text) : [];
    p.constraints = (Array.isArray(p.constraints) ? p.constraints : [])
      .filter(c => c && c.text)
      .map((c, i) => ({
        id: c.id || `CON-${String(i + 1).padStart(3, '0')}`,
        text: String(c.text),
        active: c.active !== false,
      }));
    if (!p.architecture || typeof p.architecture !== 'object') {
      p.architecture = { name: '', type: '', content: '', description: '' };
    }
    p.diagrams = (Array.isArray(p.diagrams) ? p.diagrams : []).map(normalizeDiagram);
    p.journeys = (Array.isArray(p.journeys) ? p.journeys : []).map(normalizeJourney);
    p.pages = repairPageTree((Array.isArray(p.pages) ? p.pages : []).map(normalizePage));
    p.notes = (Array.isArray(p.notes) ? p.notes : []).map(normalizeNote);
    p.problemStatement = normalizeProblem(p.problemStatement);
    // One-time migration: fold the legacy single architecture upload into the gallery.
    if (p.architecture.content && !p.architecture.migratedToDiagrams) {
      const legacyFormat =
        p.architecture.type === 'svg'
          ? 'svg'
          : String(p.architecture.type || '').startsWith('image/') ||
            String(p.architecture.content).startsWith('data:')
          ? 'image'
          : /mxfile|drawio/i.test(
              String(p.architecture.name) + String(p.architecture.content).slice(0, 200)
            )
          ? 'drawio'
          : 'text';
      p.diagrams.push(
        normalizeDiagram(
          {
            name: p.architecture.name || 'Architecture',
            kind: 'architecture',
            format: legacyFormat,
            type: p.architecture.type,
            content: p.architecture.content,
            description: p.architecture.description || '',
          },
          p.diagrams.length
        )
      );
      p.architecture.migratedToDiagrams = true;
    }
  });
  if (!ws.activeProjectId && ws.projects[0]) ws.activeProjectId = ws.projects[0].id;
  return ws;
}

/** Append to a project's activity feed (drives the Home timeline / catch-up brief). */
function logActivity(project, type, text, refId) {
  project.activity = Array.isArray(project.activity) ? project.activity : [];
  project.activity.push({ ts: new Date().toISOString(), type, text, refId: refId || '' });
  if (project.activity.length > 500) project.activity = project.activity.slice(-500);
}

function loadWorkspace(storePath) {
  const p = storePath || defaultStorePath();
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return normalizeWorkspace(JSON.parse(raw));
  } catch (err) {
    if (err.code === 'ENOENT') return normalizeWorkspace(emptyWorkspace());
    throw err;
  }
}

function saveWorkspace(storePath, ws) {
  const p = storePath || defaultStorePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(normalizeWorkspace(ws), null, 2), 'utf8');
  fs.renameSync(tmp, p); // atomic on POSIX
  return p;
}

/** Load → mutate(ws) → save, returning whatever mutate returns. */
function withStore(storePath, mutate) {
  const ws = loadWorkspace(storePath);
  const result = mutate(ws);
  saveWorkspace(storePath, ws);
  return result;
}

function getProject(ws, projectId) {
  return (ws.projects || []).find(p => p.id === projectId) || null;
}

function nextId(prefix, items) {
  // Collision-resistant: one past the highest existing numeric suffix for this
  // prefix (avoids the length-based duplication in the original renderer).
  let max = 0;
  (items || []).forEach(it => {
    const m = String(it && it.id).match(new RegExp('^' + prefix + '-(\\d+)$'));
    if (m) max = Math.max(max, Number(m[1]));
  });
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

// ---- Mutators (pure over ws) ----------------------------------------------

/** Agents may only PROPOSE. Status/choice are forced. (MCP_SERVER.md rule 1/2) */
function addDecision(ws, projectId, input, { forceProposed = false } = {}) {
  const project = getProject(ws, projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  const id = nextId('ADR', project.decisions);
  const decision = normalizeDecision({
    id,
    date: new Date().toISOString().slice(0, 10),
    title: input.title,
    context: input.context,
    reversibility: input.reversibility,
    options: input.options,
    choice: forceProposed ? '' : input.choice,
    rationale: forceProposed ? '' : input.rationale,
    status: forceProposed ? 'proposed' : input.status || 'proposed',
    source: input.source || (forceProposed ? 'agent' : ''),
  });
  project.decisions.push(decision);
  logActivity(project, 'decision', `${decision.id} proposed: ${decision.title}`, decision.id);
  return decision;
}

/** Append an argument/analysis comment to a decision's debate thread.
 *  Agents may argue; they may never set choice/status (same gate as addDecision). */
function addDecisionComment(ws, projectId, decisionId, input) {
  const project = getProject(ws, projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  const decision = project.decisions.find(d => d.id === decisionId);
  if (!decision) throw new Error(`Unknown decision: ${decisionId}`);
  const text = String((input && input.text) || '').trim();
  if (!text) throw new Error('Comment text is required');
  decision.discussion = Array.isArray(decision.discussion) ? decision.discussion : [];
  decision.discussion.push({
    role: input.role === 'lead' ? 'lead' : 'agent',
    text,
    ts: new Date().toISOString(),
  });
  logActivity(
    project,
    'debate',
    `${decision.id} debate: ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`,
    decision.id
  );
  return {
    decision_id: decision.id,
    status: decision.status,
    comments: decision.discussion.length,
  };
}

function addMilestone(ws, projectId, input) {
  const project = getProject(ws, projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  const id = nextId('MS', project.milestones);
  const status = input.status === 'done' ? 'done' : 'planned';
  const milestone = {
    id,
    title: input.title || 'Untitled milestone',
    description: input.description || '',
    status,
    date: input.date || (status === 'done' ? new Date().toISOString().slice(0, 10) : ''),
    sessionSummary: input.session_summary || input.sessionSummary || '',
    diffRef: input.diff || input.diffRef || null,
  };
  project.milestones.push(milestone);
  logActivity(
    project,
    'milestone',
    `${milestone.id} ${milestone.status === 'done' ? 'delivered' : 'planned'}: ${milestone.title}`,
    milestone.id
  );
  return milestone;
}

function addQuestion(ws, projectId, input) {
  const project = getProject(ws, projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  const id = nextId('Q', project.questions);
  const q = {
    id,
    lane: input.lane === 'agent' ? 'agent' : 'human',
    text: input.text || '',
    resolved: false,
  };
  project.questions.push(q);
  logActivity(project, 'question', `${q.id} opened: ${q.text.slice(0, 80)}`, q.id);
  return q;
}

function updateAcceptanceCriteria(ws, projectId, ticketId, input) {
  const project = getProject(ws, projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  const ticket = project.tickets.find(t => t.id === ticketId);
  if (!ticket) throw new Error(`Unknown ticket: ${ticketId}`);
  const completed = Array.isArray(input.completed_ac) ? input.completed_ac : [];
  completed.forEach(n => {
    const idx = Number(n) - 1; // 1-based, matches session-report parsing in app.js
    if (ticket.acceptanceCriteria[idx]) ticket.acceptanceCriteria[idx].done = true;
  });
  if (['todo', 'in_progress', 'done'].includes(input.status)) ticket.status = input.status;
  if (input.session && (input.session.summary || input.session.next_steps)) {
    ticket.sessions.push({
      date: new Date().toISOString().slice(0, 10),
      summary: input.session.summary || 'Session update',
      nextSteps: input.session.next_steps || input.session.nextSteps || '',
      raw: input.session.raw || '',
    });
  }
  const done = ticket.acceptanceCriteria.filter(a => a.done).length;
  logActivity(
    project,
    'session',
    `${ticket.id} session: ${done}/${ticket.acceptanceCriteria.length} AC, status ${ticket.status}`,
    ticket.id
  );
  return {
    ticket_id: ticket.id,
    done_ac: done,
    total_ac: ticket.acceptanceCriteria.length,
    status: ticket.status,
  };
}

// ---- Atlas: knowledge pages ------------------------------------------------

function getPage(ws, projectId, pageId) {
  const project = getProject(ws, projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  return (project.pages || []).find(pg => pg.id === pageId) || null;
}

/** True when candidateParent is the page itself or one of its descendants. */
function wouldCycle(pages, pageId, candidateParentId) {
  if (!candidateParentId) return false;
  if (candidateParentId === pageId) return true;
  let cur = candidateParentId;
  const seen = new Set();
  while (cur) {
    if (cur === pageId) return true;
    if (seen.has(cur)) return true;
    seen.add(cur);
    cur = (pages.find(p => p.id === cur) || {}).parentId || '';
  }
  return false;
}

/** Only keep story ids that actually exist, so links can't dangle. */
function knownStoryIds(project, ids) {
  return (Array.isArray(ids) ? ids : [])
    .map(String)
    .filter(id => project.tickets.some(t => t.id === id));
}

function addPage(ws, projectId, input) {
  const project = getProject(ws, projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  project.pages = Array.isArray(project.pages) ? project.pages : [];
  const parentId = input.parent_id || input.parentId || '';
  if (parentId && !project.pages.some(pg => pg.id === parentId)) {
    throw new Error(`Unknown parent page: ${parentId}`);
  }
  const now = new Date().toISOString();
  const page = normalizePage(
    {
      id: nextId('PG', project.pages),
      title: input.title,
      parentId,
      body: input.body || '',
      tags: input.tags,
      storyIds: knownStoryIds(project, input.story_ids || input.storyIds),
      created: now,
      updated: now,
    },
    project.pages.length
  );
  project.pages.push(page);
  logActivity(project, 'page', `${page.id} created: ${page.title}`, page.id);
  return page;
}

/** Partial update — only the fields present in input are touched. */
function updatePage(ws, projectId, pageId, input) {
  const project = getProject(ws, projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  const page = (project.pages || []).find(pg => pg.id === pageId);
  if (!page) throw new Error(`Unknown page: ${pageId}`);
  if (input.title != null) page.title = String(input.title);
  if (input.body != null) page.body = String(input.body);
  if (input.tags != null) page.tags = (Array.isArray(input.tags) ? input.tags : []).map(String);
  const newParent = input.parent_id != null ? input.parent_id : input.parentId;
  if (newParent != null) {
    const pid = String(newParent || '');
    if (pid && !project.pages.some(pg => pg.id === pid)) {
      throw new Error(`Unknown parent page: ${pid}`);
    }
    if (wouldCycle(project.pages, pageId, pid)) {
      throw new Error(`Cannot reparent ${pageId} under ${pid}: that would create a cycle`);
    }
    page.parentId = pid;
  }
  page.updated = new Date().toISOString();
  logActivity(project, 'page', `${page.id} updated: ${page.title}`, page.id);
  return page;
}

function addPageComment(ws, projectId, pageId, input) {
  const project = getProject(ws, projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  const page = (project.pages || []).find(pg => pg.id === pageId);
  if (!page) throw new Error(`Unknown page: ${pageId}`);
  const text = String((input && input.text) || '').trim();
  if (!text) throw new Error('Comment text is required');
  page.comments.push(
    normalizePageComment({
      role: input.role === 'lead' ? 'lead' : 'agent',
      text,
      ts: new Date().toISOString(),
    })
  );
  page.updated = new Date().toISOString();
  logActivity(
    project,
    'page',
    `${page.id} comment: ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`,
    page.id
  );
  return { page_id: page.id, comments: page.comments.length };
}

/** Diagrams are page-owned: they live on the page, not in the project gallery. */
function addPageDiagram(ws, projectId, pageId, input) {
  const project = getProject(ws, projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  const page = (project.pages || []).find(pg => pg.id === pageId);
  if (!page) throw new Error(`Unknown page: ${pageId}`);
  const diagram = normalizeDiagram(
    {
      id: nextId('DGM', page.diagrams),
      name: input.name,
      kind: input.kind,
      format: input.format,
      type: input.type,
      content: input.content,
      description: input.description,
      updated: new Date().toISOString(),
    },
    page.diagrams.length
  );
  page.diagrams.push(diagram);
  page.updated = new Date().toISOString();
  logActivity(project, 'page', `${page.id} diagram added: ${diagram.name}`, page.id);
  return diagram;
}

/** mode: 'add' (default) | 'set' | 'remove'. A story may link to many pages. */
function linkPageStories(ws, projectId, pageId, storyIds, mode = 'add') {
  const project = getProject(ws, projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  const page = (project.pages || []).find(pg => pg.id === pageId);
  if (!page) throw new Error(`Unknown page: ${pageId}`);
  const ids = knownStoryIds(project, storyIds);
  if (mode === 'set') page.storyIds = ids;
  else if (mode === 'remove') page.storyIds = page.storyIds.filter(id => !ids.includes(id));
  else page.storyIds = Array.from(new Set([...page.storyIds, ...ids]));
  page.updated = new Date().toISOString();
  logActivity(
    project,
    'page',
    `${page.id} linked to ${page.storyIds.join(', ') || 'nothing'}`,
    page.id
  );
  return { page_id: page.id, story_ids: page.storyIds };
}

function pagesForStory(ws, projectId, storyId) {
  const project = getProject(ws, projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  return (project.pages || [])
    .filter(pg => pg.storyIds.includes(storyId))
    .map(pg => ({ id: pg.id, title: pg.title }));
}

/** Flat list with depth + path, convenient for both the UI tree and agent listings. */
function pageOutline(project) {
  const pages = Array.isArray(project.pages) ? project.pages : [];
  const out = [];
  const walk = (parentId, depth, trail) => {
    pages
      .filter(pg => (pg.parentId || '') === parentId)
      .forEach(pg => {
        const path = [...trail, pg.title];
        out.push({
          id: pg.id,
          title: pg.title,
          parentId: pg.parentId || '',
          depth,
          path: path.join(' / '),
          tags: pg.tags,
          storyIds: pg.storyIds,
          diagrams: pg.diagrams.length,
          comments: pg.comments.length,
          updated: pg.updated,
        });
        walk(pg.id, depth + 1, path);
      });
  };
  walk('', 0, []);
  return out;
}

// ---- Lab: raw notes --------------------------------------------------------

/**
 * The wording an agent sees alongside raw notes. Deliberately blunt: unvetted
 * captures must never be mistaken for direction.
 */
const LAB_DISCLAIMER =
  "UNVETTED RAW NOTES. These are the Tech Lead's unprocessed thoughts — ideas, " +
  'suspected anti-patterns, observations. They are NOT decisions, constraints, ' +
  'requirements or direction, and several may be wrong or contradictory. Do NOT act ' +
  'on them, cite them as settled, or let them override a decision or constraint. Use ' +
  'them only for awareness; if one looks relevant, raise it for triage.';

function addNote(ws, projectId, input) {
  const project = getProject(ws, projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  project.notes = Array.isArray(project.notes) ? project.notes : [];
  const text = String((input && input.text) || '').trim();
  if (!text) throw new Error('Note text is required');
  const now = new Date().toISOString();
  const note = normalizeNote(
    {
      id: nextId('LAB', project.notes),
      kind: input.kind,
      text,
      source: input.source,
      tags: input.tags,
      status: 'raw',
      created: now,
      updated: now,
    },
    project.notes.length
  );
  project.notes.push(note);
  logActivity(project, 'note', `${note.id} captured (${note.kind}): ${text.slice(0, 70)}`, note.id);
  return note;
}

/** Partial edit of a raw note's content. Status changes go through triageNote. */
function updateNote(ws, projectId, noteId, input) {
  const project = getProject(ws, projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  const note = (project.notes || []).find(n => n.id === noteId);
  if (!note) throw new Error(`Unknown note: ${noteId}`);
  if (input.text != null) note.text = String(input.text);
  if (input.kind != null) {
    if (!NOTE_KINDS.includes(input.kind)) throw new Error(`Unknown note kind: ${input.kind}`);
    note.kind = input.kind;
  }
  if (input.source != null) note.source = String(input.source);
  if (input.tags != null) note.tags = (Array.isArray(input.tags) ? input.tags : []).map(String);
  note.updated = new Date().toISOString();
  return note;
}

/**
 * Move a note out of the raw pile. Promoting records where it went (an ADR /
 * ticket / question / page id) so the trail from thought to artifact survives;
 * discarding records why, so it is not re-raised later.
 */
function triageNote(ws, projectId, noteId, input) {
  const project = getProject(ws, projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  const note = (project.notes || []).find(n => n.id === noteId);
  if (!note) throw new Error(`Unknown note: ${noteId}`);
  const status = input && input.status;
  if (!NOTE_STATUSES.includes(status)) throw new Error(`Unknown note status: ${status}`);
  if (
    status === 'promoted' &&
    !String((input && input.promoted_to) || input.promotedTo || '').trim()
  ) {
    throw new Error('Promoting a note requires promoted_to (the id it became)');
  }
  if (status === 'discarded' && !String((input && input.reason) || '').trim()) {
    throw new Error('Discarding a note requires a reason');
  }
  note.status = status;
  if (input.promoted_to != null || input.promotedTo != null) {
    note.promotedTo = String(input.promoted_to != null ? input.promoted_to : input.promotedTo);
  }
  if (input.reason != null) note.reason = String(input.reason);
  note.updated = new Date().toISOString();
  logActivity(
    project,
    'note',
    `${note.id} ${status}${note.promotedTo ? ` → ${note.promotedTo}` : ''}`,
    note.id
  );
  return note;
}

function noteCounts(project) {
  const notes = Array.isArray(project.notes) ? project.notes : [];
  return NOTE_STATUSES.reduce(
    (acc, s) => ({ ...acc, [s]: notes.filter(n => n.status === s).length }),
    { total: notes.length }
  );
}

/** One-call grounding for agents: everything a session needs to stay aligned. */
function buildBriefing(ws, projectId) {
  const project = getProject(ws, projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  const nextTicket = project.tickets.find(
    t =>
      t.status !== 'done' &&
      (t.deps || []).every(id => project.tickets.find(x => x.id === id)?.status === 'done')
  );
  return {
    project: { id: project.id, name: project.name, description: project.description || '' },
    rules:
      "Treat decided items as settled — do not re-litigate them. Never set a decision's status or choice; propose via capture_decision and argue via discuss_decision. Respect every standing constraint.",
    constraints: (project.constraints || []).filter(c => c.active).map(c => c.text),
    decisions: {
      decided: project.decisions
        .filter(d => d.status === 'decided')
        .map(d => ({
          id: d.id,
          title: d.title,
          choice: d.choice,
          rationale: d.rationale,
          reversibility: d.reversibility,
        })),
      proposed: project.decisions
        .filter(d => d.status === 'proposed')
        .map(d => ({
          id: d.id,
          title: d.title,
          options: (d.options || []).map(o => o.name).filter(Boolean),
        })),
    },
    open_questions: (project.questions || [])
      .filter(q => !q.resolved)
      .map(q => ({ id: q.id, lane: q.lane, text: q.text })),
    milestones: (project.milestones || []).map(m => ({
      id: m.id,
      title: m.title,
      status: m.status,
      date: m.date || '',
    })),
    next_ticket: nextTicket
      ? {
          id: nextTicket.id,
          title: nextTicket.title,
          status: nextTicket.status,
          description: nextTicket.description || '',
          acceptance_criteria: (nextTicket.acceptanceCriteria || []).map((a, i) => ({
            n: i + 1,
            text: a.text,
            done: !!a.done,
          })),
          definition_of_done: nextTicket.definitionOfDone || '',
          technical_notes: nextTicket.technicalNotes || '',
        }
      : null,
    atlas_pages: pageOutline(project).map(pg => ({
      id: pg.id,
      path: pg.path,
      story_ids: pg.storyIds,
    })),
    lab_notes: {
      disclaimer: LAB_DISCLAIMER,
      counts: noteCounts(project),
      raw: (project.notes || [])
        .filter(n => n.status === 'raw')
        .map(n => ({ id: n.id, kind: n.kind, text: n.text, source: n.source })),
    },
    recent_activity: (project.activity || []).slice(-10),
  };
}

module.exports = {
  SCHEMA_VERSION,
  defaultStorePath,
  emptyWorkspace,
  normalizeDecision,
  normalizeWorkspace,
  loadWorkspace,
  saveWorkspace,
  withStore,
  getProject,
  logActivity,
  addDecision,
  addDecisionComment,
  addMilestone,
  addQuestion,
  updateAcceptanceCriteria,
  buildBriefing,
  // Atlas
  normalizePage,
  repairPageTree,
  getPage,
  addPage,
  updatePage,
  addPageComment,
  addPageDiagram,
  linkPageStories,
  pagesForStory,
  pageOutline,
  // Lab
  NOTE_KINDS,
  NOTE_STATUSES,
  LAB_DISCLAIMER,
  normalizeNote,
  addNote,
  updateNote,
  triageNote,
  noteCounts,
};
