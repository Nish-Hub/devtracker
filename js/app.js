import { DEFAULT_WORKSPACE, STORAGE_KEY, effortXP } from './data.js';
import { orchestrate } from './orchestrator/orchestrator.js';

const AI_SETTINGS_KEY = 'devtracker:ai-settings:v1';
// Providers carry OrchestratorLLM routing metadata (tier/location/sensitivityOK/costPer1k)
// so the smart router can reason about them. Local = free, on-device, privacy-safe.
const DEFAULT_AI_SETTINGS = {
  activeProviderId: 'local',
  smartRouting: false,
  privacyPolicy: 'hard',
  providers: [
    {
      id: 'local',
      name: 'Local draft',
      type: 'local',
      endpoint: '',
      model: '',
      apiKey: '',
      tier: 'cheap',
      location: 'local',
      sensitivityOK: true,
      costPer1k: 0,
    },
    {
      id: 'grok',
      name: 'Grok / xAI',
      type: 'openai-compatible',
      endpoint: 'https://api.x.ai/v1/chat/completions',
      model: 'grok-4',
      apiKey: '',
      tier: 'strong',
      location: 'hosted',
      sensitivityOK: false,
      costPer1k: 0.5,
    },
  ],
};
const PROVIDER_CAP_DEFAULTS = {
  tier: 'mid',
  location: 'hosted',
  sensitivityOK: false,
  costPer1k: 1,
};
const clone = v => JSON.parse(JSON.stringify(v));
// Declared before the top-level load() call — normalizeDiagram runs during it.
const DIAGRAM_KINDS = {
  architecture: 'Architecture',
  dataflow: 'Data flow',
  sequence: 'Sequence',
  erd: 'ER diagram',
  other: 'Other',
};
let workspace = load();
let aiSettings = loadAiSettings();
const $ = s => document.querySelector(s);
const esc = s =>
  String(s || '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
// Uploaded SVG is untrusted (and, with the MCP server, an agent can supply it).
// Strip scripts, foreignObject, on* handlers, and javascript: hrefs before it
// ever reaches innerHTML in the Electron renderer.
function sanitizeSvg(svg) {
  try {
    const doc = new DOMParser().parseFromString(String(svg || ''), 'image/svg+xml');
    if (doc.querySelector('parsererror')) return '';
    doc.querySelectorAll('script, foreignObject').forEach(n => n.remove());
    doc.querySelectorAll('*').forEach(el => {
      [...el.attributes].forEach(attr => {
        const name = attr.name.toLowerCase();
        const val = String(attr.value || '')
          .trim()
          .toLowerCase();
        if (name.startsWith('on')) el.removeAttribute(attr.name);
        else if ((name === 'href' || name === 'xlink:href') && val.startsWith('javascript:'))
          el.removeAttribute(attr.name);
      });
    });
    const root = doc.documentElement;
    return root && root.nodeName.toLowerCase() === 'svg' ? root.outerHTML : '';
  } catch (_) {
    return '';
  }
}
const projectById = id => workspace.projects?.find(p => p.id === id);
const activeProject = () =>
  projectById(workspace.activeProjectId) || workspace.projects?.[0] || null;
const ticketById = id => activeProject()?.tickets.find(t => t.id === id);
const openQuestions = () => activeProject()?.questions.filter(q => !q.resolved) || [];
let projectContextCache = null;
let gitHistoryCache = null;
const GIT_SETTINGS_KEY = 'devtracker:git-settings:v1';
let gitSettings = loadGitSettings();
const AGENT_MARKERS = [
  /claude/i,
  /chatgpt/i,
  /\bgpt-?\d?\b/i,
  /copilot/i,
  /cursor/i,
  /gemini/i,
  /codex/i,
  /\[bot\]/i,
  /devtracker agent/i,
  /co-authored-by:/i,
];

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return normalizeWorkspace(migrateWorkspace(saved?.version === 3 ? saved : null));
  } catch {
    return normalizeWorkspace(clone(DEFAULT_WORKSPACE));
  }
}
function normalizeDiagram(g, i) {
  g = g && typeof g === 'object' ? g : {};
  return {
    id: g.id || `DGM-${String(i + 1).padStart(3, '0')}`,
    name: g.name || `Diagram ${i + 1}`,
    kind: Object.keys(DIAGRAM_KINDS).includes(g.kind) ? g.kind : 'architecture',
    format: ['svg', 'image', 'drawio', 'excalidraw', 'text'].includes(g.format) ? g.format : 'text',
    type: g.type || '',
    content: typeof g.content === 'string' ? g.content : '',
    description: typeof g.description === 'string' ? g.description : '',
    updated: g.updated || '',
  };
}
function normalizeWorkspace(ws) {
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
  (ws.projects || []).forEach(p => {
    p.decisions = (p.decisions || []).map(normalizeDecision);
    p.milestones = p.milestones || [];
    p.chat = p.chat || [];
    p.activity = Array.isArray(p.activity) ? p.activity.filter(e => e && e.ts && e.text) : [];
    p.constraints = (Array.isArray(p.constraints) ? p.constraints : [])
      .filter(c => c && c.text)
      .map((c, i) => ({
        id: c.id || `CON-${String(i + 1).padStart(3, '0')}`,
        text: String(c.text),
        active: c.active !== false,
      }));
    p.diagrams = (Array.isArray(p.diagrams) ? p.diagrams : []).map(normalizeDiagram);
    if (p.architecture?.content && !p.architecture.migratedToDiagrams) {
      const fmt =
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
            format: fmt,
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
  return ws;
}
function logActivity(project, type, text, refId) {
  project.activity = Array.isArray(project.activity) ? project.activity : [];
  project.activity.push({ ts: new Date().toISOString(), type, text, refId: refId || '' });
  if (project.activity.length > 500) project.activity = project.activity.slice(-500);
}
const LAST_VISIT_KEY = 'devtracker:lastvisit:v1';
const LAST_VISIT = localStorage.getItem(LAST_VISIT_KEY) || '';
localStorage.setItem(LAST_VISIT_KEY, new Date().toISOString());
const estTokens = t => Math.ceil(String(t || '').length / 4);
function normalizeDecision(d) {
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
    choice: d.choice || (d.status === 'decided' || !d.options ? d.decision || '' : ''),
    rationale: d.rationale || '',
    status: d.status || (d.choice || d.decision ? 'decided' : 'proposed'),
    source: d.source || '',
    discussion: Array.isArray(d.discussion)
      ? d.discussion.map(m => ({
          role: ['lead', 'ai', 'agent'].includes(m?.role) ? m.role : 'agent',
          text: m?.text != null ? String(m.text) : '',
          ts: m?.ts || '',
          ...(Array.isArray(m?.updates) ? { updates: m.updates } : {}),
        }))
      : [],
    review:
      d.review && typeof d.review === 'object'
        ? { date: d.review.date || '', model: d.review.model || '', text: d.review.text || '' }
        : null,
  };
}
function migrateWorkspace(saved) {
  if (!saved) return clone(DEFAULT_WORKSPACE);
  if (Array.isArray(saved.projects)) {
    return {
      ...clone(DEFAULT_WORKSPACE),
      ...saved,
      projects: saved.projects,
      activeProjectId:
        saved.activeProjectId || saved.projects[0]?.id || DEFAULT_WORKSPACE.activeProjectId,
    };
  }
  const id = saved.project?.code || 'default';
  return {
    version: 3,
    activeProjectId: id,
    projects: [
      {
        id,
        name: saved.project?.name || 'Default project',
        code: saved.project?.code || id,
        description: saved.project?.description || '',
        tickets: saved.tickets || [],
        decisions: saved.decisions || [],
        questions: saved.questions || [],
        selectedTicketId: saved.selectedTicketId || saved.tickets?.[0]?.id || '',
      },
    ],
  };
}
function loadAiSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY));
    return saved?.providers
      ? { ...clone(DEFAULT_AI_SETTINGS), ...saved, providers: mergeProviders(saved.providers) }
      : clone(DEFAULT_AI_SETTINGS);
  } catch {
    return clone(DEFAULT_AI_SETTINGS);
  }
}
function mergeProviders(saved) {
  const defaults = clone(DEFAULT_AI_SETTINGS.providers),
    custom = saved.filter(p => !defaults.some(d => d.id === p.id));
  return defaults.map(d => ({ ...d, ...(saved.find(p => p.id === d.id) || {}) })).concat(custom);
}
function loadGitSettings() {
  try {
    return JSON.parse(localStorage.getItem(GIT_SETTINGS_KEY)) || {};
  } catch {
    return {};
  }
}
function saveGitSettings() {
  localStorage.setItem(GIT_SETTINGS_KEY, JSON.stringify(gitSettings));
}
function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));
  if (window.desktopApi?.store?.save) {
    window.desktopApi.store.save(workspace).catch(() => {});
    $('#saveIndicator').textContent = '● Saved to workspace file';
  } else {
    $('#saveIndicator').textContent = '● Saved locally';
  }
}
// Desktop mode: the on-disk workspace file is the source of truth shared with the
// MCP server. Pull it on launch and whenever an external process (an agent via
// MCP) mutates it, so agent-captured decisions/milestones appear live.
async function hydrateFromStore() {
  if (!window.desktopApi?.store?.get) return;
  try {
    const fileWs = await window.desktopApi.store.get();
    if (fileWs && !fileWs.error && Array.isArray(fileWs.projects) && fileWs.projects.length) {
      workspace = normalizeWorkspace(migrateWorkspace(fileWs));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));
      renderAll();
    } else if (window.desktopApi.store.save) {
      await window.desktopApi.store.save(workspace); // seed an empty/first-run file
    }
  } catch (_) {
    /* stay on localStorage */
  }
}
function saveAiSettings() {
  localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(aiSettings));
}
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2400);
}
function depsDone(ticket) {
  return ticket.deps.every(id => ticketById(id)?.status === 'done');
}
function acProgress(t) {
  return [t.acceptanceCriteria.filter(a => a.done).length, t.acceptanceCriteria.length];
}
function statusText(s) {
  return { todo: 'Not started', in_progress: 'In progress', done: 'Done' }[s];
}

function renderProjectSelector() {
  const project = activeProject();
  const title = $('#projectName');
  if (title) title.textContent = project?.name || 'Untitled project';
  const select = $('#projectSelect');
  if (!select) return;
  select.innerHTML = workspace.projects
    .map(
      p =>
        `<option value="${esc(p.id)}"${p.id === project?.id ? ' selected' : ''}>${esc(
          p.name
        )}</option>`
    )
    .join('');
  select.onchange = e => switchProject(e.target.value);
}

function switchProject(id) {
  const project = projectById(id);
  if (!project) return;
  workspace.activeProjectId = id;
  if (!project.selectedTicketId && project.tickets.length)
    project.selectedTicketId = project.tickets[0].id;
  save();
  renderAll();
}

function addProject() {
  const name = prompt('Enter a new project name', `Project ${workspace.projects.length + 1}`);
  if (!name || !name.trim()) return;
  const code = prompt(
    'Enter a unique project code',
    name.replace(/\s+/g, '-').toUpperCase().slice(0, 8)
  );
  if (!code || !code.trim()) return;
  const id = code.trim();
  if (projectById(id)) {
    toast('A project with that code already exists.');
    return;
  }
  const project = {
    id,
    name: name.trim(),
    code: id,
    description: '',
    tickets: [],
    decisions: [],
    questions: [],
    selectedTicketId: '',
  };
  workspace.projects.push(project);
  workspace.activeProjectId = id;
  save();
  renderAll();
}

function renderAll() {
  renderProjectSelector();
  renderCounts();
  renderHome();
  renderMap();
  renderNextUp();
  renderTicket();
  renderContext();
  renderArchitecture();
  renderGit();
  renderMilestones();
  renderDecisions();
  renderQuestions();
  renderChatSurfaces();
}
function renderCounts() {
  const project = activeProject();
  const done = project.tickets.filter(t => t.status === 'done').length;
  $('#doneProgress').textContent = `${done} / ${project.tickets.length}`;
  $('#progressBar').style.width = `${
    project.tickets.length ? (done / project.tickets.length) * 100 : 0
  }%`;
  $('#decisionCount').textContent = project.decisions.length;
  $('#questionCount').textContent = openQuestions().length;
  const ms = $('#milestoneCount');
  if (ms) ms.textContent = (project.milestones || []).filter(m => m.status !== 'done').length || '';
}
function renderNextUp() {
  const project = activeProject();
  const target = project.tickets.find(t => t.status !== 'done' && depsDone(t));
  const el = $('#nextUp');
  if (!target) {
    el.innerHTML =
      '<div class="next-card"><div><span class="next-kicker">PATH CLEAR</span><strong>Every ticket is complete.</strong></div></div>';
    return;
  }
  const [complete, total] = acProgress(target);
  el.innerHTML = `<div class="next-card"><div><span class="next-kicker">NEXT UNBLOCKED TICKET</span><strong>${esc(
    target.id
  )} · ${esc(
    target.title
  )} <small>(${complete}/${total} AC)</small></strong></div><button class="button primary" data-open="${esc(
    target.id
  )}">Open ticket</button></div>`;
  el.querySelector('button').onclick = () => select(target.id);
}

function levels() {
  const tickets = activeProject().tickets;
  const result = {},
    degree = {};
  tickets.forEach(t => (degree[t.id] = t.deps.length));
  const queue = tickets.filter(t => !degree[t.id]);
  queue.forEach(t => (result[t.id] = 0));
  while (queue.length) {
    const t = queue.shift();
    tickets
      .filter(x => x.deps.includes(t.id))
      .forEach(x => {
        result[x.id] = Math.max(result[x.id] || 0, result[t.id] + 1);
        if (--degree[x.id] === 0) queue.push(x);
      });
  }
  tickets.forEach(t => (result[t.id] ??= 0));
  return result;
}
function renderMap() {
  const svg = $('#graph'),
    level = levels(),
    cols = [];
  const tickets = activeProject().tickets;
  if (!tickets.length) {
    svg.innerHTML =
      '<text x="20" y="30" fill="#82908a">No tickets available for this project.</text>';
    svg.setAttribute('viewBox', '0 0 320 60');
    svg.setAttribute('width', 320);
    svg.setAttribute('height', 60);
    return;
  }
  tickets.forEach(t => (cols[level[t.id]] ||= []).push(t));
  const w = 190,
    h = 93,
    gapX = 235,
    gapY = 123,
    margin = 35,
    maxRows = Math.max(...cols.map(c => c.length));
  const fullW = margin * 2 + (cols.length - 1) * gapX + w,
    fullH = margin * 2 + (maxRows - 1) * gapY + h;
  svg.setAttribute('viewBox', `0 0 ${fullW} ${fullH}`);
  svg.setAttribute('width', fullW);
  svg.setAttribute('height', fullH);
  svg.innerHTML = '';
  const pos = {};
  cols.forEach((col, x) => {
    const start = (fullH - (col.length * h + (col.length - 1) * (gapY - h))) / 2;
    col.forEach((t, y) => (pos[t.id] = { x: margin + x * gapX, y: start + y * gapY }));
  });
  tickets.forEach(t =>
    t.deps.forEach(d => {
      const a = pos[d],
        b = pos[t.id];
      if (!a || !b) return;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const mid = (a.x + w + b.x) / 2;
      path.setAttribute(
        'd',
        `M ${a.x + w} ${a.y + h / 2} C ${mid} ${a.y + h / 2}, ${mid} ${b.y + h / 2}, ${b.x} ${
          b.y + h / 2
        }`
      );
      path.setAttribute('class', `edge ${ticketById(d).status === 'done' ? 'done' : ''}`);
      svg.append(path);
    })
  );
  tickets.forEach(t => {
    const p = pos[t.id],
      [done, total] = acProgress(t),
      g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute(
      'class',
      `node ${t.status} ${activeProject().selectedTicketId === t.id ? 'selected' : ''} ${
        t.status !== 'done' && depsDone(t) ? 'next' : ''
      }`
    );
    g.setAttribute('transform', `translate(${p.x},${p.y})`);
    const title = wrap(t.title, 24);
    g.innerHTML = `<rect width="${w}" height="${h}" rx="8"/><text class="node-code" x="13" y="19">${esc(
      t.id
    )}</text><text class="node-meta" x="${w - 13}" y="19" text-anchor="end">${t.effort} · ${
      effortXP[t.effort]
    }XP</text><text class="node-title" x="13" y="45">${esc(title[0])}</text>${
      title[1] ? `<text class="node-title" x="13" y="61">${esc(title[1])}</text>` : ''
    }<text class="node-status" x="13" y="80">${done}/${total} AC · ${
      t.status === 'done' ? '✓' : statusText(t.status)
    }</text>`;
    g.onclick = () => select(t.id);
    svg.append(g);
  });
}
function wrap(text, n) {
  const a = ['', ''];
  text.split(' ').forEach(word => {
    const i = (a[0] + ' ' + word).trim().length <= n ? 0 : 1;
    a[i] = (a[i] + ' ' + word).trim();
  });
  return a;
}
function select(id) {
  const project = activeProject();
  if (!project) return;
  project.selectedTicketId = id;
  save();
  renderMap();
  renderTicket();
}

function renderTicket() {
  const project = activeProject();
  const id = project?.selectedTicketId;
  const t = ticketById(id);
  $('#emptyTicket').hidden = !!t;
  $('#ticketDetails').hidden = !t;
  if (!t) return;
  const [done, total] = acProgress(t);
  const sessions = t.sessions.length
    ? t.sessions
        .slice()
        .reverse()
        .map(
          s =>
            `<article class="session"><time>${esc(s.date)}</time><strong>${esc(
              s.summary
            )}</strong><p>${esc(s.nextSteps || '')}</p></article>`
        )
        .join('')
    : '<p>No formal session reports yet.</p>';
  $('#ticketDetails').innerHTML = `<div class="ticket-head"><span class="ticket-code">${esc(
    t.id
  )} · ${t.effort} · ${effortXP[t.effort]} XP</span><h2>${esc(
    t.title
  )}</h2><span class="status-pill ${t.status}">${statusText(
    t.status
  )}</span></div><div class="ticket-actions"><button class="button primary" data-action="brief">Copy session brief</button><button class="button" data-action="report">Paste session report</button><button class="button" data-action="status">Advance status</button><button class="button" data-action="edit">Edit ticket</button></div><section class="detail-section"><h3>OVERVIEW</h3><p>${esc(
    t.description
  )}</p></section><section class="detail-section"><h3>ACCEPTANCE CRITERIA · ${done}/${total}</h3><ul>${t.acceptanceCriteria
    .map(
      (a, i) =>
        `<li><input data-ac="${i}" type="checkbox" ${a.done ? 'checked' : ''}><span>${esc(
          a.text
        )}</span></li>`
    )
    .join('')}</ul></section><section class="detail-section"><h3>DEFINITION OF DONE</h3><p>${esc(
    t.definitionOfDone
  )}</p></section><section class="detail-section"><h3>TECHNICAL NOTES</h3><p>${esc(
    t.technicalNotes
  )}</p></section><section class="detail-section"><h3>DEPENDENCIES</h3><div class="dep-list">${
    t.deps.length
      ? t.deps
          .map(
            d =>
              `<span class="chip">${esc(d)} ${ticketById(d)?.status === 'done' ? '✓' : ''}</span>`
          )
          .join('')
      : '<span class="chip">No prerequisites</span>'
  }</div></section><section class="detail-section"><h3>SCRATCHPAD</h3><textarea id="scratchpad" placeholder="Loose thoughts, links, and reminders…">${esc(
    t.scratchpad
  )}</textarea></section><section class="detail-section"><h3>SESSION HISTORY</h3>${sessions}</section>`;
  $('#ticketDetails')
    .querySelectorAll('[data-ac]')
    .forEach(
      input =>
        (input.onchange = () => {
          t.acceptanceCriteria[input.dataset.ac].done = input.checked;
          save();
          renderAll();
        })
    );
  $('#scratchpad').oninput = e => {
    t.scratchpad = e.target.value;
    save();
  };
  $('#ticketDetails').querySelector('[data-action="brief"]').onclick = () => copyBrief(t);
  $('#ticketDetails').querySelector('[data-action="report"]').onclick = () => openReport(t);
  $('#ticketDetails').querySelector('[data-action="status"]').onclick = () => {
    t.status = { todo: 'in_progress', in_progress: 'done', done: 'todo' }[t.status];
    save();
    renderAll();
  };
  $('#ticketDetails').querySelector('[data-action="edit"]').onclick = () => openTicketForm(t);
}

