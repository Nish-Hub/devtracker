const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const { exec } = require('child_process');

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
