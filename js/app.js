import { DEFAULT_WORKSPACE, STORAGE_KEY, effortXP } from './data.js';

const AI_SETTINGS_KEY = 'devtracker:ai-settings:v1';
const DEFAULT_AI_SETTINGS = {
  activeProviderId: 'local',
  providers: [
    { id: 'local', name: 'Local draft', type: 'local', endpoint: '', model: '', apiKey: '' },
    { id: 'grok', name: 'Grok / xAI', type: 'openai-compatible', endpoint: 'https://api.x.ai/v1/chat/completions', model: 'grok-4', apiKey: '' }
  ]
};
const clone = v => JSON.parse(JSON.stringify(v));
let workspace = load();
let aiSettings = loadAiSettings();
const $ = s => document.querySelector(s);
const esc = s => String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
const projectById = id => workspace.projects?.find(p => p.id === id);
const activeProject = () => projectById(workspace.activeProjectId) || workspace.projects?.[0] || null;
const ticketById = id => activeProject()?.tickets.find(t => t.id === id);
const openQuestions = () => activeProject()?.questions.filter(q => !q.resolved) || [];
let projectContextCache = null;
let gitHistoryCache = null;
const ARCHITECTURES = [
  { id: 'layered', name: 'Layered Architecture', summary: 'Separate presentation, business, and data concerns into distinct layers.', details: 'Use this architecture for clear boundaries between UI, application logic, and persistence. It is easy to understand and maintain for monolithic applications.' },
  { id: 'hexagonal', name: 'Hexagonal Architecture', summary: 'Isolate the core domain from external systems through ports and adapters.', details: 'Build a stable inner domain model with adapters for infrastructure, APIs, and UI. This reduces coupling and makes automated test coverage easier.' },
  { id: 'event-driven', name: 'Event-driven Architecture', summary: 'Use events to decouple producers from consumers across the system.', details: 'Ideal for asynchronous processing, auditability, and scaling. Ensure event contracts are versioned and backpressure is handled.' },
  { id: 'microservices', name: 'Microservices Architecture', summary: 'Decompose the system into independently deployable services.', details: 'Choose this when different capabilities need independent scaling, deployment, or technology stacks. Emphasize API contracts, observability, and data ownership.' }
];

function load() { try { const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)); return migrateWorkspace(saved?.version === 3 ? saved : null); } catch { return clone(DEFAULT_WORKSPACE); } }
function migrateWorkspace(saved) {
  if (!saved) return clone(DEFAULT_WORKSPACE);
  if (Array.isArray(saved.projects)) {
    return {
      ...clone(DEFAULT_WORKSPACE),
      ...saved,
      projects: saved.projects,
      activeProjectId: saved.activeProjectId || saved.projects[0]?.id || DEFAULT_WORKSPACE.activeProjectId
    };
  }
  const id = saved.project?.code || 'default';
  return {
    version: 3,
    activeProjectId: id,
    projects: [{
      id,
      name: saved.project?.name || 'Default project',
      code: saved.project?.code || id,
      description: saved.project?.description || '',
      tickets: saved.tickets || [],
      decisions: saved.decisions || [],
      questions: saved.questions || [],
      selectedTicketId: saved.selectedTicketId || saved.tickets?.[0]?.id || ''
    }]
  };
}
function loadAiSettings() { try { const saved = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY)); return saved?.providers ? {...clone(DEFAULT_AI_SETTINGS), ...saved, providers: mergeProviders(saved.providers)} : clone(DEFAULT_AI_SETTINGS); } catch { return clone(DEFAULT_AI_SETTINGS); } }
function mergeProviders(saved) { const defaults = clone(DEFAULT_AI_SETTINGS.providers), custom = saved.filter(p => !defaults.some(d => d.id === p.id)); return defaults.map(d => ({...d, ...(saved.find(p => p.id === d.id) || {})})).concat(custom); }
function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace)); $('#saveIndicator').textContent = '● Saved locally'; }
function saveAiSettings() { localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(aiSettings)); }
function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), 2400); }
function depsDone(ticket) { return ticket.deps.every(id => ticketById(id)?.status === 'done'); }
function acProgress(t) { return [t.acceptanceCriteria.filter(a => a.done).length, t.acceptanceCriteria.length]; }
function statusText(s) { return ({todo:'Not started',in_progress:'In progress',done:'Done'})[s]; }