function brief(t) {
  const deps = t.deps.length
    ? t.deps
        .map(id => `- ${id}: ${ticketById(id).status === 'done' ? '✅ done' : 'not complete'}`)
        .join('\n')
    : '- None — this ticket is ready to start.';
  const constraints = (activeProject().constraints || [])
    .filter(c => c.active)
    .map(c => `- ${c.text}`)
    .join('\n');
  const decisions = activeProject().decisions.map(formatDecisionForBrief).join('\n') || '- None';
  const milestones =
    (activeProject().milestones || [])
      .map(
        m =>
          `- [${m.status === 'done' ? 'x' : ' '}] ${m.id} ${m.title}${m.date ? ` (${m.date})` : ''}`
      )
      .join('\n') || '- None';
  const questions =
    openQuestions()
      .map(q => `- [${q.lane}] ${q.text}`)
      .join('\n') || '- None';
  const last = t.sessions.at(-1);
  return `# DevTracker Session Brief\n\n## Ticket: ${t.id} — ${t.title}\nStatus: ${statusText(
    t.status
  )}\n${
    constraints ? `\n### Standing constraints — non-negotiable\n${constraints}\n` : ''
  }\n### Goal\n${
    t.description
  }\n\n### Dependencies\n${deps}\n\n### Acceptance criteria\n${t.acceptanceCriteria
    .map(a => `- [${a.done ? 'x' : ' '}] ${a.text}`)
    .join('\n')}\n\n### Definition of done\n${t.definitionOfDone}\n\n### Technical notes\n${
    t.technicalNotes
  }\n\n### Milestones\n${milestones}\n\n### Project decisions\nTreat 'decided' items as settled — do not re-litigate them, but flag if new evidence contradicts one. For any item marked 'NEEDS TECH LEAD DECISION', lay out tradeoffs; do not decide it yourself.\n${decisions}\n\n### Open questions\n${questions}\n${
    last ? `\n### Last session\n${last.summary}\nNext: ${last.nextSteps}\n` : ''
  }\n## End this session with this exact format\n\`\`\`session-report\nTicket: ${
    t.id
  }\nSummary: <what changed>\nCompleted AC: <comma-separated AC numbers, e.g. 1, 3>\nDecisions: <decision and rationale, or None>\nOpen Questions: <question, or None>\nNext Steps: <what should happen next>\nStatus: <todo | in_progress | done>\n\`\`\``;
}
async function copyBrief(t) {
  try {
    await navigator.clipboard.writeText(brief(t));
    toast('Session brief copied — paste it into your AI chat.');
  } catch {
    toast('Clipboard unavailable; copy from the dialog instead.');
    openTextDialog('Session brief', brief(t));
  }
}
function openTextDialog(title, text) {
  const d = $('#reportDialog');
  d.innerHTML = `<form method="dialog" class="dialog-body"><h2>${esc(
    title
  )}</h2><textarea class="report-format" style="min-height:340px">${esc(
    text
  )}</textarea><div class="dialog-actions"><button class="button primary">Close</button></div></form>`;
  d.showModal();
}

function openReport(t) {
  const d = $('#reportDialog');
  d.innerHTML = `<form class="dialog-body" id="reportForm"><h2>Paste Session Report</h2><p class="subcopy">Use the format from the session brief. Completed AC numbers and status are applied automatically.</p><div class="field"><label>Session report</label><textarea id="reportText" placeholder="Ticket: ${t.id}\nSummary: …\nCompleted AC: 1, 3\nDecisions: None\nOpen Questions: None\nNext Steps: …\nStatus: in_progress" required></textarea></div><div class="dialog-actions"><button class="button" type="button" data-close>Cancel</button><button class="button primary" id="applyReportBtn">Apply report</button></div></form>`;
  d.querySelector('[data-close]').onclick = () => d.close();
  d.querySelector('form').onsubmit = async e => {
    e.preventDefault();
    const text = $('#reportText').value;
    const applyBtn = $('#applyReportBtn');
    const origText = applyBtn.textContent;
    applyBtn.disabled = true;
    applyBtn.textContent = 'Checking conflicts...';
    try {
      const conflict = await checkReportForConflicts(text);
      if (conflict) {
        const proceed = confirm(
          `⚠️ Architectural Divergence Detected!\n\n${conflict}\n\nDo you want to apply this session report anyway?`
        );
        if (!proceed) {
          applyBtn.disabled = false;
          applyBtn.textContent = origText;
          return;
        }
      }
    } catch (err) {
      console.error(err);
    }
    applyReport(t, text);
    d.close();
  };
  d.showModal();
}
function field(text, key) {
  return (text.match(new RegExp(`^${key}:\\s*(.*)$`, 'im')) || [])[1]?.trim() || '';
}

function compileDecisionToMarkdown(d) {
  const reversibilityLabel =
    d.reversibility === 'one-way'
      ? 'One-way door (hard to undo)'
      : d.reversibility === 'two-way'
      ? 'Two-way door (reversible)'
      : 'Unspecified';
  const optionsList = d.options
    .map(o => {
      const chosen = d.choice && o.name === d.choice;
      return `* **Option: ${o.name}**${chosen ? ' (Chosen)' : ''}
  * Pros:
${(o.pros || []).map(p => `    - ${p}`).join('\n') || '    - None'}
  * Cons:
${(o.cons || []).map(c => `    - ${c}`).join('\n') || '    - None'}`;
    })
    .join('\n\n');

  return `# ${d.id}: ${d.title}

* **Status:** ${d.status.toUpperCase()}
* **Date:** ${d.date}
* **Reversibility:** ${reversibilityLabel}

## Context
${d.context || 'No context documented.'}

## Options Considered
${optionsList || 'No options documented.'}

## Decision Outcome & Rationale
**Chosen Option:** ${d.choice || 'Undecided'}

### Rationale
${d.rationale || 'No rationale documented.'}
`;
}

async function checkReportForConflicts(reportText) {
  const project = activeProject();
  if (!project) return null;
  const decidedAdrs = project.decisions.filter(d => d.status === 'decided');
  if (!decidedAdrs.length) return null;

  const provider = activeProvider();
  if (provider.type === 'local' || !provider.apiKey || !provider.endpoint) {
    return null;
  }

  const adrSummaries = decidedAdrs
    .map(
      d =>
        `ADR: ${d.id} - ${d.title}\nChosen option: ${d.choice}\nRationale: ${d.rationale}\nContext: ${d.context}`
    )
    .join('\n\n');

  const prompt = `You are an architectural conformance linter. Compare the following Session Report with our Decided Architectural Decisions (ADRs).
Determine if the Session Report proposes or implements changes that violate or contradict any of the Decided ADRs.

### Decided ADRs:
${adrSummaries}

### Session Report:
${reportText}

If there is a conflict, reply with a short summary of the conflict (1-3 sentences) explaining which ADR is violated and why.
If there are no conflicts or you are unsure, reply with exactly the word "NONE".
Do not output any markdown formatting or surrounding text.`;

  try {
    const resText = await requestAiText(prompt, { task: 'conflict_check' });
    if (resText && resText.trim().toUpperCase() !== 'NONE') {
      return resText.trim();
    }
  } catch (err) {
    console.warn('Conflict checking failed:', err);
  }
  return null;
}

function applyReport(t, text) {
  const ticket = field(text, 'Ticket');
  if (ticket && ticket !== t.id) {
    toast(`Report names ${ticket}; it was not applied.`);
    return;
  }
  const summary = field(text, 'Summary') || 'Session report imported';
  const ac = field(text, 'Completed AC');
  (ac.match(/\d+/g) || []).map(Number).forEach(n => {
    if (t.acceptanceCriteria[n - 1]) t.acceptanceCriteria[n - 1].done = true;
  });
  const status = field(text, 'Status');
  if (['todo', 'in_progress', 'done'].includes(status)) t.status = status;
  const date = new Date().toISOString().slice(0, 10);
  t.sessions.push({ date, summary, nextSteps: field(text, 'Next Steps'), raw: text });
  const project = activeProject();
  const decision = field(text, 'Decisions');
  if (decision && decision.toLowerCase() !== 'none')
    project.decisions.push(
      normalizeDecision({
        id: `ADR-${String(project.decisions.length + 1).padStart(3, '0')}`,
        date,
        title: decision,
        context: 'Captured from a session report — review and ratify.',
        status: 'proposed',
      })
    );
  const question = field(text, 'Open Questions');
  if (question && question.toLowerCase() !== 'none')
    project.questions.push({
      id: `Q-${String(project.questions.length + 1).padStart(3, '0')}`,
      lane: 'agent',
      text: question,
      resolved: false,
    });
  logActivity(project, 'session', `${t.id} session report: ${summary.slice(0, 80)}`, t.id);
  save();
  renderAll();
  toast('Session report applied. Context is now saved.');
}

function ticketIntent(form) {
  const id = form.elements.id.value.trim(),
    title = form.elements.title.value.trim(),
    desc = form.elements.description.value.trim();
  return { id, title, seed: desc || title || id || 'new engineering ticket' };
}
function aiEnhancedTicketDraft(form) {
  const intent = ticketIntent(form),
    name = intent.title || intent.id || 'this ticket';
  const existingDeps =
    activeProject()
      .tickets.filter(t => t.status !== 'done')
      .slice(0, 3)
      .map(t => t.id)
      .join(', ') || 'None';
  return {
    description: `Deliver ${name} as a narrow, testable engineering change. Clarify the expected behavior, touch only the necessary project surface, and leave enough implementation notes for a future AI session to continue without re-discovery.`,
    ac: [
      `The intended behavior for ${name} is implemented and visible through the relevant UI, API, or workflow`,
      'Validation, empty states, and failure paths are handled with actionable feedback',
      'The change is covered by a focused manual or automated verification step',
      'Session notes capture any important follow-up, tradeoff, or decision',
    ].join('\n'),
    dod: `${name} is complete when the implementation works from a fresh reload, the verification path is documented, and the ticket brief gives the next AI session enough context to resume safely.`,
    notes: `AI enhancement draft:\n- Suggested current dependencies to consider: ${existingDeps}\n- Keep the ticket scoped to one shippable behavior.\n- Prefer explicit acceptance criteria over broad intent.\n- At session end, paste a session report so progress, decisions, and questions stay synchronized.`,
  };
}
function activeProvider() {
  return (
    aiSettings.providers.find(p => p.id === aiSettings.activeProviderId) || aiSettings.providers[0]
  );
}
// Single HTTP path for all AI providers. In Electron, route through the main
// process (no CORS, key stays out of the renderer); in a browser, fetch directly.
async function aiHttp(provider, payload) {
  if (window.desktopApi?.aiRequest) {
    const res = await window.desktopApi.aiRequest({
      endpoint: provider.endpoint,
      apiKey: provider.apiKey,
      payload,
    });
    if (!res || !res.ok)
      throw Error(
        `AI request failed${res && res.status ? ` (${res.status})` : ''}${
          res && res.error ? `: ${String(res.error).slice(0, 160)}` : ''
        }`
      );
    return res.data;
  }
  const headers = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers.Authorization = 'Bearer ' + provider.apiKey;
  const r = await fetch(provider.endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw Error(`AI request failed (${r.status})${t ? `: ${t.slice(0, 160)}` : ''}`);
  }
  return r.json();
}
function applyTicketDraft(form, draft) {
  const fields = { description: 'description', ac: 'ac', dod: 'dod', notes: 'notes' };
  Object.entries(fields).forEach(([key, name]) => {
    if (draft[key] && !form.elements[name].value.trim()) form.elements[name].value = draft[key];
  });
}
function ticketEnhancePrompt(form) {
  const intent = ticketIntent(form),
    open =
      openQuestions()
        .map(q => q.text)
        .join('; ') || 'None';
  const project = activeProject();
  return `You are helping draft a DevTracker engineering ticket. Return only JSON with keys description, ac, dod, notes. ac must be one string with one acceptance criterion per line.

Project: ${project?.name || 'Unnamed project'}
Ticket code: ${intent.id || 'unset'}
Ticket title: ${intent.title || 'unset'}
Seed description: ${intent.seed}
Existing ticket ids: ${project?.tickets.map(t => `${t.id}: ${t.title}`).join('; ')}
Open project questions: ${open}

Make the ticket implementation-ready for a human plus AI coding session. Keep it concise, concrete, and testable.`;
}
function parseAiDraft(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw Error('No JSON object returned.');
  const data = JSON.parse(match[0]);
  return {
    description: data.description || '',
    ac: Array.isArray(data.ac) ? data.ac.join('\n') : data.ac || '',
    dod: data.dod || data.definitionOfDone || '',
    notes: data.notes || data.technicalNotes || '',
  };
}
async function requestAiDraft(form, provider) {
  const payload = {
    messages: [
      { role: 'system', content: 'Return compact valid JSON only. Do not wrap it in markdown.' },
      { role: 'user', content: ticketEnhancePrompt(form) },
    ],
    temperature: 0.25,
  };
  if (provider.model) payload.model = provider.model;
  const data = await aiHttp(provider, payload);
  const text = data.choices?.[0]?.message?.content || data.output_text || '';
  return parseAiDraft(text);
}
async function enhanceTicketForm(form) {
  const provider = activeProvider();
  if (provider.type === 'local' || !provider.apiKey || !provider.endpoint) {
    applyTicketDraft(form, aiEnhancedTicketDraft(form));
    toast(
      provider.type === 'local'
        ? 'Local AI-style draft added.'
        : 'Provider is missing a key or endpoint; local draft added.'
    );
    return;
  }
  const button = form.querySelector('[data-ai-enhance]');
  button.disabled = true;
  button.textContent = 'Enhancing...';
  try {
    applyTicketDraft(form, await requestAiDraft(form, provider));
    toast(`Enhanced with ${provider.name}.`);
  } catch (err) {
    applyTicketDraft(form, aiEnhancedTicketDraft(form));
    toast(`${err.message} Local draft added instead.`);
  } finally {
    button.disabled = false;
    button.textContent = 'Enhance';
  }
}

function openTicketForm(existing, prefill) {
  const project = activeProject();
  const t = existing || {
      id: '',
      title: '',
      effort: 'S',
      line: 'default',
      deps: [],
      description: '',
      definitionOfDone: '',
      technicalNotes: '',
      acceptanceCriteria: [],
      ...(prefill || {}),
    },
    provider = activeProvider();
  const d = $('#ticketDialog');
  d.innerHTML = `<form class="dialog-body" id="ticketForm"><h2>${
    existing ? 'Edit' : 'New'
  } ticket</h2>${
    existing
      ? ''
      : `<div class="ai-panel"><div><strong>AI enhancement</strong><p>Active: ${esc(
          provider.name
        )}${
          provider.type !== 'local' && !provider.apiKey ? ' - add API key in settings' : ''
        }</p></div><div class="ai-actions"><button class="button" type="button" data-ai-settings>Settings</button><button class="button" type="button" data-ai-enhance>Enhance</button></div></div>`
  }<div class="form-grid"><div class="field"><label>Ticket code</label><input name="id" value="${esc(
    t.id
  )}" ${
    existing ? 'readonly' : ''
  } required></div><div class="field"><label>Effort</label><select name="effort">${[
    'XS',
    'S',
    'M',
    'L',
  ]
    .map(x => `<option ${x === t.effort ? 'selected' : ''}>${x}</option>`)
    .join(
      ''
    )}</select></div></div><div class="field"><label>Title</label><input name="title" value="${esc(
    t.title
  )}" required></div><div class="field"><label>Description</label><textarea name="description">${esc(
    t.description
  )}</textarea></div><div class="field"><label>Acceptance criteria (one per line)</label><textarea name="ac">${esc(
    t.acceptanceCriteria.map(a => a.text).join('\n')
  )}</textarea></div><div class="field"><label>Definition of done</label><textarea name="dod">${esc(
    t.definitionOfDone
  )}</textarea></div><div class="field"><label>Technical notes</label><textarea name="notes">${esc(
    t.technicalNotes
  )}</textarea></div><div class="dialog-actions"><button class="button" type="button" data-close>Cancel</button><button class="button primary">Save ticket</button></div></form>`;
  d.querySelector('[data-close]').onclick = () => d.close();
  const enhance = d.querySelector('[data-ai-enhance]');
  if (enhance) enhance.onclick = () => enhanceTicketForm(d.querySelector('form'));
  const settings = d.querySelector('[data-ai-settings]');
  if (settings) settings.onclick = () => openAiSettings();
  d.querySelector('form').onsubmit = e => {
    e.preventDefault();
    const f = new FormData(e.target),
      item = {
        ...t,
        id: f.get('id').trim(),
        title: f.get('title').trim(),
        effort: f.get('effort'),
        description: f.get('description'),
        definitionOfDone: f.get('dod'),
        technicalNotes: f.get('notes'),
        acceptanceCriteria: f
          .get('ac')
          .split('\n')
          .filter(Boolean)
          .map((text, i) => ({ text, done: t.acceptanceCriteria[i]?.done || false })),
      };
    if (!item.id || (!existing && ticketById(item.id))) {
      toast('Use a unique ticket code.');
      return;
    }
    if (existing) Object.assign(existing, item);
    else {
      project.tickets.push(item);
      logActivity(project, 'ticket', `${item.id} created: ${item.title}`, item.id);
    }
    project.selectedTicketId = item.id;
    save();
    d.close();
    renderAll();
  };
  d.showModal();
}

function openAiSettings() {
  const d = $('#aiDialog'),
    provider = activeProvider();
  const isLocal = provider.id === 'local';
  const routeState = smartRoutingActive()
    ? 'active'
    : aiSettings.smartRouting
    ? 'needs ≥2 usable providers'
    : 'off';
  d.innerHTML = `<form class="dialog-body" id="aiForm"><h2>AI settings</h2><p class="subcopy">Use Local draft with no key, or add an OpenAI-compatible provider such as Grok.</p>
  <div class="ai-panel" style="display:block"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px"><div><strong>⚡ Smart routing (OrchestratorLLM)</strong><p>Classify each task's Big O difficulty and route to the cheapest capable provider, escalating on failure. <em>Status: ${esc(
    routeState
  )}.</em></p></div><label style="display:flex;align-items:center;gap:6px;white-space:nowrap"><input type="checkbox" name="smartRouting" ${
    aiSettings.smartRouting ? 'checked' : ''
  }> Enable</label></div>
  <div class="field" style="margin:10px 0 0"><label>Privacy policy for sensitive tasks</label><select name="privacyPolicy">${[
    ['hard', 'Hard — sensitive stays local'],
    ['prompt', 'Prompt — warn before hosted'],
    ['cost', 'Cost — sensitivity ignored'],
  ]
    .map(
      ([v, l]) =>
        `<option value="${v}"${
          (aiSettings.privacyPolicy || 'hard') === v ? ' selected' : ''
        }>${l}</option>`
    )
    .join('')}</select></div></div>
  <div class="field"><label>Active provider (used when smart routing is off)</label><select name="active">${aiSettings.providers
    .map(
      p =>
        `<option value="${esc(p.id)}" ${p.id === provider.id ? 'selected' : ''}>${esc(
          p.name
        )}</option>`
    )
    .join('')}</select></div>
  <div class="form-grid"><div class="field"><label>Name</label><input name="name" value="${esc(
    provider.name
  )}" ${
    isLocal ? 'readonly' : ''
  }></div><div class="field"><label>Model</label><input name="model" value="${esc(
    provider.model
  )}" ${isLocal ? 'readonly' : ''} placeholder="grok-4"></div></div>
  <div class="field"><label>Endpoint</label><input name="endpoint" value="${esc(
    provider.endpoint
  )}" ${isLocal ? 'readonly' : ''} placeholder="https://api.x.ai/v1/chat/completions"></div>
  <div class="field"><label>API key</label><input name="apiKey" type="password" value="${esc(
    provider.apiKey
  )}" ${isLocal ? 'readonly' : ''} placeholder="Paste your key here"></div>
  <fieldset style="border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:6px 0"><legend style="font:10px 'DM Mono';color:#75837b;padding:0 6px">ROUTING CAPABILITY</legend><div class="form-grid" style="grid-template-columns:1fr 1fr 1fr"><div class="field" style="margin:6px 0"><label>Tier</label><select name="tier" ${
    isLocal ? 'disabled' : ''
  }>${['cheap', 'mid', 'strong']
    .map(
      t =>
        `<option value="${t}"${
          (provider.tier || (isLocal ? 'cheap' : 'mid')) === t ? ' selected' : ''
        }>${t}</option>`
    )
    .join(
      ''
    )}</select></div><div class="field" style="margin:6px 0"><label>Location</label><select name="location" ${
    isLocal ? 'disabled' : ''
  }>${['local', 'hosted']
    .map(
      l =>
        `<option value="${l}"${
          (provider.location || (isLocal ? 'local' : 'hosted')) === l ? ' selected' : ''
        }>${l}</option>`
    )
    .join(
      ''
    )}</select></div><div class="field" style="margin:6px 0"><label>Cost /1k</label><input name="costPer1k" type="number" step="0.1" min="0" value="${
    provider.costPer1k != null ? provider.costPer1k : isLocal ? 0 : 1
  }" ${
    isLocal ? 'readonly' : ''
  }></div></div><label style="display:flex;align-items:center;gap:6px;font-size:12px"><input type="checkbox" name="sensitivityOK" ${
    (provider.sensitivityOK != null ? provider.sensitivityOK : isLocal) ? 'checked' : ''
  } ${
    isLocal ? 'disabled' : ''
  }> Safe for sensitive data (kept only if it never leaves your control)</label></fieldset>
  <p class="settings-note">Keys are saved in this browser only. Use this for local/private workspaces, not shared browsers.</p>
  <div class="dialog-actions"><button class="button" type="button" data-add-provider>Add custom provider</button><button class="button" type="button" data-close>Cancel</button><button class="button primary">Save settings</button></div></form>`;
  const form = d.querySelector('form');
  form.elements.active.onchange = () => {
    persistProviderEdits(form);
    aiSettings.activeProviderId = form.elements.active.value;
    saveAiSettings();
    openAiSettings();
  };
  form.elements.smartRouting.onchange = () => {
    aiSettings.smartRouting = form.elements.smartRouting.checked;
    saveAiSettings();
    openAiSettings();
  };
  d.querySelector('[data-add-provider]').onclick = () => {
    persistProviderEdits(form);
    const id = `custom-${Date.now()}`;
    aiSettings.providers.push({
      id,
      name: 'Custom AI',
      type: 'openai-compatible',
      endpoint: '',
      model: '',
      apiKey: '',
      ...PROVIDER_CAP_DEFAULTS,
    });
    aiSettings.activeProviderId = id;
    saveAiSettings();
    openAiSettings();
  };
  d.querySelector('[data-close]').onclick = () => d.close();
  form.onsubmit = e => {
    e.preventDefault();
    persistProviderEdits(form);
    aiSettings.smartRouting = form.elements.smartRouting.checked;
    aiSettings.privacyPolicy = form.elements.privacyPolicy.value;
    aiSettings.activeProviderId = form.elements.active.value;
    saveAiSettings();
    d.close();
    toast('AI settings saved.');
  };
  if (!d.open) d.showModal();
}
function persistProviderEdits(form) {
  const p = activeProvider();
  if (!p) return;
  if (p.id !== 'local') {
    p.name = form.elements.name.value.trim() || p.name;
    p.model = form.elements.model.value.trim();
    p.endpoint = form.elements.endpoint.value.trim();
    p.apiKey = form.elements.apiKey.value.trim();
    p.tier = form.elements.tier.value;
    p.location = form.elements.location.value;
    p.sensitivityOK = form.elements.sensitivityOK.checked;
    p.costPer1k = Number(form.elements.costPer1k.value) || 0;
  }
}

