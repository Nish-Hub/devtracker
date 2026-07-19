const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopApi', {
  readFile: filePath => ipcRenderer.invoke('read-file', filePath),
  getGitLog: () => ipcRenderer.invoke('get-git-log'),
  openFileInExternalEditor: (name, content, type) => ipcRenderer.invoke('open-file-external', { name, content, type }),
  getDiagramsNetUrl: content => ipcRenderer.invoke('get-diagrams-url', content),
  openExternalUrl: url => ipcRenderer.invoke('open-external-url', url)
});