function renderProjectSelector() {
  const project = activeProject();
  const title = $('#projectName');
  if (title) title.textContent = project?.name || 'Untitled project';
  const select = $('#projectSelect');
  if (!select) return;
  select.innerHTML = workspace.projects.map(p => `<option value="${esc(p.id)}"${p.id === project?.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
  select.onchange = e => switchProject(e.target.value);
}

function switchProject(id) {
  const project = projectById(id);
  if (!project) return;
  workspace.activeProjectId = id;
  if (!project.selectedTicketId && project.tickets.length) project.selectedTicketId = project.tickets[0].id;
  save();
  renderAll();
}

function addProject() {
  const name = prompt('Enter a new project name', `Project ${workspace.projects.length + 1}`);
  if (!name || !name.trim()) return;
  const code = prompt('Enter a unique project code', name.replace(/\s+/g, '-').toUpperCase().slice(0, 8));
  if (!code || !code.trim()) return;
  const id = code.trim();
  if (projectById(id)) {
    toast('A project with that code already exists.');
    return;
  }
  const project = { id, name: name.trim(), code: id, description: '', tickets: [], decisions: [], questions: [], selectedTicketId: '' };
  workspace.projects.push(project);
  workspace.activeProjectId = id;
  save();
  renderAll();
}

function renderAll() { renderProjectSelector(); renderCounts(); renderMap(); renderNextUp(); renderTicket(); renderContext(); renderArchitecture(); renderGit(); renderDecisions(); renderQuestions(); }
function renderCounts() { const project = activeProject(); const done = project.tickets.filter(t => t.status === 'done').length; $('#doneProgress').textContent = `${done} / ${project.tickets.length}`; $('#progressBar').style.width = `${project.tickets.length ? done / project.tickets.length * 100 : 0}%`; $('#decisionCount').textContent = project.decisions.length; $('#questionCount').textContent = openQuestions().length; }
function renderNextUp() { const project = activeProject(); const target = project.tickets.find(t => t.status !== 'done' && depsDone(t)); const el = $('#nextUp'); if (!target) { el.innerHTML = '<div class="next-card"><div><span class="next-kicker">PATH CLEAR</span><strong>Every ticket is complete.</strong></div></div>'; return; } const [complete,total] = acProgress(target); el.innerHTML = `<div class="next-card"><div><span class="next-kicker">NEXT UNBLOCKED TICKET</span><strong>${esc(target.id)} · ${esc(target.title)} <small>(${complete}/${total} AC)</small></strong></div><button class="button primary" data-open="${esc(target.id)}">Open ticket</button></div>`; el.querySelector('button').onclick = () => select(target.id); }

function levels() { const tickets = activeProject().tickets; const result = {}, degree = {}; tickets.forEach(t => degree[t.id] = t.deps.length); const queue = tickets.filter(t => !degree[t.id]); queue.forEach(t => result[t.id] = 0); while(queue.length){ const t = queue.shift(); tickets.filter(x => x.deps.includes(t.id)).forEach(x=>{result[x.id] = Math.max(result[x.id] || 0, result[t.id]+1); if(--degree[x.id]===0) queue.push(x); }); } tickets.forEach(t => result[t.id] ??= 0); return result; }
function renderMap() { const svg = $('#graph'), level = levels(), cols = []; const tickets = activeProject().tickets; if (!tickets.length) { svg.innerHTML = '<text x="20" y="30" fill="#82908a">No tickets available for this project.</text>'; svg.setAttribute('viewBox','0 0 320 60'); svg.setAttribute('width',320); svg.setAttribute('height',60); return; } tickets.forEach(t => (cols[level[t.id]] ||= []).push(t)); const w=190,h=93,gapX=235,gapY=123,margin=35, maxRows=Math.max(...cols.map(c=>c.length)); const fullW = margin*2+(cols.length-1)*gapX+w, fullH=margin*2+(maxRows-1)*gapY+h; svg.setAttribute('viewBox',`0 0 ${fullW} ${fullH}`); svg.setAttribute('width',fullW);svg.setAttribute('height',fullH);svg.innerHTML=''; const pos={}; cols.forEach((col,x)=>{const start=(fullH-(col.length*h+(col.length-1)*(gapY-h)))/2;col.forEach((t,y)=>pos[t.id]={x:margin+x*gapX,y:start+y*gapY});}); tickets.forEach(t=>t.deps.forEach(d=>{const a=pos[d],b=pos[t.id];if(!a||!b)return;const path=document.createElementNS('http://www.w3.org/2000/svg','path');const mid=(a.x+w+b.x)/2;path.setAttribute('d',`M ${a.x+w} ${a.y+h/2} C ${mid} ${a.y+h/2}, ${mid} ${b.y+h/2}, ${b.x} ${b.y+h/2}`);path.setAttribute('class',`edge ${ticketById(d).status==='done'?'done':''}`);svg.append(path);})); tickets.forEach(t=>{const p=pos[t.id],[done,total]=acProgress(t),g=document.createElementNS('http://www.w3.org/2000/svg','g');g.setAttribute('class',`node ${t.status} ${activeProject().selectedTicketId===t.id?'selected':''} ${t.status!=='done'&&depsDone(t)?'next':''}`);g.setAttribute('transform',`translate(${p.x},${p.y})`); const title=wrap(t.title,24);g.innerHTML=`<rect width="${w}" height="${h}" rx="8"/><text class="node-code" x="13" y="19">${esc(t.id)}</text><text class="node-meta" x="${w-13}" y="19" text-anchor="end">${t.effort} · ${effortXP[t.effort]}XP</text><text class="node-title" x="13" y="45">${esc(title[0])}</text>${title[1]?`<text class="node-title" x="13" y="61">${esc(title[1])}</text>`:''}<text class="node-status" x="13" y="80">${done}/${total} AC · ${t.status==='done'?'✓':statusText(t.status)}</text>`;g.onclick=()=>select(t.id);svg.append(g);}); }
function wrap(text, n){const a=['',''];text.split(' ').forEach(word=>{const i=(a[0]+' '+word).trim().length<=n?0:1;a[i]=(a[i]+' '+word).trim();});return a;}
function select(id){const project=activeProject(); if(!project) return; project.selectedTicketId=id; save(); renderMap(); renderTicket();}

function renderTicket() { const project = activeProject(); const id = project?.selectedTicketId; const t = ticketById(id); $('#emptyTicket').hidden = !!t; $('#ticketDetails').hidden = !t; if(!t) return; const [done,total] = acProgress(t), deps = t.deps.map(x => `${x} ${ticketById(x)?.status==='done'?'✓':''}`).join(''); const sessions = t.sessions.length ? t.sessions.slice().reverse().map(s => `<article class="session"><time>${esc(s.date)}</time><strong>${esc(s.summary)}</strong><p>${esc(s.nextSteps || '')}</p></article>`).join('') : '<p>No formal session reports yet.</p>'; $('#ticketDetails').innerHTML=`<div class="ticket-head"><span class="ticket-code">${esc(t.id)} · ${t.effort} · ${effortXP[t.effort]} XP</span><h2>${esc(t.title)}</h2><span class="status-pill ${t.status}">${statusText(t.status)}</span></div><div class="ticket-actions"><button class="button primary" data-action="brief">Copy session brief</button><button class="button" data-action="report">Paste session report</button><button class="button" data-action="status">Advance status</button><button class="button" data-action="edit">Edit ticket</button></div><section class="detail-section"><h3>OVERVIEW</h3><p>${esc(t.description)}</p></section><section class="detail-section"><h3>ACCEPTANCE CRITERIA · ${done}/${total}</h3><ul>${t.acceptanceCriteria.map((a,i)=>`<li><input data-ac="${i}" type="checkbox" ${a.done?'checked':''}><span>${esc(a.text)}</span></li>`).join('')}</ul></section><section class="detail-section"><h3>DEFINITION OF DONE</h3><p>${esc(t.definitionOfDone)}</p></section><section class="detail-section"><h3>TECHNICAL NOTES</h3><p>${esc(t.technicalNotes)}</p></section><section class="detail-section"><h3>DEPENDENCIES</h3><div class="dep-list">${t.deps.length?t.deps.map(d=>`<span class="chip">${esc(d)} ${ticketById(d)?.status==='done'?'✓':''}</span>`).join(''):'<span class="chip">No prerequisites</span>'}</div></section><section class="detail-section"><h3>SCRATCHPAD</h3><textarea id="scratchpad" placeholder="Loose thoughts, links, and reminders…">${esc(t.scratchpad)}</textarea></section><section class="detail-section"><h3>SESSION HISTORY</h3>${sessions}</section>`; $('#ticketDetails').querySelectorAll('[data-ac]').forEach(input=>input.onchange=()=>{t.acceptanceCriteria[input.dataset.ac].done=input.checked;save();renderAll();}); $('#scratchpad').oninput=e=>{t.scratchpad=e.target.value;save();}; $('#ticketDetails').querySelector('[data-action="brief"]').onclick=()=>copyBrief(t);$('#ticketDetails').querySelector('[data-action="report"]').onclick=()=>openReport(t);$('#ticketDetails').querySelector('[data-action="status"]').onclick=()=>{t.status=({todo:'in_progress',in_progress:'done',done:'todo'})[t.status];save();renderAll();};$('#ticketDetails').querySelector('[data-action="edit"]').onclick=()=>openTicketForm(t); }

function brief(t) { const deps=t.deps.length?t.deps.map(id=>`- ${id}: ${ticketById(id).status === 'done' ? '✅ done' : 'not complete'}`).join('\n'):'- None — this ticket is ready to start.'; const decisions=activeProject().decisions.map(d=>`- ${d.id}: ${d.decision} — ${d.rationale}`).join('\n');const questions=openQuestions().map(q=>`- [${q.lane}] ${q.text}`).join('\n') || '- None';const last=t.sessions.at(-1);return `# DevTracker Session Brief\n\n## Ticket: ${t.id} — ${t.title}\nStatus: ${statusText(t.status)}\n\n### Goal\n${t.description}\n\n### Dependencies\n${deps}\n\n### Acceptance criteria\n${t.acceptanceCriteria.map(a=>`- [${a.done?'x':' '}] ${a.text}`).join('\n')}\n\n### Definition of done\n${t.definitionOfDone}\n\n### Technical notes\n${t.technicalNotes}\n\n### Project decisions\n${decisions}\n\n### Open questions\n${questions}\n${last?`\n### Last session\n${last.summary}\nNext: ${last.nextSteps}\n`:''}\n## End this session with this exact format\n\`\`\`session-report\nTicket: ${t.id}\nSummary: <what changed>\nCompleted AC: <comma-separated AC numbers, e.g. 1, 3>\nDecisions: <decision and rationale, or None>\nOpen Questions: <question, or None>\nNext Steps: <what should happen next>\nStatus: <todo | in_progress | done>\n\`\`\``; }
async function copyBrief(t){try{await navigator.clipboard.writeText(brief(t));toast('Session brief copied — paste it into your AI chat.');}catch{toast('Clipboard unavailable; copy from the dialog instead.');openTextDialog('Session brief',brief(t));}}
function openTextDialog(title,text){const d=$('#reportDialog');d.innerHTML=`<form method="dialog" class="dialog-body"><h2>${esc(title)}</h2><textarea class="report-format" style="min-height:340px">${esc(text)}</textarea><div class="dialog-actions"><button class="button primary">Close</button></div></form>`;d.showModal();}

function openReport(t){const d=$('#reportDialog');d.innerHTML=`<form class="dialog-body" id="reportForm"><h2>Paste Session Report</h2><p class="subcopy">Use the format from the session brief. Completed AC numbers and status are applied automatically.</p><div class="field"><label>Session report</label><textarea id="reportText" placeholder="Ticket: ${t.id}\nSummary: …\nCompleted AC: 1, 3\nDecisions: None\nOpen Questions: None\nNext Steps: …\nStatus: in_progress" required></textarea></div><div class="dialog-actions"><button class="button" type="button" data-close>Cancel</button><button class="button primary">Apply report</button></div></form>`;d.querySelector('[data-close]').onclick=()=>d.close();d.querySelector('form').onsubmit=e=>{e.preventDefault();applyReport(t,$('#reportText').value);d.close();};d.showModal();}
function field(text,key){return (text.match(new RegExp(`^${key}:\\s*(.*)$`,'im'))||[])[1]?.trim()||'';}
function applyReport(t,text){const ticket=field(text,'Ticket');if(ticket&&ticket!==t.id){toast(`Report names ${ticket}; it was not applied.`);return;}const summary=field(text,'Summary')||'Session report imported';const ac=field(text,'Completed AC');(ac.match(/\d+/g)||[]).map(Number).forEach(n=>{if(t.acceptanceCriteria[n-1])t.acceptanceCriteria[n-1].done=true;});const status=field(text,'Status');if(['todo','in_progress','done'].includes(status))t.status=status;const date=new Date().toISOString().slice(0,10);t.sessions.push({date,summary,nextSteps:field(text,'Next Steps'),raw:text});const project=activeProject();const decision=field(text,'Decisions');if(decision&&decision.toLowerCase()!=='none')project.decisions.push({id:`ADR-${String(project.decisions.length+1).padStart(3,'0')}`,date,decision,rationale:'Captured from session report.'});const question=field(text,'Open Questions');if(question&&question.toLowerCase()!=='none')project.questions.push({id:`Q-${String(project.questions.length+1).padStart(3,'0')}`,lane:'agent',text:question,resolved:false});save();renderAll();toast('Session report applied. Context is now saved.');}

function ticketIntent(form) { const id=form.elements.id.value.trim(), title=form.elements.title.value.trim(), desc=form.elements.description.value.trim(); return { id, title, seed: desc || title || id || 'new engineering ticket' }; }
function aiEnhancedTicketDraft(form) { const intent=ticketIntent(form), name=intent.title || intent.id || 'this ticket'; const existingDeps=activeProject().tickets.filter(t=>t.status!=='done').slice(0,3).map(t=>t.id).join(', ') || 'None'; return {
  description: `Deliver ${name} as a narrow, testable engineering change. Clarify the expected behavior, touch only the necessary project surface, and leave enough implementation notes for a future AI session to continue without re-discovery.`,
  ac: [`The intended behavior for ${name} is implemented and visible through the relevant UI, API, or workflow`, 'Validation, empty states, and failure paths are handled with actionable feedback', 'The change is covered by a focused manual or automated verification step', 'Session notes capture any important follow-up, tradeoff, or decision'].join('\n'),
  dod: `${name} is complete when the implementation works from a fresh reload, the verification path is documented, and the ticket brief gives the next AI session enough context to resume safely.`,
  notes: `AI enhancement draft:\n- Suggested current dependencies to consider: ${existingDeps}\n- Keep the ticket scoped to one shippable behavior.\n- Prefer explicit acceptance criteria over broad intent.\n- At session end, paste a session report so progress, decisions, and questions stay synchronized.`
}; }
function activeProvider(){return aiSettings.providers.find(p=>p.id===aiSettings.activeProviderId)||aiSettings.providers[0];}
function applyTicketDraft(form,draft){const fields={description:'description',ac:'ac',dod:'dod',notes:'notes'};Object.entries(fields).forEach(([key,name])=>{if(draft[key]&&!form.elements[name].value.trim())form.elements[name].value=draft[key];});}
function ticketEnhancePrompt(form){const intent=ticketIntent(form), open=openQuestions().map(q=>q.text).join('; ')||'None';const project=activeProject();return `You are helping draft a DevTracker engineering ticket. Return only JSON with keys description, ac, dod, notes. ac must be one string with one acceptance criterion per line.

Project: ${project?.name || 'Unnamed project'}
Ticket code: ${intent.id || 'unset'}
Ticket title: ${intent.title || 'unset'}
Seed description: ${intent.seed}
Existing ticket ids: ${project?.tickets.map(t=>`${t.id}: ${t.title}`).join('; ')}
Open project questions: ${open}

Make the ticket implementation-ready for a human plus AI coding session. Keep it concise, concrete, and testable.`;}
function parseAiDraft(text){const match=text.match(/\{[\s\S]*\}/);if(!match)throw Error('No JSON object returned.');const data=JSON.parse(match[0]);return {description:data.description||'',ac:Array.isArray(data.ac)?data.ac.join('\n'):(data.ac||''),dod:data.dod||data.definitionOfDone||'',notes:data.notes||data.technicalNotes||''};}
async function requestAiDraft(form,provider){
  const headers = {'Content-Type':'application/json'};
  if (provider.apiKey) headers.Authorization = 'Bearer ' + provider.apiKey;

  const payload = {
    messages: [
      { role: 'system', content: 'Return compact valid JSON only. Do not wrap it in markdown.' },
      { role: 'user', content: ticketEnhancePrompt(form) }
    ],
    temperature: 0.25
  };
  if (provider.model) payload.model = provider.model;

  const res = await fetch(provider.endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw Error(`AI request failed (${res.status})${errorText ? `: ${errorText.slice(0,120)}` : ''}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || data.output_text || '';
  return parseAiDraft(text);
}
async function enhanceTicketForm(form) { const provider=activeProvider(); if(provider.type==='local'||!provider.apiKey||!provider.endpoint){applyTicketDraft(form,aiEnhancedTicketDraft(form));toast(provider.type==='local'?'Local AI-style draft added.':'Provider is missing a key or endpoint; local draft added.');return;} const button=form.querySelector('[data-ai-enhance]');button.disabled=true;button.textContent='Enhancing...';try{applyTicketDraft(form,await requestAiDraft(form,provider));toast(`Enhanced with ${provider.name}.`);}catch(err){applyTicketDraft(form,aiEnhancedTicketDraft(form));toast(`${err.message} Local draft added instead.`);}finally{button.disabled=false;button.textContent='Enhance';} }

function openTicketForm(existing){const project=activeProject();const t=existing||{id:'',title:'',effort:'S',line:'default',deps:[],description:'',definitionOfDone:'',technicalNotes:'',acceptanceCriteria:[]}, provider=activeProvider();const d=$('#ticketDialog');d.innerHTML=`<form class="dialog-body" id="ticketForm"><h2>${existing?'Edit':'New'} ticket</h2>${existing?'':`<div class="ai-panel"><div><strong>AI enhancement</strong><p>Active: ${esc(provider.name)}${provider.type!=='local'&&!provider.apiKey?' - add API key in settings':''}</p></div><div class="ai-actions"><button class="button" type="button" data-ai-settings>Settings</button><button class="button" type="button" data-ai-enhance>Enhance</button></div></div>`}<div class="form-grid"><div class="field"><label>Ticket code</label><input name="id" value="${esc(t.id)}" ${existing?'readonly':''} required></div><div class="field"><label>Effort</label><select name="effort">${['XS','S','M','L'].map(x=>`<option ${x===t.effort?'selected':''}>${x}</option>`).join('')}</select></div></div><div class="field"><label>Title</label><input name="title" value="${esc(t.title)}" required></div><div class="field"><label>Description</label><textarea name="description">${esc(t.description)}</textarea></div><div class="field"><label>Acceptance criteria (one per line)</label><textarea name="ac">${esc(t.acceptanceCriteria.map(a=>a.text).join('\n'))}</textarea></div><div class="field"><label>Definition of done</label><textarea name="dod">${esc(t.definitionOfDone)}</textarea></div><div class="field"><label>Technical notes</label><textarea name="notes">${esc(t.technicalNotes)}</textarea></div><div class="dialog-actions"><button class="button" type="button" data-close>Cancel</button><button class="button primary">Save ticket</button></div></form>`;d.querySelector('[data-close]').onclick=()=>d.close();const enhance=d.querySelector('[data-ai-enhance]');if(enhance)enhance.onclick=()=>enhanceTicketForm(d.querySelector('form'));const settings=d.querySelector('[data-ai-settings]');if(settings)settings.onclick=()=>openAiSettings();d.querySelector('form').onsubmit=e=>{e.preventDefault();const f=new FormData(e.target),item={...t,id:f.get('id').trim(),title:f.get('title').trim(),effort:f.get('effort'),description:f.get('description'),definitionOfDone:f.get('dod'),technicalNotes:f.get('notes'),acceptanceCriteria:f.get('ac').split('\n').filter(Boolean).map((text,i)=>({text,done:t.acceptanceCriteria[i]?.done||false}))};if(!item.id||(!existing&&ticketById(item.id))){toast('Use a unique ticket code.');return;}if(existing)Object.assign(existing,item);else project.tickets.push(item);project.selectedTicketId=item.id;save();d.close();renderAll();};d.showModal();}

function openAiSettings(){const d=$('#aiDialog'), provider=activeProvider();d.innerHTML=`<form class="dialog-body" id="aiForm"><h2>AI settings</h2><p class="subcopy">Use Local draft with no key, or add an OpenAI-compatible provider such as Grok.</p><div class="field"><label>Active provider</label><select name="active">${aiSettings.providers.map(p=>`<option value="${esc(p.id)}" ${p.id===provider.id?'selected':''}>${esc(p.name)}</option>`).join('')}</select></div><div class="form-grid"><div class="field"><label>Name</label><input name="name" value="${esc(provider.name)}" ${provider.id==='local'?'readonly':''}></div><div class="field"><label>Model</label><input name="model" value="${esc(provider.model)}" ${provider.id==='local'?'readonly':''} placeholder="grok-4"></div></div><div class="field"><label>Endpoint</label><input name="endpoint" value="${esc(provider.endpoint)}" ${provider.id==='local'?'readonly':''} placeholder="https://api.x.ai/v1/chat/completions"></div><div class="field"><label>API key</label><input name="apiKey" type="password" value="${esc(provider.apiKey)}" ${provider.id==='local'?'readonly':''} placeholder="Paste your key here"></div><p class="settings-note">Keys are saved in this browser only. Use this for local/private workspaces, not shared browsers.</p><div class="dialog-actions"><button class="button" type="button" data-add-provider>Add custom provider</button><button class="button" type="button" data-close>Cancel</button><button class="button primary">Save settings</button></div></form>`;const form=d.querySelector('form');form.elements.active.onchange=()=>{aiSettings.activeProviderId=form.elements.active.value;saveAiSettings();openAiSettings();};d.querySelector('[data-add-provider]').onclick=()=>{const id=`custom-${Date.now()}`;aiSettings.providers.push({id,name:'Custom AI',type:'openai-compatible',endpoint:'',model:'',apiKey:''});aiSettings.activeProviderId=id;saveAiSettings();openAiSettings();};d.querySelector('[data-close]').onclick=()=>d.close();form.onsubmit=e=>{e.preventDefault();const p=activeProvider();if(p.id!=='local'){p.name=form.elements.name.value.trim()||p.name;p.model=form.elements.model.value.trim();p.endpoint=form.elements.endpoint.value.trim();p.apiKey=form.elements.apiKey.value.trim();}aiSettings.activeProviderId=form.elements.active.value;saveAiSettings();d.close();toast('AI settings saved.');};if(!d.open)d.showModal();}

function renderDecisions(){const project=activeProject();const el=$('#decisionsView');el.innerHTML=`<div class="view-head"><div><p class="eyebrow">ADR-LITE</p><h1>Project decisions</h1><p class="subcopy">Settled choices automatically travel with every AI session brief.</p></div><button class="button primary" id="addDecision">+ Decision</button></div><div class="list-card">${project.decisions.map(d=>`<article class="list-row"><span class="list-meta">${esc(d.id)} · ${esc(d.date)}</span><strong>${esc(d.decision)}</strong><p>${esc(d.rationale)}</p></article>`).join('')}</div>`;$('#addDecision').onclick=()=>openSimpleForm('decision');}
function renderQuestions(){const project=activeProject();const el=$('#questionsView');el.innerHTML=`<div class="view-head"><div><p class="eyebrow">CONTEXT QUEUE</p><h1>Open questions</h1><p class="subcopy">Questions remain visible in briefs until someone resolves them.</p></div><button class="button primary" id="addQuestion">+ Question</button></div><div class="list-card">${project.questions.map(q=>`<article class="list-row"><span class="question-lane">${q.lane} needs to decide</span><strong>${esc(q.text)}</strong><p><button class="button" data-resolve="${q.id}">${q.resolved?'Reopen':'Resolve'}</button></p></article>`).join('')}</div>`;$('#addQuestion').onclick=()=>openSimpleForm('question');el.querySelectorAll('[data-resolve]').forEach(b=>b.onclick=()=>{const q=project.questions.find(q=>q.id===b.dataset.resolve);q.resolved=!q.resolved;save();renderAll();});}

function loadProjectContext(){
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

function renderContext(){
  const el = $('#contextView');
  if(!el) return;
  el.innerHTML = `<div class="view-head"><div><p class="eyebrow">PROJECT CONTEXT</p><h1>Project context</h1><p class="subcopy">Project-level vision, architecture, and sprint plans live here.</p></div></div><div class="list-card"><pre class="context-doc">Loading project context…</pre></div>`;
  const contentEl = el.querySelector('.context-doc');
  loadProjectContext().then(text => {
    contentEl.textContent = text;
  }).catch(() => {
    el.querySelector('.list-card').innerHTML = `<p>Unable to load project context from <code>docs/PROJECT_CONTEXT.md</code>.</p><p><a href="docs/PROJECT_CONTEXT.md" target="_blank">Open the file directly</a>.</p>`;
  });
}

function requestAiText(prompt){const provider=activeProvider();if(provider.type==='local'||!provider.apiKey||!provider.endpoint){return Promise.resolve(`Local AI placeholder:\n\n${prompt.split('\n').slice(0,6).join('\n')}`);}const headers={'Content-Type':'application/json'};if(provider.apiKey)headers.Authorization='Bearer '+provider.apiKey;const payload={messages:[{role:'system',content:'You are an expert software architect and writing assistant.'},{role:'user',content:prompt}],temperature:0.2};if(provider.model)payload.model=provider.model;return fetch(provider.endpoint,{method:'POST',headers,body:JSON.stringify(payload)}).then(async res=>{if(!res.ok){const err=await res.text().catch(()=>'');throw Error(`AI request failed (${res.status})${err?`: ${err.slice(0,120)}`:''}`);}const data=await res.json();return data.choices?.[0]?.message?.content || data.output_text || data.result || ''});}

function renderArchitecture(){const el=$('#architectureView');if(!el)return;const project=activeProject();el.innerHTML=`<div class="view-head"><div><p class="eyebrow">ARCHITECTURE</p><h1>Architecture uploader & preview</h1><p class="subcopy">Upload diagram files (.png, .jpg, .svg, .drawio) or paste a description. Preview and open in your preferred editor.</p></div><div><button class="button" id="archUploadBtn">Upload</button><button class="button" id="archOpenDrawio">Open in diagrams.net</button><button class="button" id="archOpenExternal">Open in external editor</button><button class="button primary" id="archAiEnhance">AI enhance</button></div></div><div class="list-card"><div style="padding:18px"><input type="file" id="archInput" accept=".png,.jpg,.jpeg,.svg,.drawio,.xml" style="display:none"><div id="archPreview">${project.architecture && project.architecture.content?renderArchitecturePreviewHtml(project.architecture):'<p>No architecture uploaded yet.</p>'}</div><div style="margin-top:12px"><label>Description</label><textarea id="archDescription" style="width:100%;min-height:120px">${esc(project.architecture?.description || '')}</textarea></div></div></div>`;$('#archUploadBtn').onclick=()=>$('#archInput').click();const input=$('#archInput');input.onchange=e=>{const f=e.target.files[0];if(f)handleArchitectureFile(f);};$('#archOpenDrawio').onclick=()=>openInDrawio();$('#archOpenExternal').onclick=()=>openInExternalEditor();$('#archAiEnhance').onclick=()=>aiEnhanceArchitecture();const descEl=$('#archDescription');if(descEl){descEl.oninput=e=>{const p=activeProject();p.architecture=p.architecture||{};p.architecture.description=e.target.value;save();};} }

function renderArchitecturePreviewHtml(arch){if(!arch) return '<p>No architecture available.</p>';if((arch.type && arch.type.startsWith('image/')) || (arch.content && arch.content.startsWith('data:'))){return `<div style="text-align:center"><img src="${arch.content}" alt="${esc(arch.name)}" style="max-width:100%;height:auto;border:1px solid var(--line);border-radius:6px"/></div>`;}if(arch.type==='svg' || (arch.name && arch.name.toLowerCase().endsWith('.svg'))){return `<div class="svg-preview">${arch.content}</div>`;}return `<div><p><strong>${esc(arch.name)}</strong></p><pre style="white-space:pre-wrap;max-height:360px;overflow:auto;border:1px solid var(--line);padding:10px">${esc(String(arch.content || '').slice(0,4000))}${String(arch.content || '').length>4000? '\n\n…truncated':''}</pre><p><small>${esc(arch.type||'')}</small></p></div>`;}

function handleArchitectureFile(file){const reader=new FileReader();reader.onload=()=>{const project=activeProject();const text=reader.result;let type=file.type||'';if(file.name.toLowerCase().endsWith('.svg')) type='svg';if(type.startsWith('image/')||type==='svg'){project.architecture={name:file.name,type:type,content:text,description:project.architecture?.description||''};save();renderAll();toast('Architecture uploaded and previewed.');return;} // otherwise treat as text/xml (drawio)
project.architecture={name:file.name,type:file.type||'xml',content:text,description:project.architecture?.description||''};save();renderAll();toast('Architecture uploaded. Use "Open in diagrams.net" to view or download.');};if(file.name.toLowerCase().endsWith('.png')||file.name.toLowerCase().endsWith('.jpg')||file.name.toLowerCase().endsWith('.jpeg')||file.name.toLowerCase().endsWith('.svg')){reader.readAsDataURL(file);}else{reader.readAsText(file);} }

async function openInDrawio(){const project=activeProject();if(!project.architecture || !project.architecture.content){toast('No architecture to open.');return;}if(project.architecture.type==='svg' || project.architecture.name.toLowerCase().endsWith('.svg')){ // open SVG in new tab
  const w=window.open();w.document.write(project.architecture.content);return;}
// Try direct diagrams.net web import using compressed encoding when available (desktop main can compress)
if(window.desktopApi?.getDiagramsNetUrl){try{const res=await window.desktopApi.getDiagramsNetUrl(project.architecture.content);if(res && res.ok && res.url){if(window.desktopApi.openExternalUrl){await window.desktopApi.openExternalUrl(res.url);toast('Opening diagram in diagrams.net (browser).');}else{window.open(res.url,'_blank');}return;}else{console.warn('getDiagramsNetUrl failed',res);}}catch(err){console.error('diagrams URL generation failed',err);} }
// Fallback: prefer external editor if available
if(window.desktopApi?.openFileInExternalEditor){openInExternalEditor();return;} // otherwise provide a download and open instructions for diagrams.net web
const blob=new Blob([project.architecture.content],{type:project.architecture.type||'application/xml'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=project.architecture.name||'diagram.drawio';document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);toast('File downloaded. Open it in diagrams.net (app.diagrams.net) or upload via the web app.');}

async function aiEnhanceArchitecture(){const project=activeProject();const desc=project.architecture?.description||'';const name=project.architecture?.name||project.name||'Project architecture';const prompt=`Review the following architecture description and suggest concrete improvements, missing concerns, and a concise revised description.\n\nName: ${name}\n\nCurrent description:\n${desc}\n\nProvide:\n1) Short summary of improvements\n2) Bullet list of suggested changes or considerations\n3) A concise revised description (1 paragraph)`;try{const text=await requestAiText(prompt);openTextDialog('AI suggested architecture improvements',text); // allow copy/apply
 // Offer to apply revised description if it includes a 'revised description' section — user can copy manually
}catch(err){toast(err.message);} }


function renderGit(){const el=$('#gitView');if(!el)return;el.innerHTML=`<div class="view-head"><div><p class="eyebrow">GIT HISTORY</p><h1>Local repository history</h1><p class="subcopy">Inspect recent local commits from the current project repository.</p></div></div><div class="list-card"><p>Loading git history…</p></div>`;const card=el.querySelector('.list-card');if(!window.desktopApi?.getGitLog){card.innerHTML=`<p>Git history is available only in the desktop app.</p>`;return;} if(gitHistoryCache){card.innerHTML=renderGitEntries(gitHistoryCache);return;} window.desktopApi.getGitLog().then(entries=>{gitHistoryCache=entries;card.innerHTML=renderGitEntries(entries);}).catch(err=>{card.innerHTML=`<p>Unable to load git history: ${esc(err.message)}</p>`;});}

function renderGitEntries(entries){if(!entries.length)return '<p>No commits found in the local repository.</p>';return `<div class="git-log">${entries.map(entry=>`<article class="list-row"><strong>${esc(entry.subject)}</strong><p class="list-meta">${esc(entry.hash.slice(0,7))} · ${esc(entry.author)} · ${esc(entry.date)}</p><p>${esc(entry.body)}</p></article>`).join('')}</div>`;}

function openSimpleForm(kind){const project=activeProject();const d=kind==='decision'?$('#decisionDialog'):$('#questionDialog');const title=kind==='decision'?'Add a decision':'Add an open question';d.innerHTML=`<form class="dialog-body"><h2>${title}</h2><div class="field"><label>${kind==='decision'?'Decision':'Question'}</label><textarea name="text" required></textarea></div>${kind==='decision'?'<div class="field"><label>Rationale</label><textarea name="reason" required></textarea></div>':''}<div class="dialog-actions"><button class="button" type="button" data-close>Cancel</button><button class="button primary">Add</button></div></form>`;d.querySelector('[data-close]').onclick=()=>d.close();d.querySelector('form').onsubmit=e=>{e.preventDefault();const f=new FormData(e.target),date=new Date().toISOString().slice(0,10);if(kind==='decision')project.decisions.push({id:`ADR-${String(project.decisions.length+1).padStart(3,'0')}`,date,decision:f.get('text'),rationale:f.get('reason')});else project.questions.push({id:`Q-${String(project.questions.length+1).padStart(3,'0')}`,lane:'human',text:f.get('text'),resolved:false});save();d.close();renderAll();};d.showModal();}

function setView(view){['map','context','architecture','git','decisions','questions'].forEach(v=>{$(`#${v}View`).hidden=v!==view;if(v==='map')$('#ticketPanel').hidden=false;});if(view!=='map')$('#ticketPanel').hidden=true;document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.view===view));}
function exportState(){const blob=new Blob([JSON.stringify(workspace,null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='devtracker-workspace.json';a.click();URL.revokeObjectURL(a.href);toast('Workspace exported as JSON.');}
function importState(file){const reader=new FileReader();reader.onload=()=>{try{const data=JSON.parse(reader.result);const imported=migrateWorkspace({...data,version:3});if(!Array.isArray(imported.projects))throw Error();workspace=imported;save();renderAll();toast('Workspace imported.');}catch{toast('That file is not a valid DevTracker workspace.');}};reader.readAsText(file);}

$('#newTicketButton').onclick=()=>openTicketForm();$('#addProjectButton').onclick=()=>addProject();$('#aiSettingsButton').onclick=()=>openAiSettings();$('#exportButton').onclick=exportState;$('#importButton').onclick=()=>$('#importInput').click();$('#importInput').onchange=e=>e.target.files[0]&&importState(e.target.files[0]);document.querySelectorAll('.nav-item').forEach(b=>b.onclick=()=>setView(b.dataset.view));renderAll();

// --- Desktop/external editor + AI apply enhancements ---
function extractRevisedDescription(text){if(!text) return '';const m=text.match(/(?:^|\n)\s*(?:3\)|3\.|3-|Revised description[:\-]?)[^\n]*\n([\s\S]*)/i);if(m && m[1]){const part=m[1].trim();const paragraphs=part.split(/\n\s*\n/).map(p=>p.trim()).filter(Boolean);return paragraphs[0]||part;}const parts=text.split(/\n\s*\n/).map(p=>p.trim()).filter(Boolean);if(parts.length) return parts[parts.length-1];return text.trim();}

function openAiSuggestionDialog(title,fullText,suggested){const project=activeProject();const d=$('#reportDialog');d.innerHTML=`<form class="dialog-body"><h2>${esc(title)}</h2><p class="subcopy">AI output is below. Review and optionally apply the extracted revised description to the project's architecture.</p><div class="field"><label>Full AI output</label><textarea id="aiFullOutput" style="min-height:260px">${esc(fullText)}</textarea></div><div class="field"><label>Suggested concise revised description (extracted)</label><textarea id="aiSuggested" style="min-height:120px">${esc(suggested)}</textarea></div><div class="dialog-actions"><button class="button" type="button" data-copy>Copy</button><button class="button" type="button" data-apply>Apply as architecture description</button><button class="button" type="button" data-close>Close</button></div></form>`;d.querySelector('[data-close]').onclick=()=>d.close();d.querySelector('[data-copy]').onclick=async()=>{const area=$('#aiFullOutput');try{await navigator.clipboard.writeText(area.value);toast('AI output copied to clipboard.');}catch{toast('Copy failed; select and copy manually.');}};d.querySelector('[data-apply]').onclick=()=>{const val=$('#aiSuggested').value.trim();if(!val){toast('No suggested text to apply.');return;}const p=activeProject();p.architecture=p.architecture||{};p.architecture.description=val;save();renderAll();toast('Applied AI suggestion to architecture description.');d.close();};d.showModal();}

async function openInExternalEditor(){const project=activeProject();if(!project.architecture || !project.architecture.content){toast('No architecture to open.');return;}if(window.desktopApi?.openFileInExternalEditor){try{const res=await window.desktopApi.openFileInExternalEditor(project.architecture.name||'diagram',project.architecture.content,project.architecture.type||'application/octet-stream');if(res && res.ok){toast('Opened file in external editor.');return;}else{console.warn('openFileInExternalEditor result',res);} }catch(err){console.error(err);toast('Unable to open external editor.');}}// fallback to download
const blob=new Blob([project.architecture.content],{type:project.architecture.type||'application/xml'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=project.architecture.name||'diagram.drawio';document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);toast('File downloaded. Open it with your external editor or in diagrams.net.');}