const REVERSIBILITY_LABEL = { 'one-way': 'One-way door', 'two-way': 'Two-way door' };
function decisionChips(d) {
  const rev = d.reversibility
    ? `<span class="chip" style="border-color:${
        d.reversibility === 'one-way' ? '#d98c5f' : '#5f9ea0'
      }">${REVERSIBILITY_LABEL[d.reversibility]}</span>`
    : '';
  const src =
    d.source === 'agent'
      ? '<span class="chip" style="border-color:#b3a5ea;color:#5b47c9">🤖 agent-proposed</span>'
      : '';
  const talk = (d.discussion || []).length
    ? `<span class="chip">💬 ${d.discussion.length}</span>`
    : '';
  const reviewed = d.review
    ? '<span class="chip" style="border-color:#8fb8a8">⚖ reviewed</span>'
    : '';
  return `${rev} ${src} ${talk} ${reviewed}`;
}
function renderDecisionCard(d) {
  const outcome =
    d.status === 'decided' && d.choice
      ? `<p class="decision-outcome"><strong>Decided:</strong> ${esc(d.choice)}${
          d.rationale ? ` — ${esc(d.rationale)}` : ''
        }</p>`
      : d.status === 'proposed'
      ? `<p class="decision-outcome" style="color:#c07a3f"><strong>⚠ Awaiting Tech Lead decision.</strong> Explore the branches, debate it, then make the call.</p>`
      : `<p class="decision-outcome" style="color:#82908a">Superseded.</p>`;
  return `<article class="list-row"><span class="list-meta">${esc(d.id)} · ${esc(
    d.date
  )} <span class="status-pill ${esc(d.status)}">${esc(d.status)}</span> ${decisionChips(
    d
  )}</span><strong>${esc(d.title)}</strong>${
    d.context ? `<p>${esc(d.context)}</p>` : ''
  }<div class="branch-scroll">${decisionBranchSvg(
    d
  )}</div>${outcome}<p><button class="button primary" data-explore-decision="${esc(
    d.id
  )}">⚖ Explore &amp; debate</button> <button class="button" data-edit-decision="${esc(
    d.id
  )}">Edit / decide</button></p></article>`;
}
const DECISION_ORDER = { proposed: 0, decided: 1, superseded: 2 };
function renderDecisions() {
  const project = activeProject();
  const el = $('#decisionsView');
  const pending = project.decisions.filter(d => d.status === 'proposed').length;
  const sorted = [...project.decisions].sort(
    (a, b) => (DECISION_ORDER[a.status] ?? 3) - (DECISION_ORDER[b.status] ?? 3)
  );
  const canDrift = !!(
    window.desktopApi &&
    (project.contextChunks || []).length &&
    project.decisions.some(d => d.status === 'decided')
  );
  el.innerHTML = `<div class="view-head"><div><p class="eyebrow">DECISION BUCKET</p><h1>Project decisions</h1><p class="subcopy">Agents lay out options and tradeoffs as branches; the Tech Lead makes the call. Settled decisions travel with every AI session brief.${
    pending ? ` <strong>${pending} awaiting your decision.</strong>` : ''
  }</p></div><div style="display:flex;gap:8px">${
    canDrift ? '<button class="button" id="checkDrift">Check drift vs indexed repo</button>' : ''
  }<button class="button primary" id="addDecision">+ Decision</button></div></div><div class="list-card">${
    sorted.map(renderDecisionCard).join('') || '<p>No decisions captured yet.</p>'
  }</div>`;
  $('#addDecision').onclick = () => openDecisionForm();
  const driftBtn = $('#checkDrift');
  if (driftBtn) driftBtn.onclick = () => checkDecisionDrift(project);
  el.querySelectorAll('[data-edit-decision]').forEach(
    b =>
      (b.onclick = () =>
        openDecisionForm(project.decisions.find(x => x.id === b.dataset.editDecision)))
  );
  el.querySelectorAll('[data-explore-decision]').forEach(
    b =>
      (b.onclick = () =>
        openDecisionExplore(project.decisions.find(x => x.id === b.dataset.exploreDecision)))
  );
  // Live refresh: if an agent (via MCP file watch) touched the decision that is
  // open in the explore dialog, re-render it — preserving any draft text.
  const dlg = $('#decisionExploreDialog');
  if (dlg && dlg.open && exploreDecisionId) {
    const cur = exploreDecision();
    if (!cur) closeDecisionExplore();
    else if (dlg.dataset.snapshot !== JSON.stringify(cur)) renderDecisionExplore();
  }
}

function formatDecisionForBrief(d) {
  const rev = d.reversibility ? ` (${d.reversibility} door)` : '';
  const head = `- ${d.id} [${d.status}${rev}] ${d.title}`;
  const ctx = d.context ? `\n  Context: ${d.context}` : '';
  const opts = d.options.length
    ? '\n  Options:' +
      d.options
        .map(
          o =>
            `\n    • ${o.name}${o.pros.length ? ` — pros: ${o.pros.join('; ')}` : ''}${
              o.cons.length ? `${o.pros.length ? ';' : ' —'} cons: ${o.cons.join('; ')}` : ''
            }`
        )
        .join('')
    : '';
  const outcome =
    d.status === 'decided' && d.choice
      ? `\n  Chosen: ${d.choice}${d.rationale ? ` — ${d.rationale}` : ''}`
      : d.status === 'proposed'
      ? '\n  → NEEDS TECH LEAD DECISION'
      : '';
  return head + ctx + opts + outcome;
}

// --- Decision branch view, debate & review ---------------------------------
function wrapText(text, n, maxLines) {
  const words = String(text || '')
    .split(/\s+/)
    .filter(Boolean);
  const lines = [''];
  for (const w of words) {
    const cur = lines[lines.length - 1];
    if ((cur + ' ' + w).trim().length <= n) lines[lines.length - 1] = (cur + ' ' + w).trim();
    else if (lines.length < maxLines) lines.push(w);
    else {
      lines[lines.length - 1] = cur.slice(0, n - 1) + '…';
      break;
    }
  }
  return lines;
}
const LEAF_STYLE = {
  pro: { fill: '#f1faf5', stroke: '#99ccab', ink: '#1d5c40', sign: '+' },
  con: { fill: '#fdf0ec', stroke: '#eab7a9', ink: '#8a3a26', sign: '−' },
  none: { fill: '#f5f6f2', stroke: '#d9e0dd', ink: '#82908a', sign: '·' },
};
function branchEdge(x1, y1, x2, y2, stroke, width) {
  const mid = (x1 + x2) / 2;
  return `<path d="M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}" fill="none" stroke="${stroke}" stroke-width="${width}"/>`;
}
function decisionBranchSvg(d) {
  const M = 16,
    ROOT_W = 150,
    ROOT_H = 56,
    OPT_W = 180,
    OPT_H = 44,
    LEAF_W = 270,
    LEAF_H = 38,
    LEAF_GAP = 8,
    BLOCK_GAP = 22,
    COL_GAP = 52;
  const opts = d.options.length
    ? d.options
    : [{ name: 'No options captured yet', pros: [], cons: [] }];
  const blocks = opts.map(o => {
    const leaves = [
      ...o.pros.map(t => ({ kind: 'pro', text: t })),
      ...o.cons.map(t => ({ kind: 'con', text: t })),
    ];
    if (!leaves.length) leaves.push({ kind: 'none', text: 'No tradeoffs captured yet' });
    return { o, leaves, h: Math.max(leaves.length * (LEAF_H + LEAF_GAP) - LEAF_GAP, OPT_H) };
  });
  const totalH = Math.max(
    blocks.reduce((a, b) => a + b.h, 0) + (blocks.length - 1) * BLOCK_GAP + M * 2,
    ROOT_H + M * 2
  );
  const rootX = M,
    optX = M + ROOT_W + COL_GAP,
    leafX = optX + OPT_W + COL_GAP,
    W = leafX + LEAF_W + M;
  const rootCY = totalH / 2;
  const parts = [];
  let y = M;
  blocks.forEach(b => {
    const chosen = !!(d.choice && b.o.name === d.choice);
    const optY = y + b.h / 2 - OPT_H / 2,
      optCY = optY + OPT_H / 2;
    parts.push(
      branchEdge(
        rootX + ROOT_W,
        rootCY,
        optX,
        optCY,
        chosen ? '#167554' : '#c7d0ca',
        chosen ? 2.5 : 1.6
      )
    );
    const nameLines = wrapText(b.o.name || 'Unnamed option', 22, 2);
    parts.push(
      `<g><title>${esc(
        b.o.name
      )}</title><rect x="${optX}" y="${optY}" width="${OPT_W}" height="${OPT_H}" rx="8" fill="${
        chosen ? '#e3f5ea' : '#fff'
      }" stroke="${chosen ? '#167554' : '#c9d3cc'}" stroke-width="${chosen ? 2 : 1.4}"/><text x="${
        optX + 12
      }" y="${
        optY + (nameLines.length > 1 ? 18 : 26)
      }" style="font:700 12px Manrope;fill:#172521">${esc(nameLines[0])}${
        chosen ? ' ✓' : ''
      }</text>${
        nameLines[1]
          ? `<text x="${optX + 12}" y="${
              optY + 34
            }" style="font:700 12px Manrope;fill:#172521">${esc(nameLines[1])}</text>`
          : ''
      }</g>`
    );
    let ly = y + (b.h - (b.leaves.length * (LEAF_H + LEAF_GAP) - LEAF_GAP)) / 2;
    b.leaves.forEach(leaf => {
      const s = LEAF_STYLE[leaf.kind],
        leafCY = ly + LEAF_H / 2;
      parts.push(branchEdge(optX + OPT_W, optCY, leafX, leafCY, s.stroke, 1.3));
      const lines = wrapText(leaf.text, 42, 2);
      parts.push(
        `<g><title>${esc(
          leaf.text
        )}</title><rect x="${leafX}" y="${ly}" width="${LEAF_W}" height="${LEAF_H}" rx="7" fill="${
          s.fill
        }" stroke="${s.stroke}"/><text x="${leafX + 11}" y="${
          ly + (lines.length > 1 ? 16 : 23)
        }" style="font:700 12px 'DM Mono';fill:${s.ink}">${s.sign}</text><text x="${
          leafX + 26
        }" y="${ly + (lines.length > 1 ? 16 : 23)}" style="font:11px Manrope;fill:${s.ink}">${esc(
          lines[0]
        )}</text>${
          lines[1]
            ? `<text x="${leafX + 26}" y="${ly + 30}" style="font:11px Manrope;fill:${s.ink}">${esc(
                lines[1]
              )}</text>`
            : ''
        }</g>`
      );
      ly += LEAF_H + LEAF_GAP;
    });
    y += b.h + BLOCK_GAP;
  });
  const titleLines = wrapText(d.title, 18, 2);
  const root = `<g><title>${esc(d.title)}</title><rect x="${rootX}" y="${
    rootCY - ROOT_H / 2
  }" width="${ROOT_W}" height="${ROOT_H}" rx="9" fill="#172521"/><text x="${rootX + 12}" y="${
    rootCY - ROOT_H / 2 + 16
  }" style="font:9px 'DM Mono';letter-spacing:.1em;fill:#8fb8a8">${esc(d.id)}</text><text x="${
    rootX + 12
  }" y="${rootCY - ROOT_H / 2 + 32}" style="font:700 11px Manrope;fill:#fff">${esc(
    titleLines[0]
  )}</text>${
    titleLines[1]
      ? `<text x="${rootX + 12}" y="${
          rootCY - ROOT_H / 2 + 46
        }" style="font:700 11px Manrope;fill:#fff">${esc(titleLines[1])}</text>`
      : ''
  }</g>`;
  return `<svg viewBox="0 0 ${W} ${totalH}" width="${W}" height="${totalH}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Decision branches for ${esc(
    d.title
  )}">${parts.join('')}${root}</svg>`;
}

let exploreDecisionId = null;
function exploreDecision() {
  return activeProject()?.decisions.find(x => x.id === exploreDecisionId) || null;
}
function openDecisionExplore(d) {
  if (!d) return;
  exploreDecisionId = d.id;
  renderDecisionExplore();
  const dlg = $('#decisionExploreDialog');
  if (!dlg.open) dlg.showModal();
}
function closeDecisionExplore() {
  exploreDecisionId = null;
  const dlg = $('#decisionExploreDialog');
  if (dlg.open) dlg.close();
}
function debateBubble(m, i) {
  const who =
    m.role === 'lead' ? 'You' : m.role === 'agent' ? '🤖 External agent' : 'AI sparring partner';
  const updates = (m.updates || []).map((u, ui) => updateChip(u, i, ui)).join('');
  return `<div class="debate-msg ${esc(m.role || 'ai')}"><span class="debate-meta">${esc(who)}${
    m.ts ? ` · ${esc(m.ts.slice(0, 16).replace('T', ' '))}` : ''
  }</span>${esc(m.text)}${updates ? `<div>${updates}</div>` : ''}</div>`;
}
function updateChip(u, mi, ui) {
  const label =
    u.op === 'add_option'
      ? `＋ option: ${u.name || ''}`
      : `${u.op === 'add_pro' ? '＋ pro' : '－ con'} → ${u.option || ''}: ${u.text || ''}`;
  return `<span class="update-chip">${esc(label)} ${
    u.applied
      ? `<em style="font-style:normal;color:#257453">✓ ${esc(u.applied)}</em>`
      : `<button class="button" style="padding:2px 8px" data-apply-update="${mi}:${ui}">Apply</button>`
  }</span>`;
}
function applyDecisionUpdate(d, u) {
  if (u.op === 'add_option') {
    const name = (u.name || '').trim();
    if (!name || d.options.some(o => o.name === name)) return false;
    d.options.push({
      name,
      pros: Array.isArray(u.pros) ? u.pros : [],
      cons: Array.isArray(u.cons) ? u.cons : [],
    });
    return true;
  }
  const opt = d.options.find(o => o.name === (u.option || '').trim());
  if (!opt) return false;
  const list = u.op === 'add_pro' ? opt.pros : u.op === 'add_con' ? opt.cons : null;
  const text = (u.text || '').trim();
  if (!list || !text || list.includes(text)) return false;
  list.push(text);
  return true;
}
function renderDecisionExplore() {
  const d = exploreDecision();
  const dlg = $('#decisionExploreDialog');
  if (!d || !dlg) return;
  const draft = dlg.querySelector('[data-debate-input]')?.value || '';
  const provider = activeProvider();
  const local = provider.type === 'local' || !provider.apiKey || !provider.endpoint;
  const decided = d.status === 'decided';
  const thread =
    (d.discussion || []).map((m, i) => debateBubble(m, i)).join('') ||
    '<p class="subcopy" style="max-width:none">No debate yet. Challenge a tradeoff below — the AI argues both sides but never decides. External agents can join this thread via the <code>discuss_decision</code> MCP tool.</p>';
  const review = d.review
    ? `<div class="review-panel"><strong>⚖ AI review — advisory only</strong> <span class="list-meta">${esc(
        d.review.date
      )}${
        d.review.model ? ` · ${esc(d.review.model)}` : ''
      }</span><p style="margin:6px 0 0;white-space:pre-wrap">${esc(d.review.text)}</p></div>`
    : '';
  dlg.innerHTML = `<div class="dialog-body">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
      <div><span class="list-meta">${esc(d.id)} · ${esc(d.date)} <span class="status-pill ${esc(
    d.status
  )}">${esc(d.status)}</span> ${decisionChips(d)}</span><h2 style="margin:8px 0 4px">${esc(
    d.title
  )}</h2>${d.context ? `<p class="subcopy" style="max-width:none">${esc(d.context)}</p>` : ''}</div>
      <button class="button quiet" data-close-explore type="button">✕</button>
    </div>
    <div class="branch-scroll">${decisionBranchSvg(d)}</div>
    ${
      decided
        ? `<p class="decision-outcome"><strong>Decided:</strong> ${esc(d.choice)}${
            d.rationale ? ` — ${esc(d.rationale)}` : ''
          }</p>`
        : ''
    }
    ${review}
    <div style="display:flex;gap:8px;margin:12px 0"><button class="button" data-run-review type="button">${
      d.review ? '⚖ Re-run AI review' : '⚖ AI review'
    }</button><button class="button" data-edit-full type="button">Edit full form</button></div>
    <h3 style="font:10px 'DM Mono';letter-spacing:.1em;color:#77857e;margin:14px 0 8px">DEBATE — ARGUE IT OUT BEFORE YOU DECIDE</h3>
    <div class="debate-thread" data-debate-thread>${thread}</div>
    <form data-debate-form style="display:flex;gap:8px;margin-top:8px"><textarea data-debate-input rows="2" placeholder="${
      local
        ? 'Local mode — replies are scaffolded; add an AI provider for a real sparring partner'
        : 'Challenge an option, add evidence, or ask what you are missing…'
    }" style="flex:1;resize:none;border:1px solid var(--line);border-radius:6px;padding:8px;font:13px Manrope">${esc(
    draft
  )}</textarea><button class="button primary">Send</button></form>
    ${
      decided
        ? ''
        : `<div class="decide-bar"><div class="field" style="margin:0"><label>Chosen option (Tech Lead)</label><select data-decide-choice><option value="">(undecided)</option>${d.options
            .filter(o => o.name)
            .map(o => `<option value="${esc(o.name)}">${esc(o.name)}</option>`)
            .join(
              ''
            )}</select></div><div class="field" style="margin:0"><label>Rationale</label><input data-decide-rationale placeholder="Why this option wins"></div><button class="button primary" data-decide type="button">Decide</button></div>`
    }
  </div>`;
  dlg.dataset.snapshot = JSON.stringify(d);
  dlg.querySelector('[data-close-explore]').onclick = () => closeDecisionExplore();
  dlg.querySelector('[data-edit-full]').onclick = () => {
    closeDecisionExplore();
    openDecisionForm(d);
  };
  dlg.querySelector('[data-run-review]').onclick = e => runDecisionReview(d, e.target);
  const form = dlg.querySelector('[data-debate-form]');
  form.onsubmit = e => {
    e.preventDefault();
    const ta = form.querySelector('textarea');
    const v = ta.value.trim();
    ta.value = '';
    if (v) sendDecisionDebate(v);
  };
  form.querySelector('textarea').onkeydown = e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  };
  const decideBtn = dlg.querySelector('[data-decide]');
  if (decideBtn)
    decideBtn.onclick = () => {
      const choice = dlg.querySelector('[data-decide-choice]').value;
      if (!choice) {
        toast('Pick the winning option first.');
        return;
      }
      d.choice = choice;
      d.rationale = dlg.querySelector('[data-decide-rationale]').value.trim();
      d.status = 'decided';
      logActivity(activeProject(), 'decision', `${d.id} decided: ${choice} — ${d.title}`, d.id);
      save();
      if (window.desktopApi?.writeAdrFile) {
        const md = compileDecisionToMarkdown(d);
        window.desktopApi.writeAdrFile(d.id, d.title, md).then(res => {
          if (res && !res.ok) console.warn('ADR sync failed:', res.error);
        });
      }
      renderAll();
      renderDecisionExplore();
      toast(`${d.id} decided: ${choice}`);
    };
  dlg.querySelectorAll('[data-apply-update]').forEach(
    b =>
      (b.onclick = () => {
        const [mi, ui] = b.dataset.applyUpdate.split(':').map(Number);
        const msg = (d.discussion || [])[mi];
        const op = msg && msg.updates && msg.updates[ui];
        if (!op) return;
        const done = applyDecisionUpdate(d, op);
        op.applied = done ? 'applied' : 'skipped';
        save();
        renderAll();
        renderDecisionExplore();
        toast(done ? 'Applied to the decision tree.' : 'Already present — skipped.');
      })
  );
  const box = dlg.querySelector('[data-debate-thread]');
  if (box) box.scrollTop = box.scrollHeight;
}
// Heuristic drift check: a decided ADR whose chosen option's terms never appear
// in the indexed repo may not be reflected in code yet (or the code moved on).
function checkDecisionDrift(project) {
  const chunkText = (project.contextChunks || [])
    .map(c => String(c.text || '').toLowerCase())
    .join('\n');
  const decided = project.decisions.filter(d => d.status === 'decided' && d.choice);
  const flags = decided.filter(d => {
    const terms = String(d.choice)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(w => w.length > 3);
    return terms.length && !terms.some(t => chunkText.includes(t));
  });
  const age = d => Math.round((Date.now() - new Date(d.date).getTime()) / 86400000);
  const stale = decided.filter(d => d.date && age(d) > 30);
  openTextDialog(
    'Drift check (heuristic)',
    `Checked ${decided.length} decided ADR(s) against ${
      (project.contextChunks || []).length
    } indexed repo chunks.\n\n` +
      (flags.length
        ? `⚠ Possibly not reflected in code (chosen option's terms not found in the index):\n${flags
            .map(d => `- ${d.id} ${d.title} → "${d.choice}"`)
            .join('\n')}\n\n`
        : '✓ Every decided choice appears somewhere in the indexed repo.\n\n') +
      (stale.length
        ? `🕰 Older than 30 days — worth a re-glance:\n${stale
            .map(d => `- ${d.id} ${d.title} (${age(d)}d)`)
            .join('\n')}\n\n`
        : '') +
      `This is a lexical heuristic, not proof — re-index the repo first (Git tab → "Index repo → context") for current results.`
  );
}
function parseDecisionUpdates(text) {
  if (!text) return { content: '', updates: [] };
  const re = /```devtracker-decision-updates\s*([\s\S]*?)```/i;
  const m = text.match(re);
  if (!m) return { content: text.trim(), updates: [] };
  let updates = [];
  try {
    const parsed = JSON.parse(m[1].trim());
    updates = (Array.isArray(parsed) ? parsed : [parsed]).filter(
      u => u && ['add_pro', 'add_con', 'add_option'].includes(u.op)
    );
  } catch {
    updates = [];
  }
  return { content: text.replace(re, '').trim(), updates };
}
function decisionDebatePrompt(d, latest) {
  const decided =
    (activeProject().decisions || [])
      .filter(x => x.status === 'decided' && x.id !== d.id)
      .map(x => `- ${x.id}: ${x.title} → ${x.choice}`)
      .join('\n') || 'None';
  const thread =
    (d.discussion || [])
      .slice(-12)
      .map(
        m =>
          `${m.role === 'lead' ? 'TECH LEAD' : m.role === 'agent' ? 'EXTERNAL AGENT' : 'YOU'}: ${
            m.text
          }`
      )
      .join('\n') || '(none yet)';
  return `You are a sparring partner helping a Tech Lead pressure-test an architectural decision before they call it. Steel-man BOTH sides; when the lead leans one way, argue the strongest counter-case. You never pick the winner — the human decides.

${compileDecisionToMarkdown(d)}

Other decided ADRs (settled — do not re-litigate):
${decided}

Debate so far:
${thread}

The Tech Lead just said: "${latest}"

Reply in under 180 words, direct and technical, responding to their point. If the debate has surfaced a genuinely new option, pro, or con, append ONE fenced block at the very end:
\`\`\`devtracker-decision-updates
[{"op":"add_con","option":"<existing option name>","text":"…"},{"op":"add_pro","option":"…","text":"…"},{"op":"add_option","name":"…","pros":[],"cons":[]}]
\`\`\`
Only include ops genuinely raised in this exchange. There is no "decide" op.`;
}
function localDebateReply(d, latest) {
  const opts = d.options.filter(o => o.name);
  const strongest = opts
    .map(
      o =>
        `- ${o.name}: strongest pro — ${o.pros[0] || 'none captured'}; strongest con — ${
          o.cons[0] || 'none captured'
        }`
    )
    .join('\n');
  return `Local mode (no AI provider) — a scaffolded counterpoint:\n\nYou said: "${latest}"\n\nBefore deciding, weigh each side's best case:\n${
    strongest || '- No options captured yet — add at least two, including "do nothing".'
  }\n\nQuestions worth answering first:\n- What breaks if you pick wrong, and how fast can you reverse it (${
    d.reversibility ? REVERSIBILITY_LABEL[d.reversibility] : 'door type unclassified'
  })?\n- Which con above have you validated rather than assumed?\n\nAdd a provider in AI settings for a real debate.`;
}
async function sendDecisionDebate(text) {
  const d = exploreDecision();
  if (!d) return;
  d.discussion = d.discussion || [];
  d.discussion.push({ role: 'lead', text, ts: new Date().toISOString() });
  save();
  const provider = activeProvider();
  const thinking = { role: 'ai', text: '…', pending: true };
  d.discussion.push(thinking);
  renderDecisionExplore();
  try {
    const reply = smartRoutingActive()
      ? await requestAiText(decisionDebatePrompt(d, text), { task: 'decision_debate' })
      : provider.type === 'local' || !provider.apiKey || !provider.endpoint
      ? localDebateReply(d, text)
      : await requestAiText(decisionDebatePrompt(d, text));
    const { content, updates } = parseDecisionUpdates(reply);
    const idx = d.discussion.indexOf(thinking);
    d.discussion.splice(idx < 0 ? d.discussion.length : idx, 1, {
      role: 'ai',
      text: content || '(no response)',
      ...(updates.length ? { updates } : {}),
      ts: new Date().toISOString(),
    });
  } catch (err) {
    const idx = d.discussion.indexOf(thinking);
    if (idx >= 0) d.discussion.splice(idx, 1);
    d.discussion.push({ role: 'ai', text: `⚠ ${err.message}`, ts: new Date().toISOString() });
  }
  save();
  renderAll();
  renderDecisionExplore();
}
function heuristicReviewFindings(d) {
  const f = [];
  if (!d.context) f.push('No context captured — record why this decision is needed now.');
  if (d.options.filter(o => o.name).length < 2)
    f.push(
      'Only one option on the table — add at least one alternative, including "do nothing / defer".'
    );
  d.options.forEach(o => {
    if (o.name && !o.cons.length)
      f.push(`"${o.name}" lists no cons — one-sided analysis; every real option costs something.`);
    if (o.name && !o.pros.length) f.push(`"${o.name}" lists no pros — why is it on the table?`);
  });
  if (!d.reversibility)
    f.push('Reversibility unclassified — one-way doors deserve more scrutiny than two-way doors.');
  if (d.reversibility === 'one-way')
    f.push('One-way door — consider a cheap spike to de-risk before committing.');
  return f;
}
function decisionReviewPrompt(d) {
  return `You are a skeptical principal-engineer reviewer. Review this proposed architectural decision for the Tech Lead. You are ADVISORY ONLY — the human decides.

${compileDecisionToMarkdown(d)}

Reply in plain text with exactly these numbered sections, each 1-3 terse bullets:
1. Missing options (include "do nothing" if absent)
2. Weak or unsupported pros/cons
3. Biggest risk if decided today
4. Questions the Tech Lead should ask before deciding
5. Leaning (clearly labeled advisory, with confidence low/medium/high)`;
}
async function runDecisionReview(d, btn) {
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Reviewing…';
  }
  const provider = activeProvider();
  const date = new Date().toISOString().slice(0, 10);
  try {
    if (
      !smartRoutingActive() &&
      (provider.type === 'local' || !provider.apiKey || !provider.endpoint)
    ) {
      const f = heuristicReviewFindings(d);
      d.review = {
        date,
        model: 'Local heuristics',
        text: f.length
          ? f.map(x => `• ${x}`).join('\n')
          : '• Structurally sound: 2+ options, tradeoffs on each side, context and reversibility recorded. Configure an AI provider for a deeper review.',
      };
    } else {
      d.review = {
        date,
        model: smartRoutingActive() ? 'OrchestratorLLM (routed)' : provider.model || provider.name,
        text: (await requestAiText(decisionReviewPrompt(d), { task: 'decision_review' })).trim(),
      };
    }
    save();
    renderAll();
    renderDecisionExplore();
    toast('Review attached — advisory only; the call is yours.');
  } catch (err) {
    toast(`Review failed: ${err.message}`);
    if (btn) btn.disabled = false;
  }
}

