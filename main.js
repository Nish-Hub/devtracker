const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { exec } = require('child_process');
const zlib = require('zlib');
const store = require('./store/workspace-store');
const ingest = require('./store/ingest');

// Shared workspace store: the source of truth both the UI and the MCP server use.
// Use store.defaultStorePath() (not app.getPath('userData')) so the app and the
// MCP server resolve the SAME file by default, including in dev where Electron's
// userData would otherwise be ".../Electron". Override with DEVTRACKER_STORE.
const STORE_PATH = process.env.DEVTRACKER_STORE || store.defaultStorePath();

let mainWindowRef = null;
let selfWriteAt = 0; // suppress the file-watch echo of our own writes
let storeWatcher = null;

function watchStore() {
  if (storeWatcher) return;
  const dir = path.dirname(STORE_PATH);
  const file = path.basename(STORE_PATH);
  try {
    fsSync.mkdirSync(dir, { recursive: true });
    storeWatcher = fsSync.watch(dir, (_event, changed) => {
      if (changed && changed !== file) return;
      if (Date.now() - selfWriteAt < 600) return; // ignore our own save
      if (mainWindowRef && !mainWindowRef.isDestroyed()) {
        mainWindowRef.webContents.send('store:changed');
      }
    });
  } catch (err) {
    console.warn('Unable to watch workspace store:', err.message);
  }
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 860,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      enableRemoteModule: false,
    },
  });

  mainWindowRef = mainWindow;
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  if (process.env.ELECTRON_DEBUG) {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(() => {
  createWindow();
  watchStore();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('read-file', async (_, filePath) => {
  // Confine reads to the app directory (no path traversal).
  const base = __dirname;
  const fullPath = path.resolve(base, filePath);
  if (fullPath !== base && !fullPath.startsWith(base + path.sep)) {
    throw new Error('Access denied: path escapes the application directory.');
  }
  return fs.readFile(fullPath, 'utf8');
});

// ---- Shared workspace store (source of truth for UI + MCP server) ----------
ipcMain.handle('store:get', async () => {
  try {
    return store.loadWorkspace(STORE_PATH);
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('store:save', async (_, ws) => {
  try {
    if (!ws || !Array.isArray(ws.projects)) throw new Error('Invalid workspace payload.');
    const p = store.saveWorkspace(STORE_PATH, ws);
    selfWriteAt = Date.now();
    return { ok: true, path: p };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('store:path', async () => STORE_PATH);

// Proxy AI provider calls through the main process. Third-party AI APIs
// (xAI/OpenAI-compatible) block browser CORS, so a direct fetch from the
// renderer fails; running it here (Node) avoids CORS and keeps the API key
// out of the renderer process.
ipcMain.handle('ai-request', async (_, { endpoint, apiKey, payload }) => {
  try {
    const url = new URL(String(endpoint || ''));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error(`Unsupported endpoint scheme: ${url.protocol}`);
    }
    // Electron's Node 18 fetch resolves "localhost" to ::1 first, but local
    // model servers (Ollama) bind IPv4-only → ECONNREFUSED. Pin to 127.0.0.1.
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
    let res;
    try {
      res = await fetch(url.href, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload || {}),
      });
    } catch (err) {
      const code = err.cause?.code || err.cause?.errors?.[0]?.code || '';
      if (url.port === '11434' && (code === 'ECONNREFUSED' || err.message === 'fetch failed')) {
        return {
          ok: false,
          error:
            'Ollama is not reachable — start it with `ollama serve` (or launch the Ollama app), then retry.',
        };
      }
      throw err;
    }
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (_) {
      /* non-JSON response */
    }
    if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 400) };
    return { ok: true, data: data != null ? data : text };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Streaming AI call: forwards token deltas to the renderer over a per-request
// channel so the UI can show the model "thinking" live. Same localhost pin.
const streamControllers = new Map(); // streamId -> AbortController
ipcMain.handle('ai-abort', async (_, { streamId }) => {
  const c = streamControllers.get(streamId);
  if (c) c.abort();
  return { ok: true };
});
ipcMain.handle('ai-stream', async (_, { endpoint, apiKey, payload, streamId }) => {
  const channel = 'ai-stream:' + streamId;
  const send = ev => {
    if (mainWindowRef && !mainWindowRef.isDestroyed()) mainWindowRef.webContents.send(channel, ev);
  };
  const controller = new AbortController();
  streamControllers.set(streamId, controller);
  // Watchdog: if the model produces nothing for 60s, abort so the UI can't hang.
  let lastData = Date.now();
  let timedOut = false;
  const watchdog = setInterval(() => {
    if (Date.now() - lastData > 60000) {
      timedOut = true;
      controller.abort();
    }
  }, 5000);
  try {
    const url = new URL(String(endpoint || ''));
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      throw new Error(`Unsupported scheme: ${url.protocol}`);
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
    const res = await fetch(url.href, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...(payload || {}), stream: true }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      const t = await res.text().catch(() => '');
      send({ error: `HTTP ${res.status}${t ? ': ' + t.slice(0, 200) : ''}` });
      return { ok: false };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      lastData = Date.now();
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          const delta = j.choices?.[0]?.delta?.content || '';
          if (delta) send({ delta });
        } catch {
          /* partial line; ignore */
        }
      }
    }
    send({ done: true });
    return { ok: true };
  } catch (err) {
    if (err.name === 'AbortError') {
      if (timedOut) {
        send({
          error:
            'The model stalled (no output for 60s) and was stopped. A 3B model can struggle with large tasks — try a smaller ask or the 7B model.',
        });
        return { ok: false };
      }
      send({ aborted: true });
      return { ok: true, aborted: true };
    }
    const code = err.cause?.code || err.message;
    send({ error: url_11434_hint(endpoint, code) });
    return { ok: false };
  } finally {
    clearInterval(watchdog);
    streamControllers.delete(streamId);
  }
});
function url_11434_hint(endpoint, code) {
  if (/:11434/.test(String(endpoint)) && (code === 'ECONNREFUSED' || code === 'fetch failed')) {
    return 'Ollama is not reachable — start it (menu-bar app or `ollama serve`), then retry.';
  }
  return code;
}

// Cheap liveness probe for a provider endpoint: any HTTP response (even 404)
// means the server is reachable; connection errors mean it is not. Same
// localhost→127.0.0.1 pinning as ai-request (Electron Node-18 IPv6 gotcha).
ipcMain.handle('ai-ping', async (_, { endpoint }) => {
  try {
    const url = new URL(String(endpoint || ''));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error(`Unsupported endpoint scheme: ${url.protocol}`);
    }
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
    const base = `${url.protocol}//${url.host}/`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    try {
      const res = await fetch(base, { method: 'GET', signal: ctrl.signal });
      return { ok: true, status: res.status };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { ok: false, error: err.cause?.code || err.message };
  }
});

ipcMain.handle('write-adr-file', async (_, id, title, content) => {
  try {
    const repoPath = app.isPackaged ? process.resourcesPath : __dirname;
    const adrDir = path.join(repoPath, 'docs', 'adr');
    await fs.mkdir(adrDir, { recursive: true });
    const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
    const fullPath = path.join(adrDir, `${safeId}.md`);
    await fs.writeFile(fullPath, content, 'utf8');
    return { ok: true, path: fullPath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---- Coder tools: file + shell access scoped to a user-picked workdir --------
// Every path is resolved and confirmed to live inside the chosen workdir; commands
// run with that workdir as cwd. Writes/commands are gated in the renderer (diff →
// Apply, command → Run) so the human approves before these handlers are ever hit.
const CODER_BLOCKED_DIRS = ['/', require('os').homedir()];
function resolveInWorkdir(workdir, rel) {
  if (!workdir || typeof workdir !== 'string') throw new Error('No working directory selected.');
  const base = path.resolve(workdir);
  const full = path.resolve(base, rel || '.');
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error('Access denied: path escapes the working directory.');
  }
  return { base, full };
}

ipcMain.handle('coder:pick-dir', async () => {
  const res = await dialog.showOpenDialog(mainWindowRef, { properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true };
  const dir = path.resolve(res.filePaths[0]);
  if (CODER_BLOCKED_DIRS.includes(dir)) {
    return {
      ok: false,
      error: 'Refusing to use your home or root directory — pick a specific project folder.',
    };
  }
  return { ok: true, path: dir };
});

const CODER_SKIP = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.cache',
  'coverage',
  '.DS_Store',
]);
async function walkCoderTree(base, rel, depth, acc, limit) {
  if (acc.length >= limit || depth > 6) return;
  let entries;
  try {
    entries = await fs.readdir(path.join(base, rel), { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => b.isDirectory() - a.isDirectory() || a.name.localeCompare(b.name));
  for (const e of entries) {
    if (acc.length >= limit) break;
    if (CODER_SKIP.has(e.name) || e.name.startsWith('.DS')) continue;
    const childRel = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) {
      acc.push({ path: childRel, dir: true, depth });
      await walkCoderTree(base, childRel, depth + 1, acc, limit);
    } else {
      acc.push({ path: childRel, dir: false, depth });
    }
  }
}
ipcMain.handle('coder:tree', async (_, { workdir }) => {
  try {
    const base = path.resolve(workdir || '');
    if (!base || CODER_BLOCKED_DIRS.includes(base)) throw new Error('Invalid working directory.');
    const acc = [];
    await walkCoderTree(base, '', 0, acc, 600);
    return { ok: true, items: acc };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('coder:list-dir', async (_, { workdir, rel }) => {
  try {
    const { full } = resolveInWorkdir(workdir, rel);
    const entries = await fs.readdir(full, { withFileTypes: true });
    const items = entries
      .filter(e => e.name !== '.git' && e.name !== 'node_modules')
      .slice(0, 300)
      .map(e => ({ name: e.name, dir: e.isDirectory() }))
      .sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name));
    return { ok: true, items };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('coder:read-file', async (_, { workdir, rel }) => {
  try {
    const { full } = resolveInWorkdir(workdir, rel);
    const stat = await fs.stat(full);
    if (stat.isDirectory()) throw new Error('Path is a directory.');
    if (stat.size > 400 * 1024)
      return { ok: false, error: 'File too large (>400 KB) to read into the model.' };
    return { ok: true, content: await fs.readFile(full, 'utf8') };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('coder:write-file', async (_, { workdir, rel, content }) => {
  try {
    const { full } = resolveInWorkdir(workdir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, String(content == null ? '' : content), 'utf8');
    return { ok: true, path: full };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('coder:run-command', async (_, { workdir, command }) => {
  try {
    const base = path.resolve(workdir || '');
    if (!base || CODER_BLOCKED_DIRS.includes(base)) throw new Error('Invalid working directory.');
    if (!command || !String(command).trim()) throw new Error('Empty command.');
    const out = await new Promise(resolve => {
      exec(
        String(command),
        { cwd: base, timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          resolve({
            code: error ? error.code || 1 : 0,
            stdout: stdout || '',
            stderr:
              stderr || (error && error.killed ? 'Command timed out.' : error ? error.message : ''),
          });
        }
      );
    });
    return { ok: true, ...out };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

function runGit(command, cwd) {
  return new Promise((resolve, reject) => {
    exec(command, { cwd, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr.trim() || error.message));
      resolve(stdout);
    });
  });
}

function parseNumstat(stdout) {
  const map = {};
  stdout
    .split('\x1e')
    .filter(Boolean)
    .forEach(chunk => {
      const lines = chunk
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);
      const hash = lines.shift();
      if (!hash) return;
      let additions = 0,
        deletions = 0,
        files = 0;
      lines.forEach(line => {
        const [add, del] = line.split('\t');
        files += 1;
        if (add !== '-') additions += Number(add) || 0;
        if (del !== '-') deletions += Number(del) || 0;
      });
      map[hash] = { additions, deletions, files };
    });
  return map;
}

ipcMain.handle('get-git-log', async () => {
  const repoPath = app.isPackaged ? process.resourcesPath : __dirname;
  const logCommand =
    'git log --pretty=format:%H%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%b%x1e --date=iso --max-count=100';
  const statCommand = 'git log --numstat --format=%x1e%H --max-count=100';

  try {
    const stats = await fs.stat(repoPath);
    if (!stats.isDirectory()) {
      throw new Error(`Configured repository path is not a directory: ${repoPath}`);
    }
  } catch (err) {
    throw new Error(`Unable to access repository path: ${repoPath}. ${err.message}`);
  }

  const gitDir = path.join(repoPath, '.git');
  try {
    const gitStats = await fs.stat(gitDir);
    if (!gitStats.isDirectory()) {
      throw new Error('No .git directory found at the repository path.');
    }
  } catch {
    throw new Error(
      `No .git directory found in ${repoPath}. Git history is only available when the app runs from a git repository.`
    );
  }

  const [logOut, statOut] = await Promise.all([
    runGit(logCommand, repoPath),
    runGit(statCommand, repoPath),
  ]);
  const statMap = parseNumstat(statOut);
  const rawEntries = logOut.split('\x1e').filter(Boolean);
  return rawEntries.map(raw => {
    const [hash, author, email, date, subject, body] = raw.split('\x1f');
    const stats = statMap[hash] || { additions: 0, deletions: 0, files: 0 };
    return { hash, author, email, date, subject, body: body?.trim() || '', ...stats };
  });
});

// Resolve a milestone's diff range through git for the milestone detail view.
// Refs come from agent-supplied data, so validate strictly before shelling out.
const SAFE_REF = /^[\w./~^-]{1,100}$/;
ipcMain.handle('get-git-diff', async (_, range) => {
  try {
    const from = String((range && range.from) || '').trim();
    const to = String((range && range.to) || '').trim();
    if (!SAFE_REF.test(from) || !SAFE_REF.test(to)) {
      throw new Error('Invalid commit reference.');
    }
    const repoPath = app.isPackaged ? process.resourcesPath : __dirname;
    const stat = await runGit(`git diff --stat ${from}..${to}`, repoPath);
    const patch = await runGit(`git diff --no-color ${from}..${to}`, repoPath);
    const MAX = 60000;
    return {
      ok: true,
      stat: stat.trim(),
      patch: patch.slice(0, MAX),
      truncated: patch.length > MAX,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Index the repo's code + docs into the active project's context chunks.
ipcMain.handle('index-repo', async (_, projectId) => {
  try {
    const repoPath = app.isPackaged ? process.resourcesPath : __dirname;
    const res = ingest.ingestIntoStore(STORE_PATH, projectId, repoPath);
    return { ok: true, ...res };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('open-file-external', async (_, { name, content }) => {
  try {
    let buffer;
    if (typeof content === 'string' && content.startsWith('data:')) {
      const m = content.match(/^data:([^;]+)(;base64)?,(.*)$/);
      if (m) {
        const isBase64 = !!m[2];
        const dataPart = m[3];
        buffer = isBase64
          ? Buffer.from(dataPart, 'base64')
          : Buffer.from(decodeURIComponent(dataPart), 'utf8');
      } else {
        buffer = Buffer.from(content, 'utf8');
      }
    } else if (typeof content === 'string') {
      buffer = Buffer.from(content, 'utf8');
    } else if (Buffer.isBuffer(content)) {
      buffer = content;
    } else {
      buffer = Buffer.from(String(content), 'utf8');
    }

    const safeName = (name || 'diagram').replace(/[^a-zA-Z0-9_.-]/g, '_');
    const tmpPath = path.join(app.getPath('temp'), `devtracker-${Date.now()}-${safeName}`);
    await fs.writeFile(tmpPath, buffer);

    const result = await shell.openPath(tmpPath);
    if (result) {
      return { ok: false, error: result };
    }
    return { ok: true, path: tmpPath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('get-diagrams-url', async (_, content) => {
  try {
    if (typeof content !== 'string') content = String(content || '');
    // draw.io's #R fragment format: it decodes with decodeURIComponent -> atob
    // -> inflateRaw -> decodeURIComponent. So we must deflate encodeURIComponent(xml),
    // emit STANDARD base64 (atob rejects the -/_ of base64url), then
    // encodeURIComponent the base64 for safe placement in the URL fragment.
    const compressed = await new Promise((resolve, reject) => {
      zlib.deflateRaw(Buffer.from(encodeURIComponent(content), 'utf8'), (err, buf) => {
        if (err) return reject(err);
        resolve(buf);
      });
    });
    const b64 = compressed.toString('base64');
    const url = `https://app.diagrams.net/#R${encodeURIComponent(b64)}`;
    return { ok: true, url };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('open-external-url', async (_, url) => {
  try {
    // Only allow web schemes; block file:, javascript:, etc.
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Refusing to open non-web URL scheme: ${parsed.protocol}`);
    }
    await shell.openExternal(parsed.href);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
