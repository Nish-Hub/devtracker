const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopApi', {
  readFile: filePath => ipcRenderer.invoke('read-file', filePath),
  getGitLog: () => ipcRenderer.invoke('get-git-log'),
  getGitDiff: range => ipcRenderer.invoke('get-git-diff', range),
  indexRepo: projectId => ipcRenderer.invoke('index-repo', projectId),
  aiRequest: req => ipcRenderer.invoke('ai-request', req),
  openFileInExternalEditor: (name, content, type) =>
    ipcRenderer.invoke('open-file-external', { name, content, type }),
  getDiagramsNetUrl: content => ipcRenderer.invoke('get-diagrams-url', content),
  openExternalUrl: url => ipcRenderer.invoke('open-external-url', url),
  writeAdrFile: (id, title, content) => ipcRenderer.invoke('write-adr-file', id, title, content),
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