function optionBlock(o) {
  return `<div class="option-edit" style="border:1px solid var(--line);border-radius:8px;padding:10px;margin-bottom:8px"><div class="field"><label>Option name</label><input data-opt-name value="${esc(
    o.name
  )}" placeholder="e.g. MongoDB Atlas Vector Search"></div><div class="form-grid"><div class="field"><label>Pros (one per line)</label><textarea data-opt-pros>${esc(
    (o.pros || []).join('\n')
  )}</textarea></div><div class="field"><label>Cons (one per line)</label><textarea data-opt-cons>${esc(
    (o.cons || []).join('\n')
  )}</textarea></div></div><button class="button" type="button" data-remove-option>Remove option</button></div>`;
}
function refreshChoices(form, current) {
  const sel = form.querySelector('#choiceSelect');
  const names = [...form.querySelectorAll('[data-opt-name]')]
    .map(i => i.value.trim())
    .filter(Boolean);
  const chosen = current != null ? current : sel.value;
  sel.innerHTML =
    `<option value="">(undecided)</option>` +
    names
      .map(n => `<option value="${esc(n)}"${n === chosen ? ' selected' : ''}>${esc(n)}</option>`)
      .join('');
}
function wireOptionBlock(form, block) {
  block.querySelector('[data-remove-option]').onclick = () => {
    block.remove();
    refreshChoices(form);
  };
  block.querySelector('[data-opt-name]').oninput = () => refreshChoices(form);
}
function addOptionBlock(form) {
  const list = form.querySelector('#optionList');
  const wrap = document.createElement('div');
  wrap.innerHTML = optionBlock({ name: '', pros: [], cons: [] });
  const block = wrap.firstElementChild;
  list.appendChild(block);
  wireOptionBlock(form, block);
  refreshChoices(form);
}
function readOptions(form) {
  return [...form.querySelectorAll('.option-edit')]
    .map(block => ({
      name: block.querySelector('[data-opt-name]').value.trim(),
      pros: block
        .querySelector('[data-opt-pros]')
        .value.split('\n')
        .map(s => s.trim())
        .filter(Boolean),
      cons: block
        .querySelector('[data-opt-cons]')
        .value.split('\n')
        .map(s => s.trim())
        .filter(Boolean),
    }))
    .filter(o => o.name || o.pros.length || o.cons.length);
}
function openDecisionForm(existing) {
  const project = activeProject();
  const base = existing
    ? normalizeDecision(existing)
    : {
        id: '',
        title: '',
        context: '',
        reversibility: '',
        options: [
          { name: '', pros: [], cons: [] },
          { name: '', pros: [], cons: [] },
        ],
        choice: '',
        rationale: '',
        status: 'proposed',
      };
  const d = $('#decisionDialog');
  d.innerHTML = `<form class="dialog-body" id="decisionForm"><h2>${
    existing ? 'Edit' : 'New'
  } decision</h2><p class="subcopy">Capture the options and tradeoffs. The AI weighs them; you make the call.</p><div class="form-grid"><div class="field"><label>Title</label><input name="title" value="${esc(
    base.title
  )}" required></div><div class="field"><label>Reversibility</label><select name="reversibility"><option value="">Unspecified</option><option value="two-way"${
    base.reversibility === 'two-way' ? ' selected' : ''
  }>Two-way door (reversible)</option><option value="one-way"${
    base.reversibility === 'one-way' ? ' selected' : ''
  }>One-way door (hard to undo)</option></select></div></div><div class="field"><label>Context — why decide this now?</label><textarea name="context">${esc(
    base.context
  )}</textarea></div><div class="field"><label>Options &amp; tradeoffs</label><div id="optionList">${base.options
    .map(optionBlock)
    .join(
      ''
    )}</div><button class="button" type="button" data-add-option>+ Add option</button></div><div class="form-grid"><div class="field"><label>Chosen option (Tech Lead)</label><select name="choice" id="choiceSelect"></select></div><div class="field"><label>Status</label><select name="status">${[
    'proposed',
    'decided',
    'superseded',
  ]
    .map(s => `<option value="${s}"${base.status === s ? ' selected' : ''}>${s}</option>`)
    .join(
      ''
    )}</select></div></div><div class="field"><label>Decision rationale (Tech Lead)</label><textarea name="rationale">${esc(
    base.rationale
  )}</textarea></div><div class="dialog-actions"><button class="button" type="button" data-close>Cancel</button><button class="button primary">Save decision</button></div></form>`;
  const form = d.querySelector('form');
  form.querySelectorAll('.option-edit').forEach(b => wireOptionBlock(form, b));
  refreshChoices(form, base.choice);
  form.querySelector('[data-add-option]').onclick = () => addOptionBlock(form);
  form.querySelector('[data-close]').onclick = () => d.close();
  form.onsubmit = e => {
    e.preventDefault();
    const fd = new FormData(form);
    const title = fd.get('title').trim();
    if (!title) {
      toast('Give the decision a title.');
      return;
    }
    const decision = {
      id: existing ? existing.id : `ADR-${String(project.decisions.length + 1).padStart(3, '0')}`,
      date: existing?.date || new Date().toISOString().slice(0, 10),
      title,
      context: fd.get('context').trim(),
      reversibility: fd.get('reversibility'),
      options: readOptions(form),
      choice: form.querySelector('#choiceSelect').value,
      rationale: fd.get('rationale').trim(),
      status: fd.get('status'),
    };
    if (decision.choice && decision.status === 'proposed') decision.status = 'decided';
    if (existing) Object.assign(existing, decision);
    else project.decisions.push(decision);
    logActivity(
      project,
      'decision',
      `${decision.id} ${
        decision.status === 'decided'
          ? `decided: ${decision.choice}`
          : existing
          ? 'updated'
          : 'proposed'
      } — ${decision.title}`,
      decision.id
    );
    save();
    if (decision.status === 'decided' && window.desktopApi?.writeAdrFile) {
      const md = compileDecisionToMarkdown(decision);
      window.desktopApi.writeAdrFile(decision.id, decision.title, md).then(res => {
        if (res && !res.ok) console.warn('ADR sync failed:', res.error);
      });
    }
    d.close();
    renderAll();
    toast(existing ? 'Decision updated.' : 'Decision added.');
  };
  d.showModal();
}
function renderQuestions() {
  const project = activeProject();
  const el = $('#questionsView');
  el.innerHTML = `<div class="view-head"><div><p class="eyebrow">CONTEXT QUEUE</p><h1>Open questions</h1><p class="subcopy">Questions remain visible in briefs until someone resolves them.</p></div><button class="button primary" id="addQuestion">+ Question</button></div><div class="list-card">${project.questions
    .map(
      q =>
        `<article class="list-row"><span class="question-lane">${
          q.lane
        } needs to decide</span><strong>${esc(
          q.text
        )}</strong><p><button class="button" data-resolve="${q.id}">${
          q.resolved ? 'Reopen' : 'Resolve'
        }</button></p></article>`
    )
    .join('')}</div>`;
  $('#addQuestion').onclick = () => openSimpleForm('question');
  el.querySelectorAll('[data-resolve]').forEach(
    b =>
      (b.onclick = () => {
        const q = project.questions.find(q => q.id === b.dataset.resolve);
        q.resolved = !q.resolved;
        logActivity(
          project,
          'question',
          `${q.id} ${q.resolved ? 'resolved' : 'reopened'}: ${q.text.slice(0, 60)}`,
          q.id
        );
        save();
        renderAll();
      })
  );
}

