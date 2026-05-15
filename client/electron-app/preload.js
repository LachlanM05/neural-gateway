const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    toggleConnection: (creds) => ipcRenderer.invoke('toggle-connection', creds),
    toggleStartup: (enabled) => ipcRenderer.invoke('toggle-startup', enabled),
    toggleStats: (enabled) => ipcRenderer.invoke('toggle-stats', enabled),
    onStatus: (callback) => ipcRenderer.on('status-update', (event, val) => callback(val)),
    getVersion: () => ipcRenderer.invoke('get-version'),
    testLocalOllama: () => ipcRenderer.invoke('test-local-ollama'),
    testServerRoundtrip: (creds) => ipcRenderer.invoke('test-server-roundtrip', creds)
});

contextBridge.exposeInMainWorld('gatewaySetup', {
    configureOllama: () => ipcRenderer.invoke('run-setup-ollama'),
    openLlmfit: () => ipcRenderer.invoke('launch-llmfit'),
    openSetupWizard: () => ipcRenderer.invoke('open-setup-wizard'),
    triggerConnection: (creds) => ipcRenderer.invoke('trigger-connection', creds),
    getConnectionStatus: () => ipcRenderer.invoke('get-connection-status')
});

