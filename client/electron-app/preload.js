const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    toggleConnection: (creds) => ipcRenderer.invoke('toggle-connection', creds),
    toggleStartup: (enabled) => ipcRenderer.invoke('toggle-startup', enabled),
    toggleStats: (enabled) => ipcRenderer.invoke('toggle-stats', enabled),
    onStatus: (callback) => ipcRenderer.on('status-update', (event, val) => callback(val))
});