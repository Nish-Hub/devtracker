const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopApi', {
  readFile: filePath => ipcRenderer.invoke('read-file', filePath),
  getGitLog: () => ipcRenderer.invoke('get-git-log')
});
