import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('electronAPI', {
    checkServerStatus: () => ipcRenderer.invoke('check-server-status'),
    startServer: () => ipcRenderer.invoke('start-server'),
    stopServer: () => ipcRenderer.invoke('stop-server'),
});
//# sourceMappingURL=preload.js.map