// --- Home / mission control -------------------------------------------------
function timeAgo(ts) {
  if (!ts) return '';
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (!isFinite(s) || s < 0) return '';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
function projectStats(p) {
  const done = p.tickets.filter(t => t.status === 'done').length;
  return {
    done,
    total: p.tickets.length,
    pct: p.tickets.length ? Math.round((done / p.tickets.length) * 100) : 0,
    proposed: p.decisions.filter(d => d.status === 'proposed').length,
    decided: p.decisions.filter(d => d.status === 'decided').length,
    questions: p.questions.filter(q => !q.resolved).length,
    msDone: (p.milestones || []).filter(m => m.status === 'done').length,
    msTotal: (p.milestones || []).length,
    diagrams: (p.diagrams || []).length,
    lastTs: (p.activity || []).at(-1)?.ts || '',
  };
}
function switchAndView(projectId, view) {
  switchProject(projectId);
  setView(view);
}
function homeProjectCard(p) {
  const s = projectStats(p);
  const attention = [
    s.proposed
      ? `<span class="chip" style="border-color:#e4ae46;color:#9c6813">◇ ${s.proposed} to decide</span>`
      : '',
    s.questions
      ? `<span class="chip" style="border-color:#b3a5ea;color:#5b47c9">? ${s.questions} open</span>`
      : '',
  ].join(' ');
  return `<article class="home-card" data-status-project="${esc(p.id)}">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px"><div><span class="list-meta">${esc(
      p.code || p.id
    )}${
    s.lastTs ? ` · active ${timeAgo(s.lastTs)}` : ''
  }</span><h3 style="margin:4px 0 2px;font-size:16px;letter-spacing:-.4px">${esc(
    p.name
  )}</h3></div><button class="button primary" data-open-project="${esc(p.id)}">Open →</button></div>
    ${
      p.description
        ? `<p class="list-meta" style="font:12px Manrope;color:var(--muted);margin:4px 0 0;line-height:1.5">${esc(
            p.description.slice(0, 110)
          )}${p.description.length > 110 ? '…' : ''}</p>`
        : ''
    }
    <div class="progress-track" style="margin:12px 0 6px"><i style="width:${s.pct}%"></i></div>
    <p class="list-meta" style="margin:0">⌘ ${s.done}/${s.total} tickets · 🏁 ${s.msDone}/${
    s.msTotal
  } milestones · ◇ ${s.decided} decided · 🏗 ${s.diagrams} diagrams</p>
    ${attention.trim() ? `<p style="margin:8px 0 0">${attention}</p>` : ''}
  </article>`;
}
function homeInboxRows() {
  const rows = [];
  workspace.projects.forEach(p => {
    p.decisions
      .filter(d => d.status === 'proposed')
      .forEach(d =>
        rows.push({
          p,
          kind: 'decision',
          id: d.id,
          text: d.title,
          extra: `${(d.options || []).length} option(s)${
            d.source === 'agent' ? ' · 🤖 agent' : ''
          }`,
        })
      );
    p.questions
      .filter(q => !q.resolved && q.lane === 'human')
      .forEach(q =>
        rows.push({ p, kind: 'question', id: q.id, text: q.text, extra: 'awaiting you' })
      );
  });
  return rows;
}
function allActivity() {
  const events = [];
  workspace.projects.forEach(p =>
    (p.activity || []).forEach(e => events.push({ ...e, projectId: p.id, projectName: p.name }))
  );
  return events.sort((a, b) => (b.ts < a.ts ? -1 : 1));
}
function renderHome() {
  const el = $('#homeView');
  if (!el) return;
  const inbox = homeInboxRows();
  const events = allActivity().slice(0, 20);
  const fresh = events.filter(e => LAST_VISIT && e.ts > LAST_VISIT).length;
  const catchup = LAST_VISIT
    ? fresh
      ? `<strong>${fresh} new event${fresh > 1 ? 's' : ''} since your last visit.</strong>`
      : 'Nothing new since your last visit.'
    : 'First visit — the timeline fills as you and your agents work.';
  const prompts = [...(workspace.prompts || [])].sort(
    (a, b) => estTokens(a.text) - estTokens(b.text)
  );
  el.innerHTML = `<div class="view-head"><div><p class="eyebrow">MISSION CONTROL</p><h1>Welcome back, Tech Lead.</h1><p class="subcopy">${catchup}</p></div><div style="display:flex;gap:8px"><button class="button" id="exportStatusPage">Export status page</button><button class="button primary" id="homeAddProject">+ Project</button></div></div>
  <div class="field" style="margin:16px 0 6px"><input id="homeSearch" placeholder="Search every project — tickets, decisions, milestones, questions…" style="width:100%;border:1px solid var(--line);border-radius:8px;padding:11px 13px;font:13px Manrope;background:#fff"></div>
  <div id="homeSearchResults"></div>
  <div class="home-grid">${
    workspace.projects.map(homeProjectCard).join('') ||
    '<p class="subcopy">No projects yet — create one to begin.</p>'
  }</div>
  <div class="home-cols">
    <section><h2 style="margin:22px 0 10px">⚑ Needs your call${
      inbox.length ? ` <em class="chip" style="font-style:normal">${inbox.length}</em>` : ''
    }</h2><div class="list-card">${
    inbox
      .map(
        r =>
          `<article class="list-row" style="padding:12px 16px"><span class="list-meta">${esc(
            r.p.code || r.p.id
          )} · ${esc(r.id)} · ${esc(r.extra)}</span><strong style="font-size:13px">${
            r.kind === 'decision' ? '◇' : '?'
          } ${esc(
            r.text
          )}</strong><p style="margin:6px 0 0"><button class="button" data-inbox="${esc(r.p.id)}:${
            r.kind
          }:${esc(r.id)}">${
            r.kind === 'decision' ? '⚖ Explore & decide' : 'Resolve'
          }</button></p></article>`
      )
      .join('') ||
    '<p style="padding:14px 16px;color:var(--muted)">Inbox zero — nothing awaiting a decision.</p>'
  }</div></section>
    <section><h2 style="margin:22px 0 10px">🕘 Timeline</h2><div class="list-card" style="max-height:420px;overflow:auto">${
      events
        .map(
          e =>
            `<article class="list-row" style="padding:10px 16px"><span class="list-meta">${esc(
              e.projectId
            )} · ${esc((e.ts || '').slice(0, 16).replace('T', ' '))} ${
              LAST_VISIT && e.ts > LAST_VISIT
                ? '<span class="chip" style="border-color:#7bbd92;color:#257453">new</span>'
                : ''
            }</span><p style="margin:3px 0 0;color:var(--ink);font-size:12.5px">${esc(
              e.text
            )}</p></article>`
        )
        .join('') || '<p style="padding:14px 16px;color:var(--muted)">No activity recorded yet.</p>'
    }</div></section>
  </div>
  <section><h2 style="margin:26px 0 4px">⌁ Prompt library</h2><p class="subcopy" style="margin-bottom:10px">Reusable high-performing prompts, cheapest first (≈4 chars/token estimate). Copy increments the use counter.</p><div class="home-grid">${
    prompts
      .map(
        pr =>
          `<article class="home-card"><div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start"><div><span class="list-meta">${esc(
            pr.id
          )}${pr.model ? ` · ${esc(pr.model)}` : ''} · used ${
            pr.uses
          }×</span><h3 style="margin:4px 0 2px;font-size:14px">${esc(
            pr.name
          )}</h3></div><span class="chip" title="Estimated input tokens (~4 chars/token)${
            pr.outTokens ? `, typical output ${pr.outTokens}` : ''
          }">≈${estTokens(pr.text)} in${
            pr.outTokens ? ` / ${pr.outTokens} out` : ''
          } tok</span></div><p class="prompt-preview">${esc(pr.text.slice(0, 160))}${
            pr.text.length > 160 ? '…' : ''
          }</p>${
            pr.notes
              ? `<p class="list-meta" style="font:11px Manrope;color:var(--muted)">${esc(
                  pr.notes
                )}</p>`
              : ''
          }<p style="margin:10px 0 0;display:flex;gap:6px"><button class="button primary" data-copy-prompt="${esc(
            pr.id
          )}">Copy</button><button class="button" data-edit-prompt="${esc(
            pr.id
          )}">Edit</button><button class="button danger" data-del-prompt="${esc(
            pr.id
          )}">Delete</button></p></article>`
      )
      .join('') || '<p class="subcopy">No prompts saved yet.</p>'
  }<article class="home-card" style="display:flex;align-items:center;justify-content:center;min-height:120px;border-style:dashed"><button class="button" id="addPrompt">+ Add prompt</button></article></div></section>`;
  $('#homeAddProject').onclick = () => addProject();
  $('#exportStatusPage').onclick = () => exportStatusPage();
  $('#addPrompt').onclick = () => openPromptForm();
  el.querySelectorAll('[data-open-project]').forEach(
    b =>
      (b.onclick = e => {
        e.stopPropagation();
        switchAndView(b.dataset.openProject, 'map');
      })
  );
  el.querySelectorAll('[data-status-project]').forEach(
    card =>
      (card.onclick = e => {
        if (e.target.closest('button')) return;
        const p = projectById(card.dataset.statusProject);
        if (p) openProjectStatus(p);
      })
  );
  el.querySelectorAll('[data-inbox]').forEach(
    b =>
      (b.onclick = () => {
        const [pid, kind, id] = b.dataset.inbox.split(':');
        const p = projectById(pid);
        if (!p) return;
        if (kind === 'decision') {
          switchProject(pid);
          setView('decisions');
          const d = p.decisions.find(x => x.id === id);
          if (d) openDecisionExplore(d);
        } else {
          const q = p.questions.find(x => x.id === id);
          if (q) {
            q.resolved = true;
            logActivity(p, 'question', `${q.id} resolved: ${q.text.slice(0, 60)}`, q.id);
            save();
            renderAll();
            toast(`${id} resolved.`);
          }
        }
      })
  );
  el.querySelectorAll('[data-copy-prompt]').forEach(
    b =>
      (b.onclick = async () => {
        const pr = workspace.prompts.find(x => x.id === b.dataset.copyPrompt);
        if (!pr) return;
        try {
          await navigator.clipboard.writeText(pr.text);
          pr.uses++;
          save();
          renderHome();
          toast('Prompt copied.');
        } catch {
          openTextDialog(pr.name, pr.text);
        }
      })
  );
  el.querySelectorAll('[data-edit-prompt]').forEach(
    b =>
      (b.onclick = () => openPromptForm(workspace.prompts.find(x => x.id === b.dataset.editPrompt)))
  );
  el.querySelectorAll('[data-del-prompt]').forEach(
    b =>
      (b.onclick = () => {
        const pr = workspace.prompts.find(x => x.id === b.dataset.delPrompt);
        if (pr && confirm(`Delete prompt "${pr.name}"?`)) {
          workspace.prompts = workspace.prompts.filter(x => x !== pr);
          save();
          renderHome();
        }
      })
  );
  const search = $('#homeSearch');
  search.oninput = () => renderHomeSearch(search.value);
}
function quickSearchAll(query) {
  const terms = String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length > 1);
  if (!terms.length) return [];
  const hits = [];
  workspace.projects.forEach(p => {
    const push = (kind, id, title, text) => {
      const hay = (title + ' ' + text).toLowerCase();
      let score = 0;
      terms.forEach(t => {
        if (title.toLowerCase().includes(t)) score += 2;
        else if (hay.includes(t)) score += 1;
      });
      if (score >= Math.min(terms.length, 2))
        hits.push({ projectId: p.id, kind, id, title, score });
    };
    p.tickets.forEach(t => push('ticket', t.id, t.title, `${t.description} ${t.technicalNotes}`));
    p.decisions.forEach(d =>
      push(
        'decision',
        d.id,
        d.title,
        `${d.context} ${d.choice} ${(d.options || []).map(o => o.name).join(' ')}`
      )
    );
    (p.milestones || []).forEach(m => push('milestone', m.id, m.title, m.description || ''));
    p.questions.forEach(q => push('question', q.id, q.text, ''));
  });
  return hits.sort((a, b) => b.score - a.score).slice(0, 10);
}
function renderHomeSearch(query) {
  const box = $('#homeSearchResults');
  if (!box) return;
  if (!query || !query.trim()) {
    box.innerHTML = '';
    return;
  }
  const hits = quickSearchAll(query);
  box.innerHTML = hits.length
    ? `<div class="list-card" style="margin:0 0 14px">${hits
        .map(
          h =>
            `<article class="list-row" style="padding:10px 16px;cursor:pointer" data-hit="${esc(
              h.projectId
            )}:${esc(h.kind)}:${esc(h.id)}"><span class="list-meta">${esc(h.projectId)} · ${esc(
              h.kind
            )} · ${esc(h.id)}</span><strong style="font-size:13px">${esc(
              h.title
            )}</strong></article>`
        )
        .join('')}</div>`
    : `<p class="subcopy" style="margin:0 0 14px">No matches across projects.</p>`;
  box.querySelectorAll('[data-hit]').forEach(
    row =>
      (row.onclick = () => {
        const [pid, kind, id] = row.dataset.hit.split(':');
        switchProject(pid);
        if (kind === 'ticket') {
          setView('map');
          select(id);
        } else if (kind === 'decision') {
          setView('decisions');
          const d = projectById(pid)?.decisions.find(x => x.id === id);
          if (d) openDecisionExplore(d);
        } else setView(kind === 'milestone' ? 'milestones' : 'questions');
      })
  );
}
function openProjectStatus(p) {
  const s = projectStats(p);
  const next = p.tickets.find(
    t =>
      t.status !== 'done' &&
      (t.deps || []).every(id => p.tickets.find(x => x.id === id)?.status === 'done')
  );
  const proposed = p.decisions.filter(d => d.status === 'proposed');
  const lastMs = [...(p.milestones || [])].filter(m => m.status === 'done').at(-1);
  const recent = (p.activity || []).slice(-8).reverse();
  const d = $('#reportDialog');
  d.innerHTML = `<div class="dialog-body"><span class="list-meta">${esc(
    p.code || p.id
  )} · CURRENT STATUS</span><h2 style="margin:6px 0 12px">${esc(p.name)}</h2>
  <div class="progress-track" style="margin:0 0 8px"><i style="width:${s.pct}%"></i></div>
  <p class="list-meta" style="margin:0 0 14px">${s.done}/${s.total} tickets done (${s.pct}%) · ${
    s.msDone
  }/${s.msTotal} milestones · ${s.decided} decisions settled</p>
  ${
    next
      ? `<div class="ai-panel" style="margin-bottom:12px"><div><strong>Next unblocked ticket</strong><p>${esc(
          next.id
        )} — ${esc(next.title)}</p></div></div>`
      : '<p class="subcopy">All tickets complete.</p>'
  }
  ${
    lastMs
      ? `<p style="margin:6px 0"><strong>Latest milestone:</strong> ${esc(lastMs.id)} ${esc(
          lastMs.title
        )}${lastMs.date ? ` (${esc(lastMs.date)})` : ''}</p>`
      : ''
  }
  ${
    proposed.length
      ? `<p style="margin:6px 0;color:#9c6813"><strong>◇ ${proposed.length} decision${
          proposed.length > 1 ? 's' : ''
        } awaiting you:</strong> ${proposed.map(x => esc(x.id)).join(', ')}</p>`
      : ''
  }
  ${
    s.questions
      ? `<p style="margin:6px 0;color:#5b47c9"><strong>? ${s.questions} open question${
          s.questions > 1 ? 's' : ''
        }.</strong></p>`
      : ''
  }
  <h3 style="font:10px 'DM Mono';letter-spacing:.1em;color:#77857e;margin:16px 0 6px">RECENT ACTIVITY</h3>
  ${
    recent.length
      ? recent
          .map(
            e =>
              `<p style="margin:4px 0;font-size:12px"><span class="list-meta">${esc(
                (e.ts || '').slice(0, 10)
              )}</span> ${esc(e.text)}</p>`
          )
          .join('')
      : '<p class="subcopy">No activity recorded yet.</p>'
  }
  <div class="dialog-actions"><button class="button" data-close>Close</button><button class="button primary" data-open>Open workspace</button></div></div>`;
  d.querySelector('[data-close]').onclick = () => d.close();
  d.querySelector('[data-open]').onclick = () => {
    d.close();
    switchAndView(p.id, 'map');
  };
  d.showModal();
}
function openPromptForm(existing) {
  const d = $('#questionDialog');
  const pr = existing || { name: '', model: '', text: '', notes: '', outTokens: 0 };
  d.innerHTML = `<form class="dialog-body"><h2>${
    existing ? 'Edit' : 'Add'
  } prompt</h2><p class="subcopy">Track your best prompts and their token cost so cheap, high-performing ones are easy to find.</p><div class="form-grid"><div class="field"><label>Name</label><input name="name" value="${esc(
    pr.name
  )}" required></div><div class="field"><label>Model (optional)</label><input name="model" value="${esc(
    pr.model
  )}" placeholder="e.g. grok-4"></div></div><div class="field"><label>Prompt text</label><textarea name="text" style="min-height:160px" required>${esc(
    pr.text
  )}</textarea></div><div class="form-grid"><div class="field"><label>Typical output tokens (optional)</label><input name="outTokens" type="number" min="0" value="${
    pr.outTokens || ''
  }"></div><div class="field"><label>Notes (what it's good at)</label><input name="notes" value="${esc(
    pr.notes
  )}"></div></div><div class="dialog-actions"><button class="button" type="button" data-close>Cancel</button><button class="button primary">Save prompt</button></div></form>`;
  d.querySelector('[data-close]').onclick = () => d.close();
  d.querySelector('form').onsubmit = e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const item = {
      name: f.get('name').trim(),
      model: f.get('model').trim(),
      text: f.get('text'),
      notes: f.get('notes').trim(),
      outTokens: Number(f.get('outTokens')) || 0,
      updated: new Date().toISOString().slice(0, 10),
    };
    if (existing) Object.assign(existing, item);
    else {
      const max = workspace.prompts.reduce((a, x) => {
        const m = String(x.id).match(/^PR-(\d+)$/);
        return m ? Math.max(a, Number(m[1])) : a;
      }, 0);
      workspace.prompts.push({ id: `PR-${String(max + 1).padStart(3, '0')}`, uses: 0, ...item });
    }
    save();
    d.close();
    renderHome();
    toast('Prompt saved.');
  };
  d.showModal();
}
function exportStatusPage() {
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const proj = p => {
    const s = projectStats(p);
    return `<section style="border:1px solid #dce2dc;border-radius:10px;padding:20px;margin:14px 0;background:#fff"><h2 style="margin:0 0 4px">${esc(
      p.name
    )} <small style="color:#82908a;font-weight:400">${esc(p.code || p.id)}</small></h2>${
      p.description ? `<p style="color:#63716b;margin:4px 0 10px">${esc(p.description)}</p>` : ''
    }<p><strong>${s.done}/${s.total}</strong> tickets done (${s.pct}%) · <strong>${s.msDone}/${
      s.msTotal
    }</strong> milestones · <strong>${s.decided}</strong> decisions settled${
      s.proposed
        ? ` · <span style="color:#9c6813"><strong>${s.proposed}</strong> awaiting decision</span>`
        : ''
    }${
      s.questions
        ? ` · <span style="color:#5b47c9"><strong>${s.questions}</strong> open questions</span>`
        : ''
    }</p>${
      (p.milestones || []).length
        ? `<h3 style="font-size:13px;margin:12px 0 4px">Milestones</h3><ul style="margin:0;padding-left:18px">${p.milestones
            .map(
              m =>
                `<li>${m.status === 'done' ? '✅' : '⬜'} ${esc(m.title)}${
                  m.date ? ` <small style="color:#82908a">${esc(m.date)}</small>` : ''
                }</li>`
            )
            .join('')}</ul>`
        : ''
    }${
      p.decisions.filter(d => d.status === 'decided').length
        ? `<h3 style="font-size:13px;margin:12px 0 4px">Decided</h3><ul style="margin:0;padding-left:18px">${p.decisions
            .filter(d => d.status === 'decided')
            .map(d => `<li><strong>${esc(d.id)}</strong> ${esc(d.title)} → ${esc(d.choice)}</li>`)
            .join('')}</ul>`
        : ''
    }</section>`;
  };
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DevTracker status · ${esc(
    now
  )}</title></head><body style="margin:0;background:#f5f6f2;color:#172521;font:14px/1.6 -apple-system,Segoe UI,sans-serif"><main style="max-width:840px;margin:0 auto;padding:32px 20px"><h1 style="letter-spacing:-1px">DevTracker — Status</h1><p style="color:#63716b">Generated ${esc(
    now
  )} · read-only snapshot · contains no chat logs, prompts, or API keys</p>${workspace.projects
    .map(proj)
    .join('')}</main></body></html>`;
  const blob = new Blob([html], { type: 'text/html' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `devtracker-status-${new Date().toISOString().slice(0, 10)}.html`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Status page exported — share the HTML file anywhere.');
}

function loadProjectContext() {
  if (projectContextCache) {
    return Promise.resolve(projectContextCache);
  }

  if (window.desktopApi?.readFile) {
    return window.desktopApi.readFile('docs/PROJECT_CONTEXT.md').then(text => {
      projectContextCache = text;
      return text;
    });
  }

  return fetch('docs/PROJECT_CONTEXT.md').then(async res => {
    if (!res.ok) throw new Error(res.statusText);
    const text = await res.text();
    projectContextCache = text;
    return text;
  });
}

function renderContext() {
  const el = $('#contextView');
  if (!el) return;
  const project = activeProject();
  const cons = project?.constraints || [];
  el.innerHTML = `<div class="view-head"><div><p class="eyebrow">PROJECT CONTEXT</p><h1>Project context</h1><p class="subcopy">Project-level vision, architecture, and sprint plans live here.</p></div></div>
  <div class="list-card" style="margin-bottom:16px"><div style="padding:16px 18px"><h3 style="font:10px 'DM Mono';letter-spacing:.1em;color:#77857e;margin:0 0 4px">STANDING CONSTRAINTS — TRAVEL WITH EVERY BRIEF &amp; AGENT BRIEFING</h3><p class="subcopy" style="margin:0 0 10px;max-width:none">Durable project rules agents must respect ("privacy-first, no telemetry", "vanilla JS only"). Included in session briefs, agent chat, and the <code>get_briefing</code> MCP tool.</p>
  ${
    cons
      .map(
        c =>
          `<p style="display:flex;gap:8px;align-items:center;margin:6px 0"><input type="checkbox" data-con-toggle="${esc(
            c.id
          )}" ${c.active ? 'checked' : ''} title="Active"><span style="flex:1;${
            c.active ? '' : 'color:#9aa7a0;text-decoration:line-through'
          }">${esc(
            c.text
          )}</span><button class="button danger" style="padding:3px 8px" data-con-del="${esc(
            c.id
          )}">✕</button></p>`
      )
      .join('') || '<p class="subcopy">No constraints yet.</p>'
  }
  <form data-con-form style="display:flex;gap:8px;margin-top:10px"><input placeholder="Add a standing constraint…" style="flex:1;border:1px solid var(--line);border-radius:6px;padding:9px;font:13px Manrope"><button class="button primary">Add</button></form></div></div>
  <div class="list-card"><pre class="context-doc">Loading project context…</pre></div>`;
  el.querySelectorAll('[data-con-toggle]').forEach(
    cb =>
      (cb.onchange = () => {
        const c = project.constraints.find(x => x.id === cb.dataset.conToggle);
        if (c) {
          c.active = cb.checked;
          save();
          renderContext();
        }
      })
  );
  el.querySelectorAll('[data-con-del]').forEach(
    b =>
      (b.onclick = () => {
        project.constraints = project.constraints.filter(x => x.id !== b.dataset.conDel);
        save();
        renderContext();
      })
  );
  const conForm = el.querySelector('[data-con-form]');
  conForm.onsubmit = e => {
    e.preventDefault();
    const input = conForm.querySelector('input');
    const text = input.value.trim();
    if (!text) return;
    const max = project.constraints.reduce((a, x) => {
      const m = String(x.id).match(/^CON-(\d+)$/);
      return m ? Math.max(a, Number(m[1])) : a;
    }, 0);
    project.constraints.push({ id: `CON-${String(max + 1).padStart(3, '0')}`, text, active: true });
    logActivity(project, 'constraint', `Constraint added: ${text.slice(0, 70)}`, '');
    input.value = '';
    save();
    renderContext();
    toast('Constraint added — it now rides along in every brief.');
  };
  const contentEl = el.querySelector('.context-doc');
  loadProjectContext()
    .then(text => {
      contentEl.textContent = text;
    })
    .catch(() => {
      el.querySelector(
        '.list-card'
      ).innerHTML = `<p>Unable to load project context from <code>docs/PROJECT_CONTEXT.md</code>.</p><p><a href="docs/PROJECT_CONTEXT.md" target="_blank">Open the file directly</a>.</p>`;
    });
}

function localAiPlaceholder(prompt) {
  return `Local AI placeholder:\n\n${String(prompt).split('\n').slice(0, 6).join('\n')}`;
}

// --- OrchestratorLLM smart routing --------------------------------------------
// A provider is usable if it's the built-in local draft or a fully-configured
// hosted endpoint. Each is tagged with routing metadata for the registry.
function usableProviders() {
  return aiSettings.providers
    .filter(p => p.type === 'local' || (p.endpoint && p.apiKey))
    .map(p => ({
      id: p.id,
      endpoint: p.endpoint || '',
      apiKey: p.apiKey || '',
      model: p.model || '',
      tier: p.tier || (p.type === 'local' ? 'cheap' : PROVIDER_CAP_DEFAULTS.tier),
      location: p.location || (p.type === 'local' ? 'local' : PROVIDER_CAP_DEFAULTS.location),
      sensitivityOK: p.sensitivityOK != null ? !!p.sensitivityOK : p.type === 'local',
      costPer1k: Number.isFinite(p.costPer1k)
        ? p.costPer1k
        : p.type === 'local'
        ? 0
        : PROVIDER_CAP_DEFAULTS.costPer1k,
      enabled: true,
    }));
}
async function orchCallModel(provider, payload) {
  // The built-in local draft has no endpoint — serve the placeholder as its "model".
  if (provider.location === 'local' && !provider.endpoint) {
    const content = localAiPlaceholder(payload.messages?.map(m => m.content).join('\n') || '');
    return {
      content,
      tokensIn: estTokens(JSON.stringify(payload.messages || '')),
      tokensOut: estTokens(content),
    };
  }
  const data = await aiHttp(provider, payload);
  const content = data.choices?.[0]?.message?.content || data.output_text || data.result || '';
  return { content, tokensIn: data.usage?.prompt_tokens, tokensOut: data.usage?.completion_tokens };
}
function smartRoutingActive() {
  return aiSettings.smartRouting && usableProviders().length >= 2;
}
async function routedAiText(prompt, opts) {
  const providers = usableProviders();
  const payload = {
    messages: [
      { role: 'system', content: 'You are an expert software architect and writing assistant.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.2,
  };
  const out = await orchestrate(
    {
      task: { taskType: opts.task || '', text: prompt, hint: { sensitivity: opts.sensitivity } },
      payload,
      providers,
      verifySpec: opts.verifySpec || { minLen: 1 },
    },
    { callModel: orchCallModel, policy: aiSettings.privacyPolicy || 'hard' }
  );
  const r = out.routing;
  if (!r.chosen) {
    const reason = r.needsConsent
      ? 'privacy: sensitive task needs consent for a hosted model'
      : r.reason || 'no provider qualifies';
    toast(`Smart routing: ${reason} — using local draft.`);
    return localAiPlaceholder(prompt);
  }
  const provName = aiSettings.providers.find(p => p.id === r.chosen)?.name || r.chosen;
  const proj = activeProject();
  if (proj)
    logActivity(
      proj,
      'route',
      `${opts.task || 'task'} → ${provName} [${out.classification.class}]${
        r.escalations ? ` after ${r.escalations} escalation(s)` : ''
      } · ~${r.tokensIn + r.tokensOut} tok${r.estCost ? ` · ~$${r.estCost}` : ' · free'}`,
      ''
    );
  toast(
    `Routed ${out.classification.class} → ${provName}${
      r.escalations ? ` (escalated ${r.escalations}×)` : ''
    }${r.estCost ? ` · ~$${r.estCost}` : ' · free'}`
  );
  return out.content;
}
function requestAiText(prompt, opts = {}) {
  if (smartRoutingActive()) return routedAiText(prompt, opts);
  const provider = activeProvider();
  if (provider.type === 'local' || !provider.apiKey || !provider.endpoint) {
    return Promise.resolve(localAiPlaceholder(prompt));
  }
  const payload = {
    messages: [
      { role: 'system', content: 'You are an expert software architect and writing assistant.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.2,
  };
  if (provider.model) payload.model = provider.model;
  return aiHttp(provider, payload).then(
    data => data.choices?.[0]?.message?.content || data.output_text || data.result || ''
  );
}

function nextDiagramId(project) {
  const max = (project.diagrams || []).reduce((a, g) => {
    const m = String(g.id).match(/^DGM-(\d+)$/);
    return m ? Math.max(a, Number(m[1])) : a;
  }, 0);
  return `DGM-${String(max + 1).padStart(3, '0')}`;
}
function diagramCard(g) {
  const openBtns =
    g.format === 'drawio'
      ? `<button class="button" data-dgm-drawio="${esc(g.id)}">Open in diagrams.net</button>`
      : g.format === 'excalidraw'
      ? `<button class="button" data-dgm-external="${esc(g.id)}">Open in Excalidraw</button>`
      : `<button class="button" data-dgm-external="${esc(g.id)}">Open in external editor</button>`;
  return `<article class="diagram-card"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><div><span class="list-meta">${esc(
    g.id
  )} · ${esc(g.format)}${
    g.updated ? ` · ${esc(g.updated)}` : ''
  }</span><h3 style="margin:2px 0 0;font-size:14px">${esc(
    g.name
  )}</h3></div><select data-dgm-kind="${esc(
    g.id
  )}" style="border:1px solid var(--line);border-radius:6px;padding:6px;font:11px 'DM Mono'">${Object.entries(
    DIAGRAM_KINDS
  )
    .map(([k, label]) => `<option value="${k}"${g.kind === k ? ' selected' : ''}>${label}</option>`)
    .join('')}</select></div>
  <div class="diagram-preview">${diagramPreviewHtml(g)}</div>
  <textarea data-dgm-desc="${esc(
    g.id
  )}" placeholder="What does this diagram show? (feeds the AI review)" style="width:100%;min-height:56px;border:1px solid var(--line);border-radius:6px;padding:8px;font:12px Manrope;resize:vertical">${esc(
    g.description
  )}</textarea>
  <p style="margin:8px 0 0;display:flex;gap:6px;flex-wrap:wrap">${openBtns}<button class="button" data-dgm-download="${esc(
    g.id
  )}">Download</button><button class="button danger" data-dgm-delete="${esc(
    g.id
  )}">Delete</button></p></article>`;
}
function diagramPreviewHtml(g) {
  if (g.format === 'image' || String(g.content).startsWith('data:image')) {
    return `<img src="${g.content}" alt="${esc(
      g.name
    )}" style="max-width:100%;height:auto;border-radius:6px">`;
  }
  if (g.format === 'svg') {
    const safe = sanitizeSvg(g.content);
    return safe
      ? `<div class="svg-preview">${safe}</div>`
      : '<p class="subcopy">SVG could not be previewed safely.</p>';
  }
  if (g.format === 'excalidraw') {
    const svg = excalidrawToSvg(g.content);
    return (
      svg ||
      '<p class="subcopy">Excalidraw scene detected — preview unavailable; open it in Excalidraw.</p>'
    );
  }
  if (g.format === 'drawio') {
    return `<div class="diagram-placeholder"><strong>draw.io diagram</strong><p class="list-meta" style="font:11px Manrope">Stored as source XML — open it in diagrams.net to view and edit.</p></div>`;
  }
  return `<pre style="white-space:pre-wrap;max-height:200px;overflow:auto;font:11px 'DM Mono';margin:0">${esc(
    String(g.content).slice(0, 1500)
  )}${String(g.content).length > 1500 ? '\n…truncated' : ''}</pre>`;
}
// Naive offline renderer for .excalidraw scenes: enough to preview boxes,
// arrows, and labels without shipping the Excalidraw runtime.
function excalidrawToSvg(content) {
  try {
    const data = JSON.parse(content);
    const els = (data.elements || []).filter(e => e && !e.isDeleted);
    if (!els.length) return null;
    const num = v => Number(v) || 0;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    els.forEach(e => {
      const x = num(e.x),
        y = num(e.y),
        w = num(e.width),
        h = num(e.height);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w);
      maxY = Math.max(maxY, y + h);
    });
    const pad = 24,
      W = Math.max(maxX - minX + pad * 2, 60),
      H = Math.max(maxY - minY + pad * 2, 60);
    const col = c => (/^#[0-9a-f]{3,8}$/i.test(String(c || '')) ? c : '#3d4a44');
    const parts = els.map(e => {
      const x = num(e.x) - minX + pad,
        y = num(e.y) - minY + pad,
        w = num(e.width),
        h = num(e.height);
      const stroke = col(e.strokeColor),
        bg =
          e.backgroundColor &&
          e.backgroundColor !== 'transparent' &&
          /^#[0-9a-f]{3,8}$/i.test(e.backgroundColor)
            ? e.backgroundColor
            : 'none';
      switch (e.type) {
        case 'rectangle':
          return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${bg}" stroke="${stroke}" stroke-width="1.5"/>`;
        case 'ellipse':
          return `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${Math.abs(
            w / 2
          )}" ry="${Math.abs(h / 2)}" fill="${bg}" stroke="${stroke}" stroke-width="1.5"/>`;
        case 'diamond':
          return `<polygon points="${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${
            y + h
          } ${x},${y + h / 2}" fill="${bg}" stroke="${stroke}" stroke-width="1.5"/>`;
        case 'line':
        case 'arrow':
        case 'freedraw':
        case 'draw': {
          const pts = (e.points || []).map(p => `${x + num(p[0])},${y + num(p[1])}`);
          if (pts.length < 2) return '';
          let head = '';
          if (e.type === 'arrow') {
            const [ax, ay] = pts.at(-1).split(',').map(Number),
              [bx, by] = pts.at(-2).split(',').map(Number);
            const ang = Math.atan2(ay - by, ax - bx),
              L = 9;
            head = `<polygon points="${ax},${ay} ${ax - L * Math.cos(ang - 0.4)},${
              ay - L * Math.sin(ang - 0.4)
            } ${ax - L * Math.cos(ang + 0.4)},${ay - L * Math.sin(ang + 0.4)}" fill="${stroke}"/>`;
          }
          return (
            `<polyline points="${pts.join(
              ' '
            )}" fill="none" stroke="${stroke}" stroke-width="1.5"/>` + head
          );
        }
        case 'text': {
          const size = num(e.fontSize) || 16;
          return String(e.text || '')
            .split('\n')
            .map(
              (ln, i) =>
                `<text x="${x}" y="${
                  y + size * (i + 0.9)
                }" style="font:${size}px Manrope,sans-serif;fill:${stroke}">${esc(ln)}</text>`
            )
            .join('');
        }
        default:
          return '';
      }
    });
    return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="max-width:100%;height:auto;background:#fff;border-radius:6px">${parts.join(
      ''
    )}</svg>`;
  } catch {
    return null;
  }
}
function detectDiagramFormat(name, content) {
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.svg')) return 'svg';
  if (/\.(png|jpe?g|gif|webp)$/.test(n)) return 'image';
  if (n.endsWith('.excalidraw')) return 'excalidraw';
  if (n.endsWith('.drawio')) return 'drawio';
  const head = String(content || '').slice(0, 400);
  if (head.includes('"type"') && head.includes('excalidraw')) return 'excalidraw';
  if (/mxfile|mxGraphModel/i.test(head)) return 'drawio';
  if (n.endsWith('.json')) return 'excalidraw';
  if (n.endsWith('.xml')) return 'drawio';
  return 'text';
}
function handleDiagramFile(file) {
  const project = activeProject();
  if (!project) return;
  const isImage = /\.(png|jpe?g|gif|webp)$/i.test(file.name);
  const reader = new FileReader();
  reader.onload = () => {
    const content = reader.result;
    const format = isImage ? 'image' : detectDiagramFormat(file.name, content);
    const guessKind = /flow|dfd/i.test(file.name)
      ? 'dataflow'
      : /seq/i.test(file.name)
      ? 'sequence'
      : /erd|entity/i.test(file.name)
      ? 'erd'
      : 'architecture';
    project.diagrams.push(
      normalizeDiagram(
        {
          id: nextDiagramId(project),
          name: file.name,
          kind: guessKind,
          format,
          type: file.type || '',
          content,
          updated: new Date().toISOString().slice(0, 10),
        },
        project.diagrams.length
      )
    );
    logActivity(project, 'diagram', `Diagram uploaded: ${file.name}`, '');
    save();
    renderAll();
    toast(`${file.name} added to the diagram gallery.`);
  };
  if (isImage) reader.readAsDataURL(file);
  else reader.readAsText(file);
}
function renderArchitecture() {
  const el = $('#architectureView');
  if (!el) return;
  const project = activeProject();
  const gallery = (project.diagrams || []).map(diagramCard).join('');
  el.innerHTML = `<div class="view-head"><div><p class="eyebrow">DESIGN DIAGRAMS</p><h1>Architecture &amp; design diagrams</h1><p class="subcopy">Architecture, data-flow, sequence and other diagrams — in formats your tools speak (.excalidraw, .drawio, .svg, images). Preview here, edit in Excalidraw or diagrams.net.</p></div><div style="display:flex;gap:8px"><button class="button" id="archUploadBtn">+ Upload diagram</button><button class="button primary" id="archAiEnhance">AI review → improvements</button></div></div>
  <input type="file" id="archInput" accept=".png,.jpg,.jpeg,.gif,.webp,.svg,.drawio,.xml,.excalidraw,.json" style="display:none">
  <div class="diagram-grid">${
    gallery ||
    '<p class="subcopy" style="grid-column:1/-1">No diagrams yet. Upload an .excalidraw, .drawio, .svg, or image export.</p>'
  }</div>`;
  $('#archUploadBtn').onclick = () => $('#archInput').click();
  $('#archInput').onchange = e => {
    const f = e.target.files[0];
    if (f) handleDiagramFile(f);
  };
  $('#archAiEnhance').onclick = () => aiEnhanceArchitecture();
  const byId = id => project.diagrams.find(g => g.id === id);
  el.querySelectorAll('[data-dgm-kind]').forEach(
    s =>
      (s.onchange = () => {
        const g = byId(s.dataset.dgmKind);
        if (g) {
          g.kind = s.value;
          save();
        }
      })
  );
  el.querySelectorAll('[data-dgm-desc]').forEach(
    t =>
      (t.oninput = () => {
        const g = byId(t.dataset.dgmDesc);
        if (g) {
          g.description = t.value;
          save();
        }
      })
  );
  el.querySelectorAll('[data-dgm-drawio]').forEach(
    b =>
      (b.onclick = () => {
        const g = byId(b.dataset.dgmDrawio);
        if (g) openDiagramInDrawio(g);
      })
  );
  el.querySelectorAll('[data-dgm-external]').forEach(
    b =>
      (b.onclick = () => {
        const g = byId(b.dataset.dgmExternal);
        if (g) openDiagramExternal(g);
      })
  );
  el.querySelectorAll('[data-dgm-download]').forEach(
    b =>
      (b.onclick = () => {
        const g = byId(b.dataset.dgmDownload);
        if (g) downloadDiagram(g);
      })
  );
  el.querySelectorAll('[data-dgm-delete]').forEach(
    b =>
      (b.onclick = () => {
        const g = byId(b.dataset.dgmDelete);
        if (g && confirm(`Delete diagram "${g.name}"?`)) {
          project.diagrams = project.diagrams.filter(x => x !== g);
          save();
          renderAll();
        }
      })
  );
}
function downloadDiagram(g) {
  const isDataUrl = String(g.content).startsWith('data:');
  const a = document.createElement('a');
  if (isDataUrl) {
    a.href = g.content;
  } else {
    const blob = new Blob([g.content], { type: g.type || 'text/plain' });
    a.href = URL.createObjectURL(blob);
  }
  a.download = g.name || g.id;
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (!isDataUrl) URL.revokeObjectURL(a.href);
}
async function openDiagramExternal(g) {
  if (window.desktopApi?.openFileInExternalEditor) {
    try {
      const res = await window.desktopApi.openFileInExternalEditor(
        g.name || g.id,
        g.content,
        g.type || (g.format === 'excalidraw' ? 'application/json' : 'application/octet-stream')
      );
      if (res && res.ok) {
        toast(
          g.format === 'excalidraw'
            ? 'Opened — if Excalidraw is not the default app, open excalidraw.com and drop the file in.'
            : 'Opened in your external editor.'
        );
        return;
      }
    } catch (err) {
      console.error(err);
    }
  }
  downloadDiagram(g);
  if (g.format === 'excalidraw' && window.desktopApi?.openExternalUrl)
    window.desktopApi.openExternalUrl('https://excalidraw.com');
  toast(
    g.format === 'excalidraw'
      ? 'File downloaded — drop it into excalidraw.com to edit.'
      : 'File downloaded — open it in your editor.'
  );
}

async function openDiagramInDrawio(g) {
  if (!g || !g.content) {
    toast('No diagram content to open.');
    return;
  }

  if (window.desktopApi?.getDiagramsNetUrl) {
    try {
      const res = await window.desktopApi.getDiagramsNetUrl(g.content);
      if (res && res.ok && res.url) {
        if (window.desktopApi.openExternalUrl) {
          await window.desktopApi.openExternalUrl(res.url);
          toast('Opening diagram in diagrams.net (browser).');
        } else {
          window.open(res.url, '_blank');
        }
        return;
      }
      console.warn('getDiagramsNetUrl failed', res);
    } catch (err) {
      console.error('diagrams URL generation failed', err);
    }
  }

  if (!window.desktopApi?.getDiagramsNetUrl) {
    try {
      await ensurePako();
      if (window.pako) {
        let content = g.content || '';
        // Match main.js: greedy mediatype up to the optional ;base64 marker.
        const dataUrlMatch =
          typeof content === 'string' && content.match(/^data:([^;,]*)(;base64)?,(.*)$/);
        if (dataUrlMatch) {
          const isBase64 = !!dataUrlMatch[2];
          const dataPart = dataUrlMatch[3];
          try {
            content = isBase64
              ? decodeURIComponent(escape(atob(dataPart)))
              : decodeURIComponent(dataPart);
          } catch (_) {
            openTextDialog(
              'Unable to open in diagrams.net',
              'This diagram is stored as encoded/binary data, not raw draw.io XML, so it cannot be opened directly in diagrams.net. Use "Download" and open the file in app.diagrams.net, or re-upload the raw .drawio XML.'
            );
            return;
          }
        }
        const preview = String(content).slice(0, 300).toLowerCase();
        if (
          !(
            preview.includes('<?xml') ||
            preview.includes('<mxfile') ||
            preview.includes('<diagram')
          )
        ) {
          openTextDialog(
            'Unable to open in diagrams.net',
            'The selected file does not appear to be a draw.io (.drawio/.xml) diagram.\n\nPlease make sure you uploaded the raw draw.io XML file (not a PNG/JPEG or compressed/encoded file). You can also download the file and open it manually in app.diagrams.net.'
          );
          return;
        }
        if (
          String(content).length > 200000 &&
          !confirm(
            'The diagram is large and may not open via URL. Would you like to download it instead?'
          )
        ) {
          // proceed, but warn
        }

        // draw.io #R inflates then decodeURIComponent()s the result, so deflate
        // encodeURIComponent(xml) — mirrors the main-process encoder.
        const encoded = encodeURIComponent(content);
        const utf8 =
          typeof TextEncoder !== 'undefined'
            ? new TextEncoder().encode(encoded)
            : (() => {
                const arr = new Uint8Array(encoded.length);
                for (let index = 0; index < encoded.length; index += 1)
                  arr[index] = encoded.charCodeAt(index);
                return arr;
              })();

        const compressed = window.pako.deflateRaw(utf8, { level: 6 });

        const uint8ToBase64 = u8 => {
          const chunkSize = 0x8000;
          let index = 0;
          const length = u8.length;
          let result = '';
          while (index < length) {
            const slice = u8.subarray(index, Math.min(index + chunkSize, length));
            result += String.fromCharCode.apply(null, slice);
            index += chunkSize;
          }
          return btoa(result);
        };

        let b64 = '';
        if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
          b64 = Buffer.from(compressed).toString('base64');
        } else {
          b64 = uint8ToBase64(compressed);
        }

        // Standard base64 (draw.io atob()s it), percent-encoded for the fragment.
        const url = `https://app.diagrams.net/#R${encodeURIComponent(b64)}`;
        window.open(url, '_blank');
        toast('Opening diagram in diagrams.net (browser).');
        return;
      }
    } catch (err) {
      console.error('client-side diagrams.net compression failed', err);
    }
  }

  openDiagramExternal(g);
}

