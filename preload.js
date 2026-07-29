const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopApi', {
  readFile: filePath => ipcRenderer.invoke('read-file', filePath),
  getGitLog: () => ipcRenderer.invoke('get-git-log'),
  getGitDiff: range => ipcRenderer.invoke('get-git-diff', range),
  indexRepo: projectId => ipcRenderer.invoke('index-repo', projectId),
  aiRequest: req => ipcRenderer.invoke('ai-request', req),
  aiPing: endpoint => ipcRenderer.invoke('ai-ping', { endpoint }),
  aiStream: (req, onEvent) => {
    const streamId = 'st_' + Math.random().toString(36).slice(2);
    const channel = 'ai-stream:' + streamId;
    const handler = (_e, ev) => {
      try {
        onEvent(ev);
      } catch (_) {
        /* ignore */
      }
    };
    ipcRenderer.on(channel, handler);
    const promise = ipcRenderer
      .invoke('ai-stream', { ...req, streamId })
      .finally(() => ipcRenderer.removeListener(channel, handler));
    // Expose an abort() on the returned promise so callers can stop mid-stream.
    promise.abort = () => ipcRenderer.invoke('ai-abort', { streamId });
    return promise;
  },
  openFileInExternalEditor: (name, content, type) =>
    ipcRenderer.invoke('open-file-external', { name, content, type }),
  getDiagramsNetUrl: content => ipcRenderer.invoke('get-diagrams-url', content),
  openExternalUrl: url => ipcRenderer.invoke('open-external-url', url),
  writeAdrFile: (id, title, content) => ipcRenderer.invoke('write-adr-file', id, title, content),
  // Coder tools — all scoped to a workdir the user picks, with path guards in main.
  coder: {
    pickDir: () => ipcRenderer.invoke('coder:pick-dir'),
    listDir: (workdir, rel) => ipcRenderer.invoke('coder:list-dir', { workdir, rel }),
    tree: workdir => ipcRenderer.invoke('coder:tree', { workdir }),
    readFile: (workdir, rel) => ipcRenderer.invoke('coder:read-file', { workdir, rel }),
    writeFile: (workdir, rel, content) =>
      ipcRenderer.invoke('coder:write-file', { workdir, rel, content }),
    runCommand: (workdir, command) => ipcRenderer.invoke('coder:run-command', { workdir, command }),
  },
  store: {
    get: () => ipcRenderer.invoke('store:get'),
    save: ws => ipcRenderer.invoke('store:save', ws),
    path: () => ipcRenderer.invoke('store:path'),
    onChanged: cb => {
      const handler = () => {
        try {
          cb();
        } catch (_) {
          /* ignore */
        }
      };
      ipcRenderer.on('store:changed', handler);
      return () => ipcRenderer.removeListener('store:changed', handler);
    },
  },
});
