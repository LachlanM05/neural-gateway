const { app, BrowserWindow, ipcMain, Tray, Menu } = require('electron');
const path = require('path');
const WebSocket = require('ws');
const axios = require('axios');
const si = require('systeminformation');
const AutoLaunch = require('auto-launch');

// --- CONFIG ---
const DASHBOARD_URL = 'https://ai.lachlanm05.com';     
const GATEWAY_WS = 'wss://api.lachlanm05.com/tunnel';  
const LOCAL_OLLAMA = 'http://127.0.0.1:11434';

let mainWindow;
let tray;
let socket;
let isConnected = false;
let isManualDisconnect = false;
let heartbeatInterval;
let config = { sendStats: true, openOnStartup: false };

const autoLauncher = new AutoLaunch({ name: 'LachlanAI', path: app.getPath('exe') });

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 400, 
        height: 650, 
        resizable: false,
        icon: path.join(__dirname, 'icon.ico'),
        autoHideMenuBar: true,
        webPreferences: { 
            preload: path.join(__dirname, 'preload.js'), 
            nodeIntegration: false, 
            contextIsolation: true 
        },
        show: false
    });

    mainWindow.loadFile('index.html');

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    // Minimize to Tray instead of closing
    mainWindow.on('close', (event) => {
        if (!app.isQuiting) {
            event.preventDefault();
            mainWindow.hide();
        }
    });
}

function createTray() {
    const iconPath = path.join(__dirname, 'icon.ico');
    
    try {
        tray = new Tray(iconPath);
        
        const contextMenu = Menu.buildFromTemplate([
            { label: 'Open Interface', click: () => mainWindow.show() },
            { type: 'separator' },
            { label: 'Quit LachlanAI', click: () => { app.isQuiting = true; app.quit(); } }
        ]);

        tray.setToolTip('Lachlan AI Client');
        tray.setContextMenu(contextMenu);

        // Left-Click to Open
        tray.on('click', () => {
            if (mainWindow.isVisible()) {
                mainWindow.hide();
            } else {
                mainWindow.show();
                mainWindow.focus();
            }
        });

        // Double click backup
        tray.on('double-click', () => mainWindow.show());

    } catch (e) {
        console.error("Tray Icon Failed:", e);
    }
}

// --- DIAGNOSTICS ---
async function checkOllama() {
    try {
        await axios.get(LOCAL_OLLAMA);
        return true;
    } catch (e) {
        return false;
    }
}

function sendToUI(msg, type='info') {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('status-update', msg);
        if(type === 'error') console.error(msg);
        else console.log(msg);
    }
}

// --- TUNNEL LOGIC ---
async function connectTunnel(username, apiKey, slug) {
    if (isConnected) return;
    
    // Reset manual flag so we can reconnect
    isManualDisconnect = false;

    // 1. Check Ollama First
    const ollamaUp = await checkOllama();
    if (!ollamaUp) {
        sendToUI('Error: Local Ollama is OFFLINE (Check Port 11434)');
        return;
    }

    sendToUI(`Connecting to Gateway...`);
    
    // UPDATED: Pass username in URL query
    const wsUrl = `${GATEWAY_WS}?username=${username}&slug=${slug}&key=${apiKey}`;
    socket = new WebSocket(wsUrl);
    
    socket.on('open', () => {
        isConnected = true;
        sendToUI('Connected (Tunnel Active)');
        if (config.sendStats) sendSystemStats(apiKey, slug);

        // Heartbeat to keep connection alive
        clearInterval(heartbeatInterval);
        heartbeatInterval = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) {
                socket.ping(); 
            }
        }, 30000);
    });

    socket.on('message', async (data) => {
        try {
            const req = JSON.parse(data);
            sendToUI(`Processing: ${req.method} ...`);
            
            // Forward to Ollama
            const response = await axios({
                method: req.method,
                url: `${LOCAL_OLLAMA}/${req.path}`,
                data: req.body,
                timeout: 300000, 
                validateStatus: () => true 
            });

            sendToUI(`Sent Response: ${response.status}`);

            socket.send(JSON.stringify({
                requestId: req.requestId,
                status: response.status,
                data: response.data
            }));
            
            setTimeout(() => {
                if(isConnected) sendToUI('Connected (Idle)');
            }, 2000);

        } catch (e) {
            sendToUI(`Ollama Error: ${e.message}`);
            // Tell Gateway we failed
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({
                    requestId: JSON.parse(data).requestId,
                    status: 502,
                    data: { error: 'Local Client Error: ' + e.message }
                }));
            }
        }
    });

    socket.on('close', (code) => {
        isConnected = false;
        clearInterval(heartbeatInterval);
        
        let msg = 'Disconnected';
        if (code === 1008) msg = 'Error: Invalid Credentials';
        sendToUI(msg);

        // ONLY Retry if it wasn't a manual disconnect AND wasn't an auth error
        if (!isManualDisconnect && code !== 1008) {
            sendToUI('Connection lost. Retrying in 5s...');
            setTimeout(() => connectTunnel(username, apiKey, slug), 5000);
        }
    });

    socket.on('error', (err) => {
        if (!isManualDisconnect) sendToUI('Connection Error');
    });
}

async function sendSystemStats(apiKey, slug) {
    try {
        const cpu = await si.cpu();
        const mem = await si.mem();
        const os = await si.osInfo();
        
        await axios.post(`${DASHBOARD_URL}/api/report-stats`, {
            apiKey, slug, 
            specs: { 
                cpu: `${cpu.manufacturer} ${cpu.brand}`, 
                ram: Math.round(mem.total/1024/1024/1024) + 'GB', 
                os: os.distro 
            }, 
            uptime: process.uptime()
        });
    } catch(e) { console.log('Stats failed', e.message); }
}

// --- IPC HANDLERS ---
ipcMain.handle('toggle-connection', (event, { username, apiKey, slug }) => {
    if (isConnected) {
        // MANUAL DISCONNECT
        isManualDisconnect = true;
        if(socket) socket.close();
        isConnected = false;
        clearInterval(heartbeatInterval);
        sendToUI('Disconnected');
    } else {
        connectTunnel(username, apiKey, slug);
    }
});

ipcMain.handle('toggle-startup', (event, enabled) => { 
    enabled ? autoLauncher.enable() : autoLauncher.disable(); 
});

ipcMain.handle('toggle-stats', (event, enabled) => { 
    config.sendStats = enabled; 
});

// --- APP LIFECYCLE ---
app.whenReady().then(() => {
    createWindow();
    createTray();
});

// Single Instance Lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}