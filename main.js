const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const { exec } = require('child_process');
const zlib = require('zlib');

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 860,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      enableRemoteModule: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  if (process.env.ELECTRON_DEBUG) {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(() => {
  createWindow();

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
  const fullPath = path.join(__dirname, filePath);
  return fs.readFile(fullPath, 'utf8');
});

ipcMain.handle('get-git-log', async () => {
  const repoPath = app.isPackaged ? process.resourcesPath : __dirname;
  const gitCommand = 'git log --pretty=format:%H%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%b%x1e --date=iso --max-count=100';

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
    throw new Error(`No .git directory found in ${repoPath}. Git history is only available when the app runs from a git repository.`);
  }

  return new Promise((resolve, reject) => {
    exec(gitCommand, { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        return reject(new Error(stderr.trim() || error.message));
      }

      const rawEntries = stdout.split('\x1e').filter(Boolean);
      const entries = rawEntries.map(raw => {
        const [hash, author, email, date, subject, body] = raw.split('\x1f');
        return { hash, author, email, date, subject, body: body?.trim() || '' };
      });
      resolve(entries);
    });
  });
});

ipcMain.handle('open-file-external', async (_, { name, content, type }) => {
  try {
    let buffer;
    if (typeof content === 'string' && content.startsWith('data:')) {
      const m = content.match(/^data:([^;]+)(;base64)?,(.*)$/);
      if (m) {
        const isBase64 = !!m[2];
        const dataPart = m[3];
        buffer = isBase64 ? Buffer.from(dataPart, 'base64') : Buffer.from(decodeURIComponent(dataPart), 'utf8');
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
    // Compress with raw deflate and base64url encode
    const compressed = await new Promise((resolve, reject) => {
      zlib.deflateRaw(Buffer.from(content, 'utf8'), (err, buf) => {
        if (err) return reject(err);
        resolve(buf);
      });
    });
    const b64 = compressed.toString('base64');
    // convert to base64url
    const b64url = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    const url = `https://app.diagrams.net/#R${b64url}`;
    return { ok: true, url };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('open-external-url', async (_, url) => {
  try {
    await shell.openExternal(url);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