async function aiEnhanceArchitecture() {
  return aiEnhanceArchitectureAgent();
}

function isAgentCommit(entry) {
  const hay = `${entry.author || ''} ${entry.email || ''} ${entry.body || ''}`;
  return AGENT_MARKERS.some(re => re.test(hay));
}
function statBadge(entry) {
  if (entry.additions == null) return '';
  return `<span class="git-stat"><span style="color:#4b8a5a">+${
    entry.additions
  }</span> <span style="color:#b06a52">−${entry.deletions}</span> · ${entry.files} file${
    entry.files === 1 ? '' : 's'
  }</span>`;
}
function renderGitEntries(entries) {
  if (!entries.length) return '<p>No commits found in the repository.</p>';
  const agentCommits = entries.filter(isAgentCommit);
  const hasStats = entries.some(e => e.additions != null);
  const sum = arr =>
    arr.reduce((a, e) => ({ add: a.add + (e.additions || 0), del: a.del + (e.deletions || 0) }), {
      add: 0,
      del: 0,
    });
  const ag = sum(agentCommits),
    all = sum(entries);
  const summary = `<div class="git-summary" style="margin-bottom:14px;padding:12px;border:1px solid var(--line);border-radius:8px"><strong>🤖 Agent contribution</strong><p class="list-meta">${
    agentCommits.length
  } of ${entries.length} commits attributed to an AI agent${
    hasStats
      ? ` · <span style="color:#4b8a5a">+${ag.add}</span> <span style="color:#b06a52">−${ag.del}</span> lines of <span style="color:#4b8a5a">+${all.add}</span> <span style="color:#b06a52">−${all.del}</span> total`
      : ''
  }.</p></div>`;
  const rows = entries
    .map(
      entry =>
        `<article class="list-row"><strong>${esc(entry.subject)}${
          isAgentCommit(entry)
            ? ' <span class="chip" style="border-color:#7b61ff">🤖 agent</span>'
            : ''
        }</strong><p class="list-meta">${esc(entry.hash.slice(0, 7))} · ${esc(
          entry.author
        )} · ${esc(entry.date)} ${statBadge(entry)}</p>${
          entry.body ? `<p>${esc(entry.body)}</p>` : ''
        }</article>`
    )
    .join('');
  return summary + `<div class="git-log">${rows}</div>`;
}

function renderGit() {
  const el = $('#gitView');
  if (!el) return;
  const desktop = !!window.desktopApi?.getGitLog;
  el.innerHTML = `<div class="view-head"><div><p class="eyebrow">GIT HISTORY</p><h1>Repository history</h1><p class="subcopy">Inspect commits and how many lines the AI agent added or removed.</p></div><div>${
    desktop
      ? '<button class="button" id="indexRepoBtn">Index repo → context</button>'
      : '<button class="button" id="gitConfigBtn">Configure repo</button>'
  }</div></div><div class="list-card"><p>Loading git history…</p></div>`;
  const card = el.querySelector('.list-card');
  const cfgBtn = $('#gitConfigBtn');
  if (cfgBtn) cfgBtn.onclick = () => openGitConfig();
  const idxBtn = $('#indexRepoBtn');
  if (idxBtn)
    idxBtn.onclick = async () => {
      const p = activeProject();
      if (!p) return;
      idxBtn.disabled = true;
      idxBtn.textContent = 'Indexing…';
      try {
        const res = await window.desktopApi.indexRepo(p.id);
        if (res && res.ok) toast(`Indexed ${res.indexed} code/doc chunks into ${p.id}'s context.`);
        else toast(`Indexing failed: ${res ? res.error : 'unknown error'}`);
      } catch (err) {
        toast(`Indexing failed: ${err.message}`);
      } finally {
        idxBtn.disabled = false;
        idxBtn.textContent = 'Index repo → context';
      }
    };
  if (desktop) {
    if (gitHistoryCache) {
      card.innerHTML = renderGitEntries(gitHistoryCache);
      return;
    }
    window.desktopApi
      .getGitLog()
      .then(entries => {
        gitHistoryCache = entries;
        card.innerHTML = renderGitEntries(entries);
      })
      .catch(err => {
        card.innerHTML = `<p>Unable to load git history: ${esc(err.message)}</p>`;
      });
    return;
  }
  renderGitBrowser(card);
}

