const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFile: async () => {
    return await ipcRenderer.invoke('dialog:openFile');
  }
}); 