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
};