function githubRepoConfig() {
  if (gitSettings.owner && gitSettings.repo) return gitSettings;
  const host = location.hostname || '';
  const m = host.match(/^([^.]+)\.github\.io$/);
  if (m) {
    const seg = location.pathname.split('/').filter(Boolean)[0];
    return {
      owner: m[1],
      repo: seg || `${m[1]}.github.io`,
      branch: gitSettings.branch || '',
      token: gitSettings.token || '',
    };
  }
  return null;
}
function githubHeaders(cfg) {
  const h = { Accept: 'application/vnd.github+json' };
  if (cfg.token) h.Authorization = `Bearer ${cfg.token}`;
  return h;
}
async function fetchGithubCommits(cfg) {
  const url = `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(
    cfg.repo
  )}/commits?per_page=100${cfg.branch ? `&sha=${encodeURIComponent(cfg.branch)}` : ''}`;
  const res = await fetch(url, { headers: githubHeaders(cfg) });
  if (!res.ok) {
    let msg = '';
    try {
      msg = (await res.json()).message;
    } catch {
      /* ignore */
    }
    throw Error(`GitHub ${res.status}${msg ? `: ${msg}` : ''}`);
  }
  const data = await res.json();
  return data.map(c => {
    const message = c.commit.message || '';
    return {
      hash: c.sha,
      author: c.commit.author?.name || c.author?.login || 'unknown',
      email: c.commit.author?.email || '',
      date: (c.commit.author?.date || '').slice(0, 10),
      subject: message.split('\n')[0],
      body: message.split('\n').slice(1).join('\n').trim(),
      additions: null,
      deletions: null,
      files: null,
    };
  });
}
async function renderGitBrowser(card) {
  const cfg = githubRepoConfig();
  if (!cfg) {
    card.innerHTML = `<p>In browser mode, history is read from GitHub. <a href="#" id="gitConfigLink">Configure a repository</a> to begin.</p>`;
    const l = card.querySelector('#gitConfigLink');
    if (l)
      l.onclick = e => {
        e.preventDefault();
        openGitConfig();
      };
    return;
  }
  if (gitHistoryCache) {
    renderGitBrowserResult(cfg, card, gitHistoryCache);
    return;
  }
  card.innerHTML = '<p>Loading history from GitHub…</p>';
  try {
    const entries = await fetchGithubCommits(cfg);
    gitHistoryCache = entries;
    renderGitBrowserResult(cfg, card, entries);
  } catch (err) {
    card.innerHTML = `<p>Unable to load history from GitHub: ${esc(
      err.message
    )}</p><p><a href="#" id="gitConfigLink">Reconfigure repository</a></p>`;
    const l = card.querySelector('#gitConfigLink');
    if (l)
      l.onclick = e => {
        e.preventDefault();
        openGitConfig();
      };
  }
}
function renderGitBrowserResult(cfg, card, entries) {
  const needsStats = entries.some(e => e.additions == null);
  card.innerHTML =
    renderGitEntries(entries) +
    `<p class="list-meta" style="margin-top:12px">Source: github.com/${esc(cfg.owner)}/${esc(
      cfg.repo
    )}${cfg.branch ? ` @ ${esc(cfg.branch)}` : ''} · <a href="#" id="gitReconfig">reconfigure</a>${
      needsStats ? ` · <button class="button" id="gitLoadStats">Load diff stats</button>` : ''
    }</p>`;
  const rc = card.querySelector('#gitReconfig');
  if (rc)
    rc.onclick = e => {
      e.preventDefault();
      openGitConfig();
    };
  const ls = card.querySelector('#gitLoadStats');
  if (ls) ls.onclick = () => loadGithubStats(cfg, card);
}
async function loadGithubStats(cfg, card) {
  const btn = card.querySelector('#gitLoadStats');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Loading diff stats…';
  }
  const entries = gitHistoryCache || [];
  const limit = cfg.token ? entries.length : Math.min(entries.length, 25);
  try {
    for (let i = 0; i < limit; i += 1) {
      const c = entries[i];
      if (c.additions != null) continue;
      const res = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(
          cfg.repo
        )}/commits/${c.hash}`,
        { headers: githubHeaders(cfg) }
      );
      if (!res.ok) {
        if (res.status === 403)
          throw Error('GitHub rate limit reached. Add a token in Configure repo to load more.');
        continue;
      }
      const d = await res.json();
      c.additions = d.stats?.additions ?? 0;
      c.deletions = d.stats?.deletions ?? 0;
      c.files = d.files?.length ?? 0;
    }
    renderGitBrowserResult(cfg, card, entries);
    toast(
      limit < entries.length
        ? `Loaded diff stats for the latest ${limit} commits (add a token for more).`
        : 'Diff stats loaded.'
    );
  } catch (err) {
    renderGitBrowserResult(cfg, card, entries);
    toast(err.message);
  }
}
function openGitConfig() {
  const inferred = githubRepoConfig() || {};
  const cfg = { owner: '', repo: '', branch: '', token: '', ...inferred, ...gitSettings };
  const d = $('#aiDialog');
  d.innerHTML = `<form class="dialog-body"><h2>Configure Git repository</h2><p class="subcopy">Browser mode reads commit history from GitHub. A token is optional but raises rate limits and enables private repositories.</p><div class="form-grid"><div class="field"><label>Owner</label><input name="owner" value="${esc(
    cfg.owner
  )}" placeholder="octocat" required></div><div class="field"><label>Repository</label><input name="repo" value="${esc(
    cfg.repo
  )}" placeholder="my-repo" required></div></div><div class="form-grid"><div class="field"><label>Branch (optional)</label><input name="branch" value="${esc(
    cfg.branch
  )}" placeholder="main"></div><div class="field"><label>Token (optional)</label><input name="token" type="password" value="${esc(
    cfg.token
  )}" placeholder="ghp_…"></div></div><p class="settings-note">Stored in this browser only.</p><div class="dialog-actions"><button class="button" type="button" data-close>Cancel</button><button class="button primary">Save</button></div></form>`;
  d.querySelector('[data-close]').onclick = () => d.close();
  d.querySelector('form').onsubmit = e => {
    e.preventDefault();
    const f = new FormData(e.target);
    gitSettings = {
      owner: f.get('owner').trim(),
      repo: f.get('repo').trim(),
      branch: f.get('branch').trim(),
      token: f.get('token').trim(),
    };
    saveGitSettings();
    gitHistoryCache = null;
    d.close();
    renderGit();
    toast('Git repository configured.');
  };
  d.showModal();
}

function openSimpleForm(kind) {
  const project = activeProject();
  const d = kind === 'decision' ? $('#decisionDialog') : $('#questionDialog');
  const title = kind === 'decision' ? 'Add a decision' : 'Add an open question';
  d.innerHTML = `<form class="dialog-body"><h2>${title}</h2><div class="field"><label>${
    kind === 'decision' ? 'Decision' : 'Question'
  }</label><textarea name="text" required></textarea></div>${
    kind === 'decision'
      ? '<div class="field"><label>Rationale</label><textarea name="reason" required></textarea></div>'
      : ''
  }<div class="dialog-actions"><button class="button" type="button" data-close>Cancel</button><button class="button primary">Add</button></div></form>`;
  d.querySelector('[data-close]').onclick = () => d.close();
  d.querySelector('form').onsubmit = e => {
    e.preventDefault();
    const f = new FormData(e.target),
      date = new Date().toISOString().slice(0, 10);
    if (kind === 'decision')
      project.decisions.push({
        id: `ADR-${String(project.decisions.length + 1).padStart(3, '0')}`,
        date,
        decision: f.get('text'),
        rationale: f.get('reason'),
      });
    else
      project.questions.push({
        id: `Q-${String(project.questions.length + 1).padStart(3, '0')}`,
        lane: 'human',
        text: f.get('text'),
        resolved: false,
      });
    save();
    d.close();
    renderAll();
  };
  d.showModal();
}

function setView(view) {
  [
    'home',
    'map',
    'context',
    'architecture',
    'git',
    'milestones',
    'decisions',
    'questions',
    'chat',
  ].forEach(v => {
    const el = $(`#${v}View`);
    if (el) el.hidden = v !== view;
    if (v === 'map') $('#ticketPanel').hidden = false;
  });
  if (view !== 'map') $('#ticketPanel').hidden = true;
  document
    .querySelectorAll('.nav-item')
    .forEach(b => b.classList.toggle('active', b.dataset.view === view));
}
function exportState() {
  const blob = new Blob([JSON.stringify(workspace, null, 2)], { type: 'application/json' }),
    a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'devtracker-workspace.json';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Workspace exported as JSON.');
}
function importState(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      const imported = migrateWorkspace({ ...data, version: 3 });
      if (!Array.isArray(imported.projects)) throw Error();
      workspace = imported;
      save();
      renderAll();
      toast('Workspace imported.');
    } catch {
      toast('That file is not a valid DevTracker workspace.');
    }
  };
  reader.readAsText(file);
}

$('#newTicketButton').onclick = () => openTicketForm();
$('#addProjectButton').onclick = () => addProject();
$('#aiSettingsButton').onclick = () => openAiSettings();
$('#exportButton').onclick = exportState;
$('#importButton').onclick = () => $('#importInput').click();
$('#importInput').onchange = e => e.target.files[0] && importState(e.target.files[0]);
document.querySelectorAll('.nav-item').forEach(b => (b.onclick = () => setView(b.dataset.view)));
renderAll();
setView('home');
if (window.desktopApi?.store) {
  hydrateFromStore();
  window.desktopApi.store.onChanged?.(() => hydrateFromStore());
}

// Architecture agent helpers
// eslint-disable-next-line no-unused-vars
function extractRevisedDescription(text) {
  if (!text) return '';
  const normalized = String(text).replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (/^revised description:/i.test(line) || /^3(?:\.|\)|:|-)/i.test(line)) {
      const section = lines
        .slice(index + 1)
        .join('\n')
        .trim();
      const paragraphs = section
        .split(/\n\s*\n/)
        .map(part => part.trim())
        .filter(Boolean);
      return paragraphs[0] || section;
    }
  }
  const paragraphs = normalized
    .split(/\n\s*\n/)
    .map(part => part.trim())
    .filter(Boolean);
  return paragraphs[paragraphs.length - 1] || normalized.trim();
}

function extractImprovementsList(text) {
  if (!text) return [];
  const normalized = String(text).replace(/\r\n/g, '\n');
  const lines = normalized
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  const items = [];
  let inRevised = false;
  for (const line of lines) {
    if (/^(revised description)\s*:?$/i.test(line)) {
      inRevised = true;
      continue;
    }
    if (
      /^(executive summary|follow-up|notes|suggested changes|suggested improvements|suggestions|improvements)\s*:?$/i.test(
        line
      )
    ) {
      inRevised = false;
      continue;
    }
    if (inRevised) continue; // the revised paragraph is not an action item
    const cleaned = line
      .replace(/^[-*]\s*/, '')
      .replace(/^\d+[.)]\s*/, '')
      .trim();
    if (cleaned && !/^[A-Z\s]+:$/.test(cleaned)) items.push(cleaned);
  }
  return items.slice(0, 8);
}

async function aiEnhanceArchitectureAgent() {
  const project = activeProject();
  const btn = document.querySelector('#archAiEnhance');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Analyzing...';
  }
  const archDesc =
    [
      project.architecture?.description || '',
      ...(project.diagrams || []).map(
        g => `${g.name} (${DIAGRAM_KINDS[g.kind] || g.kind}): ${g.description || 'no description'}`
      ),
    ]
      .filter(Boolean)
      .join('\n') || '';
  const decisions =
    (project.decisions || [])
      .slice(-8)
      .map(d => `- ${d.id}: ${d.title || d.decision}`)
      .join('\n') || 'None';
  const questions =
    (project.questions || [])
      .filter(q => !q.resolved)
      .slice(0, 8)
      .map(q => `- ${q.id}: ${q.text}`)
      .join('\n') || 'None';
  const tickets =
    (project.tickets || [])
      .slice(0, 6)
      .map(t => `- ${t.id}: ${t.title} [${t.status}]`)
      .join('\n') || 'None';
  const prompt = `You are an expert software architecture agent. Act as an architectural reviewer for this project and produce concrete, actionable improvements. Use the project context and focus on maintainability, scalability, security, operability, and developer ergonomics.

Project: ${project.name || 'Unnamed'} (${project.code || project.id || 'N/A'})
Project description:
${project.description || 'No high-level project description provided.'}

Recent decisions (most recent up to 8):
${decisions}

Open questions (most important):
${questions}

Representative tickets (up to 6):
${tickets}

Current architecture description:
${archDesc || '<no description>'}

Diagrams on file: ${
    (project.diagrams || []).map(g => `${g.name} [${g.kind}/${g.format}]`).join('; ') || 'none'
  }

Deliverable:
1) Executive summary (2-4 sentences) highlighting the top 3 priorities or risks.
2) A numbered list of concrete suggested changes or checklist items the team can act on (each short, actionable).
3) A concise revised architecture description (one paragraph) labeled 'REVISED DESCRIPTION:'.
4) Optional notes for follow-up tickets or migration steps (short bulleted list).

Return plain text; structure the response clearly using numbered sections or headings so the client can extract the revised description and improvements.`;
  try {
    const provider = activeProvider();
    if (
      !smartRoutingActive() &&
      (provider.type === 'local' || !provider.apiKey || !provider.endpoint)
    ) {
      // Local fallback: generate a helpful scaffolded response instead of remote AI
      const draft = `EXECUTIVE SUMMARY:\n- Focus on clear interface boundaries and observability.\n\nSUGGESTED CHANGES:\n- Standardize APIs and add schema validation.\n- Add health checks and metrics.\n\nREVISED DESCRIPTION:\n${
        archDesc ||
        'No architecture description provided. Consider documenting layers, data flow, and key integration points.'
      }\n\nFOLLOW-UP:\n- Create tickets for migration steps.`;
      const improvements = extractImprovementsList(draft);
      openAiImprovementsDialog('Architecture review — local draft', draft, improvements);
      return;
    }

    const text = await requestAiText(prompt, { task: 'architecture_review' });
    const improvements = extractImprovementsList(text);
    openAiImprovementsDialog('Architecture review (AI agent)', text, improvements);
  } catch (err) {
    toast(err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'AI review → improvements';
    }
  }
}

// Improvements/bugs from the AI review become one-click tickets or questions —
// the lead picks which findings deserve work; nothing is created automatically.
function openAiImprovementsDialog(title, fullText, improvements) {
  const d = $('#reportDialog');
  const items = (improvements || []).filter(Boolean);
  d.innerHTML = `<div class="dialog-body"><h2>${esc(
    title
  )}</h2><p class="subcopy">Findings from the review. Turn the ones worth doing into tickets or park them as questions — assigned to <strong>${esc(
    activeProject()?.name || 'this project'
  )}</strong>.</p>
  <div class="list-card" style="margin:0 0 14px">${
    items
      .map(
        (it, i) =>
          `<article class="list-row" style="padding:11px 14px"><p style="margin:0;color:var(--ink);font-size:13px">${esc(
            it
          )}</p><p style="margin:8px 0 0;display:flex;gap:6px"><span data-slot="${i}"><button class="button primary" data-mk-ticket="${i}">→ Create ticket</button> <button class="button" data-mk-question="${i}">→ Open question</button></span></p></article>`
      )
      .join('') ||
    '<p style="padding:14px;color:var(--muted)">No discrete improvements could be extracted — see the full output below.</p>'
  }</div>
  <details><summary style="cursor:pointer;font:700 12px Manrope">Full AI output</summary><textarea style="width:100%;min-height:180px;margin-top:8px;font:11px 'DM Mono'">${esc(
    fullText
  )}</textarea></details>
  <div class="dialog-actions"><button class="button" data-close>Close</button></div></div>`;
  d.querySelector('[data-close]').onclick = () => d.close();
  d.querySelectorAll('[data-mk-ticket]').forEach(
    b =>
      (b.onclick = () => {
        const it = items[Number(b.dataset.mkTicket)];
        d.close();
        openTicketForm(null, {
          title: it.slice(0, 90),
          description: `From AI architecture review:\n${it}`,
          technicalNotes:
            'Source: AI architecture review — validate the finding before implementing.',
        });
      })
  );
  d.querySelectorAll('[data-mk-question]').forEach(
    b =>
      (b.onclick = () => {
        const it = items[Number(b.dataset.mkQuestion)];
        const p = activeProject();
        const max = p.questions.reduce((a, x) => {
          const m = String(x.id).match(/^Q-(\d+)$/);
          return m ? Math.max(a, Number(m[1])) : a;
        }, 0);
        const q = {
          id: `Q-${String(max + 1).padStart(3, '0')}`,
          lane: 'human',
          text: it,
          resolved: false,
        };
        p.questions.push(q);
        logActivity(p, 'question', `${q.id} opened from AI review: ${it.slice(0, 60)}`, q.id);
        save();
        renderAll();
        const slot = d.querySelector(`[data-slot="${b.dataset.mkQuestion}"]`);
        if (slot) slot.innerHTML = `<span class="status-pill done">saved as ${esc(q.id)}</span>`;
        toast(`${q.id} added to open questions.`);
      })
  );
  d.showModal();
}

// Ensure pako is available in the browser by loading the bundled vendor module if necessary
async function ensurePako() {
  if (window.pako) return window.pako;
  try {
    const m = await import('./vendor/pako.mjs');
    window.pako = m && (m.default || m);
    return window.pako;
  } catch (err) {
    console.warn('Unable to load bundled pako via import:', err);
    return null;
  }
}

// --- Milestones ---
function renderMilestones() {
  const project = activeProject();
  const el = $('#milestonesView');
  if (!el) return;
  const list = project.milestones || [];
  const row = m => {
    const hasDetails = !!(m.sessionSummary || m.diffRef);
    return `<article class="list-row"><span class="list-meta">${esc(m.id)}${
      m.date ? ` · ${esc(m.date)}` : ''
    } <span class="status-pill ${m.status === 'done' ? 'done' : 'todo'}">${
      m.status === 'done' ? 'done' : 'planned'
    }</span></span><strong>${esc(m.title)}</strong>${
      m.description ? `<p>${esc(m.description)}</p>` : ''
    }<p><button class="button" data-toggle-ms="${esc(m.id)}">${
      m.status === 'done' ? 'Mark planned' : 'Mark done'
    }</button> <button class="button" data-edit-ms="${esc(m.id)}">Edit</button>${
      hasDetails ? ` <button class="button" data-details-ms="${esc(m.id)}">Details ▾</button>` : ''
    }</p><div class="ms-details" data-details-for="${esc(
      m.id
    )}" hidden style="margin-top:8px;border-top:1px solid var(--line,#d9e0dd);padding-top:8px"></div></article>`;
  };
  el.innerHTML = `<div class="view-head"><div><p class="eyebrow">DELIVERY MILESTONES</p><h1>Milestones</h1><p class="subcopy">Concrete or MVP features delivered or targeted. Click Details to see the agent session summary and how it was implemented.</p></div><button class="button primary" id="addMilestone">+ Milestone</button></div><div class="list-card">${
    list.length ? list.map(row).join('') : '<p>No milestones yet.</p>'
  }</div>`;
  $('#addMilestone').onclick = () => openMilestoneForm();
  el.querySelectorAll('[data-toggle-ms]').forEach(
    b =>
      (b.onclick = () => {
        const m = project.milestones.find(x => x.id === b.dataset.toggleMs);
        m.status = m.status === 'done' ? 'planned' : 'done';
        if (m.status === 'done' && !m.date) m.date = new Date().toISOString().slice(0, 10);
        logActivity(project, 'milestone', `${m.id} marked ${m.status}: ${m.title}`, m.id);
        save();
        renderAll();
      })
  );
  el.querySelectorAll('[data-edit-ms]').forEach(
    b =>
      (b.onclick = () => openMilestoneForm(project.milestones.find(x => x.id === b.dataset.editMs)))
  );
  el.querySelectorAll('[data-details-ms]').forEach(
    b => (b.onclick = () => toggleMilestoneDetails(b.dataset.detailsMs, b))
  );
}
function toggleMilestoneDetails(id, btn) {
  const m = activeProject().milestones.find(x => x.id === id);
  if (!m) return;
  const panel = $(`#milestonesView`).querySelector(`[data-details-for="${CSS.escape(id)}"]`);
  if (!panel) return;
  const opening = panel.hidden;
  panel.hidden = !opening;
  if (btn) btn.textContent = opening ? 'Details ▴' : 'Details ▾';
  if (!opening || panel.dataset.loaded) return;
  panel.dataset.loaded = '1';
  const summary = m.sessionSummary
    ? `<h4 style="margin:4px 0">Session summary</h4><p style="white-space:pre-wrap">${esc(
        m.sessionSummary
      )}</p>`
    : '';
  const ref = m.diffRef && (m.diffRef.from || m.diffRef.to) ? m.diffRef : null;
  panel.innerHTML =
    summary +
    (ref
      ? `<h4 style="margin:8px 0 4px">Code diff <small class="list-meta">${esc(
          ref.from || ''
        )}..${esc(
          ref.to || ''
        )}</small></h4><pre class="ms-diff" style="max-height:340px;overflow:auto;border:1px solid var(--line,#d9e0dd);border-radius:6px;padding:10px;font-size:12px">Loading diff…</pre>`
      : summary
      ? ''
      : '<p class="list-meta">No details recorded.</p>');
  if (ref) {
    const pre = panel.querySelector('.ms-diff');
    if (window.desktopApi?.getGitDiff) {
      window.desktopApi
        .getGitDiff(ref)
        .then(res => {
          if (res && res.ok) {
            pre.textContent =
              (res.stat ? res.stat + '\n\n' : '') +
              res.patch +
              (res.truncated ? '\n\n… diff truncated' : '');
          } else {
            pre.textContent = `Unable to load diff: ${res ? res.error : 'unknown error'}`;
          }
        })
        .catch(err => {
          pre.textContent = `Unable to load diff: ${err.message}`;
        });
    } else {
      pre.textContent =
        'Diff resolution needs the desktop app (git access). Recorded range: ' +
        (ref.from || '') +
        '..' +
        (ref.to || '');
    }
  }
}
function openMilestoneForm(existing) {
  const project = activeProject();
  const m = existing || {
    id: '',
    title: '',
    description: '',
    status: 'planned',
    date: '',
    sessionSummary: '',
  };
  const d = $('#questionDialog');
  d.innerHTML = `<form class="dialog-body"><h2>${
    existing ? 'Edit' : 'New'
  } milestone</h2><div class="field"><label>Title</label><input name="title" value="${esc(
    m.title
  )}" required></div><div class="field"><label>Description</label><textarea name="description">${esc(
    m.description
  )}</textarea></div><div class="field"><label>Session summary (how it was implemented)</label><textarea name="sessionSummary" placeholder="Distilled summary of the session that delivered this milestone.">${esc(
    m.sessionSummary || ''
  )}</textarea></div><div class="form-grid"><div class="field"><label>Status</label><select name="status"><option value="planned"${
    m.status !== 'done' ? ' selected' : ''
  }>planned</option><option value="done"${
    m.status === 'done' ? ' selected' : ''
  }>done</option></select></div><div class="field"><label>Date (optional)</label><input name="date" value="${esc(
    m.date
  )}" placeholder="2026-07-20"></div></div><div class="dialog-actions"><button class="button" type="button" data-close>Cancel</button><button class="button primary">Save milestone</button></div></form>`;
  d.querySelector('[data-close]').onclick = () => d.close();
  d.querySelector('form').onsubmit = e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const status = f.get('status');
    const item = {
      ...(existing || {}),
      id: existing ? existing.id : `MS-${String(project.milestones.length + 1).padStart(3, '0')}`,
      title: f.get('title').trim(),
      description: f.get('description').trim(),
      sessionSummary: f.get('sessionSummary').trim(),
      status,
      date:
        f.get('date').trim() || (status === 'done' ? new Date().toISOString().slice(0, 10) : ''),
    };
    if (!item.title) {
      toast('Give the milestone a title.');
      return;
    }
    if (existing) Object.assign(existing, item);
    else project.milestones.push(item);
    save();
    d.close();
    renderAll();
    toast('Milestone saved.');
  };
  d.showModal();
}

// --- Agent chat ---
function requestAiChat(messages) {
  const provider = activeProvider();
  if (provider.type === 'local' || !provider.apiKey || !provider.endpoint)
    return Promise.resolve(localChatReply());
  const payload = { messages, temperature: 0.3 };
  if (provider.model) payload.model = provider.model;
  return aiHttp(provider, payload).then(
    data => data.choices?.[0]?.message?.content || data.output_text || data.result || ''
  );
}
function localChatReply() {
  return `No AI provider is configured, so I can't chat freely — but you can still push items into the workspace with slash commands:\n\n/milestone <title> — propose a milestone\n/done <title> — propose a completed milestone\n/decision <title> — park a decision for review\n/question <text> — add an open question\n/ticket <CODE> <title> — draft a ticket\n\nAdd a provider in AI settings for full conversation.`;
}
function chatSystemPrompt(project) {
  const tickets =
    (project.tickets || []).map(t => `${t.id}: ${t.title} [${t.status}]`).join('; ') || 'none';
  const decisions =
    (project.decisions || []).map(d => `${d.id}: ${d.title} [${d.status}]`).join('; ') || 'none';
  const questions =
    openQuestions()
      .map(q => q.text)
      .join('; ') || 'none';
  const milestones =
    (project.milestones || []).map(m => `${m.id}: ${m.title} [${m.status}]`).join('; ') || 'none';
  return `You are the DevTracker Agent embedded in an engineering workspace. The user is a senior Tech Lead and solution architect. Help them capture engineering context into the workspace:
- Milestones: concrete or MVP features that are delivered or targeted.
- Decisions: change reviews parked as tradeoffs. Present OPTIONS with pros and cons but DO NOT choose — leave "choice" empty and "status":"proposed". The Tech Lead decides.
- Questions: open questions for a human or agent to resolve.
- Tickets: implementation-ready work items.

When (and only when) the user asks to record or push something, append ONE fenced block at the very end of your reply:
\`\`\`devtracker-actions
[{"type":"add_milestone","title":"...","description":"...","status":"planned"}]
\`\`\`
Valid action objects:
- {"type":"add_milestone","title","description","status":"planned|done"}
- {"type":"add_decision","title","context","reversibility":"one-way|two-way","options":[{"name","pros":[],"cons":[]}],"status":"proposed"}
- {"type":"add_question","text","lane":"human|agent"}
- {"type":"add_ticket","id":"CODE-N","title","effort":"XS|S|M|L","description","acceptanceCriteria":[]}
Never invent data the user did not provide. Keep the conversational text concise.

Current project: ${project.name}
Standing constraints (non-negotiable): ${
    (project.constraints || [])
      .filter(c => c.active)
      .map(c => c.text)
      .join('; ') || 'none'
  }
Milestones: ${milestones}
Decisions: ${decisions}
Open questions: ${questions}
Tickets: ${tickets}`;
}
function parseChatActions(text) {
  if (!text) return { content: '', actions: [] };
  const re = /```devtracker-actions\s*([\s\S]*?)```/i;
  const m = text.match(re);
  if (!m) return { content: text.trim(), actions: [] };
  let actions = [];
  try {
    const parsed = JSON.parse(m[1].trim());
    actions = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    actions = [];
  }
  return { content: text.replace(re, '').trim(), actions };
}
function parseSlashCommand(text) {
  const [cmd, ...rest] = text.slice(1).split(' ');
  const arg = rest.join(' ').trim();
  switch (cmd.toLowerCase()) {
    case 'milestone':
      return arg ? [{ type: 'add_milestone', title: arg, status: 'planned' }] : [];
    case 'done':
      return arg ? [{ type: 'add_milestone', title: arg, status: 'done' }] : [];
    case 'decision':
      return arg ? [{ type: 'add_decision', title: arg, status: 'proposed', options: [] }] : [];
    case 'question':
      return arg ? [{ type: 'add_question', text: arg, lane: 'human' }] : [];
    case 'ticket': {
      const mm = arg.match(/^(\S+)\s+(.*)$/);
      return mm
        ? [{ type: 'add_ticket', id: mm[1], title: mm[2] }]
        : arg
        ? [{ type: 'add_ticket', title: arg }]
        : [];
    }
    default:
      return [];
  }
}
function applyChatAction(action) {
  const project = activeProject();
  const date = new Date().toISOString().slice(0, 10);
  switch (action.type) {
    case 'add_milestone': {
      const id = `MS-${String(project.milestones.length + 1).padStart(3, '0')}`;
      project.milestones.push({
        id,
        title: action.title || 'Untitled milestone',
        description: action.description || '',
        status: action.status === 'done' ? 'done' : 'planned',
        date: action.date || (action.status === 'done' ? date : ''),
      });
      return id;
    }
    case 'add_decision': {
      const id = `ADR-${String(project.decisions.length + 1).padStart(3, '0')}`;
      project.decisions.push(
        normalizeDecision({
          id,
          date,
          title: action.title,
          context: action.context,
          reversibility: action.reversibility,
          options: action.options,
          choice: action.choice,
          rationale: action.rationale,
          status: action.status || 'proposed',
        })
      );
      return id;
    }
    case 'add_question': {
      const id = `Q-${String(project.questions.length + 1).padStart(3, '0')}`;
      project.questions.push({
        id,
        lane: action.lane === 'agent' ? 'agent' : 'human',
        text: action.text || '',
        resolved: false,
      });
      return id;
    }
    case 'add_ticket': {
      const id = String(action.id || `T-${project.tickets.length + 1}`).trim();
      if (ticketById(id)) return null;
      project.tickets.push({
        id,
        title: action.title || id,
        effort: ['XS', 'S', 'M', 'L'].includes(action.effort) ? action.effort : 'S',
        line: 'default',
        deps: Array.isArray(action.deps) ? action.deps : [],
        description: action.description || '',
        acceptanceCriteria: (Array.isArray(action.acceptanceCriteria)
          ? action.acceptanceCriteria
          : []
        ).map(t => ({ text: t, done: false })),
        definitionOfDone: action.definitionOfDone || '',
        technicalNotes: action.technicalNotes || '',
        status: 'todo',
        sessions: [],
        scratchpad: '',
      });
      return id;
    }
    default:
      return null;
  }
}
function actionLabel(a) {
  switch (a.type) {
    case 'add_milestone':
      return {
        title: `🏁 Milestone: ${a.title || 'Untitled'}`,
        detail: `${a.status === 'done' ? 'Done' : 'Planned'}${
          a.description ? ` — ${a.description}` : ''
        }`,
      };
    case 'add_decision':
      return {
        title: `◇ Decision: ${a.title || 'Untitled'}`,
        detail: `${(a.options || []).length} option(s) with tradeoffs · you decide${
          a.reversibility ? ` · ${a.reversibility} door` : ''
        }`,
      };
    case 'add_question':
      return { title: '? Open question', detail: a.text || '' };
    case 'add_ticket':
      return {
        title: `⌘ Ticket: ${[a.id, a.title].filter(Boolean).join(' · ')}`,
        detail: `${a.effort || 'S'} · ${(a.acceptanceCriteria || []).length} AC`,
      };
    default:
      return { title: 'Unknown action', detail: JSON.stringify(a) };
  }
}
function chatActionCard(a, mi, ai) {
  const label = actionLabel(a);
  return `<div class="action-card" style="margin-top:8px;border:1px dashed var(--line,#c8d2ce);border-radius:8px;padding:8px"><strong>${esc(
    label.title
  )}</strong><p class="list-meta" style="margin:4px 0">${esc(label.detail)}</p>${
    a.applied
      ? `<span class="status-pill done">${esc(a.applied)}</span>`
      : `<button class="button primary" data-apply-action="${mi}:${ai}">Apply / remember</button>`
  }</div>`;
}
function chatBubble(m, i) {
  const mine = m.role === 'user';
  const actions = (m.actions || []).map((a, ai) => chatActionCard(a, i, ai)).join('');
  return `<div class="chat-msg ${esc(m.role)}" style="align-self:${
    mine ? 'flex-end' : 'flex-start'
  };max-width:88%;background:${mine ? '#1f3b34' : 'var(--card,#f4f6f5)'};color:${
    mine ? '#eafff6' : 'inherit'
  };border:1px solid var(--line,#d9e0dd);border-radius:10px;padding:8px 12px"><div style="white-space:pre-wrap">${esc(
    m.content
  )}</div>${actions}</div>`;
}
function renderChatMessages(host) {
  const project = activeProject();
  const box = host.querySelector('.chat-messages');
  if (!box) return;
  if (!project.chat.length) {
    box.innerHTML =
      '<p class="subcopy">No messages yet. Try “/milestone MVP retrieval working”, or ask the agent to draft a decision.</p>';
    return;
  }
  box.innerHTML = project.chat.map((m, i) => chatBubble(m, i)).join('');
  box.querySelectorAll('[data-apply-action]').forEach(
    b =>
      (b.onclick = () => {
        const [mi, ai] = b.dataset.applyAction.split(':').map(Number);
        const msg = project.chat[mi];
        const action = msg.actions[ai];
        const id = applyChatAction(action);
        action.applied = id ? `Saved as ${id}` : 'Not applied (duplicate id?)';
        if (id)
          logActivity(
            activeProject(),
            action.type.replace('add_', ''),
            `${id} added from agent chat`,
            id
          );
        save();
        renderAll();
        if (id) toast(`Added ${id} to the workspace.`);
      })
  );
  box.scrollTop = box.scrollHeight;
}
function buildChatSurface(host, isRail) {
  const provider = activeProvider();
  const missing = [
    !provider.apiKey ? 'API key' : null,
    !provider.endpoint ? 'endpoint' : null,
  ].filter(Boolean);
  const note =
    provider.type === 'local' || missing.length
      ? `Local mode${
          provider.type !== 'local' && missing.length
            ? ` — ${esc(provider.name)} is missing its ${missing.join(
                ' and '
              )}; add it in AI settings`
            : ' — add a provider in AI settings'
        } or use slash commands (/milestone, /decision, /question, /ticket).`
      : `Connected to ${esc(provider.name)}.`;
  host.innerHTML = `${
    isRail
      ? `<div class="view-head"><div><p class="eyebrow">AGENT</p><h1>Agent chat</h1><p class="subcopy">Push milestones, decisions, and questions into this workspace. Proposals require your approval before they are saved.</p></div></div>`
      : ''
  }<div class="chat-surface" style="display:flex;flex-direction:column;height:${
    isRail ? '70vh' : '100%'
  };border:1px solid var(--line,#d9e0dd);border-radius:10px;overflow:hidden"><div class="chat-messages" style="flex:1;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:10px"></div><form class="chat-input" style="display:flex;gap:8px;padding:10px;border-top:1px solid var(--line,#d9e0dd)"><textarea rows="2" placeholder="Ask the agent, or type /milestone, /decision, /question…" style="flex:1;resize:none"></textarea><button class="button primary" type="submit">Send</button></form><p class="settings-note" style="padding:0 10px 8px;margin:0">${note}</p></div>`;
  const form = host.querySelector('.chat-input');
  form.onsubmit = e => {
    e.preventDefault();
    const ta = form.querySelector('textarea');
    const val = ta.value;
    ta.value = '';
    sendChat(val);
  };
  form.querySelector('textarea').onkeydown = e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  };
  renderChatMessages(host);
}
function renderChatSurfaces() {
  [
    ['#chatView', true],
    ['#chatDrawerBody', false],
  ].forEach(([sel, isRail]) => {
    const host = $(sel);
    if (host) buildChatSurface(host, isRail);
  });
}
async function runDebateMode(topic) {
  const project = activeProject();
  if (!project) return;
  const thinking = {
    role: 'assistant',
    content: 'Spawning Architect Alpha and Architect Beta to debate... debate in progress…',
    pending: true,
  };
  project.chat.push(thinking);
  save();
  renderChatSurfaces();

  const activeDecisions =
    (project.decisions || []).map(d => `- ${d.id}: ${d.title} [${d.status}]`).join('\n') || 'None';
  const prompt = `You are hosting an architectural debate between two expert software engineers:
- **Architect Alpha**: Conventional, conservative, prefers proven, simple, and relational/monolithic architectures.
- **Architect Beta**: Modern, cloud-native, prefers highly optimized, distributed, or specialized solutions (NoSQL, microservices, etc.).

They are debating the following topic: "${topic}"

Analyze this in the context of the active project: "${project.name}" (Description: ${
    project.description || 'N/A'
  }).
Already decided ADRs:
${activeDecisions}

Deliverable format:
1. A realistic dialogue transcript where Alpha and Beta exchange 1-2 responses each, debating specific pros, cons, and tradeoffs based on their philosophies.
2. A brief consensus/summary paragraph.
3. At the very end, append a proposed ADR decision as a JSON block wrapped in \`\`\`devtracker-actions\`\`\`:
\`\`\`devtracker-actions
[
  {
    "type": "add_decision",
    "title": "Decide on ${topic.replace(/"/g, '\\"')}",
    "context": "Debated between Alpha and Beta regarding ${topic.replace(/"/g, '\\"')}.",
    "reversibility": "two-way",
    "options": [
      {
        "name": "Alpha's proposed option",
        "pros": ["pro1", "pro2"],
        "cons": ["con1"]
      },
      {
        "name": "Beta's proposed option",
        "pros": ["pro1"],
        "cons": ["con1", "con2"]
      }
    ],
    "status": "proposed"
  }
]
\`\`\`

Make the dialogue engaging and technical. Do not output standard conversational introduction; start directly with the debate transcript.`;

  try {
    const provider = activeProvider();
    if (provider.type === 'local' || !provider.apiKey || !provider.endpoint) {
      const idx = project.chat.indexOf(thinking);
      if (idx >= 0) project.chat.splice(idx, 1);

      const localResult = `### 🎭 Local Debate Scaffold: ${topic}
      
**Architect Alpha**: We should keep it simple and conventional. Let's use our existing tools.
**Architect Beta**: A specialized, modern tool could give us better scaling and decoupling here.

*Consensus*: Options laid out below for Tech Lead review.

\`\`\`devtracker-actions
[
  {
    "type": "add_decision",
    "title": "Decide on ${topic.replace(/"/g, '\\"')}",
    "context": "Local debate scaffold for ${topic.replace(/"/g, '\\"')}.",
    "reversibility": "two-way",
    "options": [
      {
        "name": "Simple Conventional Option",
        "pros": ["Easy to set up", "Low operational overhead"],
        "cons": ["May not scale optimized tasks"]
      },
      {
        "name": "Specialized Modern Option",
        "pros": ["High scalability", "Feature rich"],
        "cons": ["Extra service to maintain", "Learning curve"]
      }
    ],
    "status": "proposed"
  }
]
\`\`\``;
      const { content, actions } = parseChatActions(localResult);
      project.chat.push({ role: 'assistant', content, actions });
      save();
      renderChatSurfaces();
      return;
    }

    const reply = await requestAiText(prompt, { task: 'architecture_debate' });
    const { content, actions } = parseChatActions(reply);
    const idx = project.chat.indexOf(thinking);
    if (idx >= 0) {
      project.chat.splice(idx, 1, {
        role: 'assistant',
        content: content || '(no response)',
        actions,
      });
    }
  } catch (err) {
    const idx = project.chat.indexOf(thinking);
    if (idx >= 0) project.chat.splice(idx, 1);
    project.chat.push({ role: 'assistant', content: `⚠ Debate failed: ${err.message}` });
  }
  save();
  renderChatSurfaces();
}

async function sendChat(text) {
  const project = activeProject();
  const value = (text || '').trim();
  if (!value) return;
  project.chat.push({ role: 'user', content: value });
  save();
  renderChatSurfaces();
  if (value.startsWith('/')) {
    if (value.toLowerCase().startsWith('/debate ')) {
      const topic = value.slice(8).trim();
      if (!topic) {
        project.chat.push({
          role: 'assistant',
          content: 'Please specify a topic, e.g. /debate Choose a database store',
        });
        save();
        renderChatSurfaces();
        return;
      }
      await runDebateMode(topic);
      return;
    }
    const actions = parseSlashCommand(value);
    project.chat.push(
      actions.length
        ? { role: 'assistant', content: 'Here is what I can add — review and apply:', actions }
        : {
            role: 'assistant',
            content: 'Unknown command. Try /milestone, /done, /decision, /question, or /ticket.',
          }
    );
    save();
    renderChatSurfaces();
    return;
  }
  const thinking = { role: 'assistant', content: '…', pending: true };
  project.chat.push(thinking);
  renderChatSurfaces();
  try {
    const messages = [
      { role: 'system', content: chatSystemPrompt(project) },
      ...project.chat.filter(m => !m.pending).map(m => ({ role: m.role, content: m.content })),
    ];
    const reply = await requestAiChat(messages);
    const { content, actions } = parseChatActions(reply);
    const idx = project.chat.indexOf(thinking);
    project.chat.splice(idx, 1, {
      role: 'assistant',
      content: content || '(no response)',
      actions,
    });
  } catch (err) {
    const idx = project.chat.indexOf(thinking);
    if (idx >= 0) project.chat.splice(idx, 1);
    project.chat.push({ role: 'assistant', content: `⚠ ${err.message}` });
  }
  save();
  renderChatSurfaces();
}
function toggleChatDrawer(force) {
  const d = $('#chatDrawer');
  if (!d) return;
  const currentlyHidden = d.style.display === 'none' || d.hidden;
  const show = force != null ? force : currentlyHidden;
  d.hidden = !show;
  d.style.display = show ? 'flex' : 'none';
  if (show) {
    renderChatSurfaces();
    const ta = $('#chatDrawerBody textarea');
    if (ta) ta.focus();
  }
}
$('#chatToggleButton').onclick = () => toggleChatDrawer();
$('#chatDrawerClose').onclick = () => toggleChatDrawer(false);
