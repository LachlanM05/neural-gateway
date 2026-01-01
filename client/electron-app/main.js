const { app, BrowserWindow, ipcMain, Tray, Menu } = require('electron');
const path = require('path');
const WebSocket = require('ws');
const axios = require('axios');
const si = require('systeminformation');
const AutoLaunch = require('auto-launch');

// conf
const DASHBOARD_URL = 'https://ai.lachlanm05.com';     // stats location
const GATEWAY_WS = 'wss://api.lachlanm05.com/tunnel';  // traffic tunnel
const LOCAL_OLLAMA = 'http://127.0.0.1:11434';

let mainWindow;
let tray;
let socket;
let isConnected = false;
let heartbeatInterval;
let config = { sendStats: true, openOnStartup: false };

// auto launcher
const autoLauncher = new AutoLaunch({ name: 'LachlanAI', path: app.getPath('exe') });

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 400, 
        height: 650,
        resizable: false,
        icon: path.join(__dirname, 'icon.ico'),
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
            { label: 'Show App', click: () => mainWindow.show() },
            { label: 'Quit', click: () => { app.isQuiting = true; app.quit(); } }
        ]);
        tray.setToolTip('Lachlan AI Client');
        tray.setContextMenu(contextMenu);
        tray.on('double-click', () => mainWindow.show());
    } catch (e) {
        console.log("Tray Error:", e);
    }
}

// log to ui
function sendLog(msg) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        console.log(msg);
    }
}

// TUNNEL LOGIC
function connectTunnel(apiKey, slug) {
    if (isConnected) return;
    
    sendLog(`[Connecting] ${GATEWAY_WS}...`);
    
    socket = new WebSocket(`${GATEWAY_WS}?slug=${slug}&key=${apiKey}`);
    
    socket.on('open', () => {
        console.log('[WS] Connected');
        isConnected = true;
        mainWindow.webContents.send('status-update', 'Connected');
        
        // 1. send stats immedietaly 
        if (config.sendStats) sendSystemStats(apiKey, slug);

        // 2. Start Heartbeat
        // cloudflare kills idle connections, send heartbeat to stop.
        clearInterval(heartbeatInterval);
        heartbeatInterval = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) {
                socket.ping(); 
            }
        }, 30000);
    });

    socket.on('message', async (data) => {
        try {
            // log that we start working on api request
            mainWindow.webContents.send('status-update', 'Processing Request...');
            
            const req = JSON.parse(data);
            const startTime = Date.now();
            
            console.log(`[Request] ${req.method} ${req.path}`);

            // forward to local ollama
            const response = await axios({
                method: req.method,
                url: `${LOCAL_OLLAMA}/${req.path}`,
                data: req.body,
                timeout: 300000, // 5 minutes for long model times, or long typing times.
                validateStatus: () => true 
            });

            const duration = Date.now() - startTime;
            console.log(`[Response] ${response.status} (${duration}ms)`);

            // send res back
            socket.send(JSON.stringify({
                requestId: req.requestId,
                status: response.status,
                data: response.data
            }));

            mainWindow.webContents.send('status-update', 'Connected (Idle)');

        } catch (e) {
            console.error('[Tunnel Error]', e.message);
            // inform server of fail
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({
                    requestId: JSON.parse(data).requestId,
                    status: 500,
                    data: { error: 'Client Hardware Error: ' + e.message }
                }));
            }
            mainWindow.webContents.send('status-update', 'Error: Ollama Failed');
        }
    });

    socket.on('close', (code, reason) => {
        isConnected = false;
        clearInterval(heartbeatInterval);
        console.log(`[WS] Closed: ${code}`);

        let statusMsg = 'Disconnected';
        if (code === 1008) statusMsg = 'Error: Invalid API Key';
        else if (code === 1006) statusMsg = 'Error: Connection Dropped';

        if (!mainWindow.isDestroyed()) mainWindow.webContents.send('status-update', statusMsg);

        // auto-retry unless auth error
        if (code !== 1008) {
            setTimeout(() => connectTunnel(apiKey, slug), 5000);
        }
    });

    socket.on('error', (err) => {
        console.error('[WS] Error:', err.message);
        if (!mainWindow.isDestroyed()) mainWindow.webContents.send('status-update', 'Connection Error');
    });
}

async function sendSystemStats(apiKey, slug) {
    try {
        const cpu = await si.cpu();
        const mem = await si.mem();
        const os = await si.osInfo();
        
        const specs = {
            cpu: `${cpu.manufacturer} ${cpu.brand}`,
            ram: Math.round(mem.total / 1024 / 1024 / 1024) + 'GB',
            os: os.distro
        };

        // fixed url, can i even type atp? :sob:
        await axios.post(`${DASHBOARD_URL}/api/report-stats`, {
            apiKey, slug, specs, uptime: process.uptime()
        });
        console.log('[Stats] Sent successfully');
    } catch(e) {
        console.log('[Stats] Failed to send:', e.message);
    }
}

// IPC HANDLERS 
ipcMain.handle('toggle-connection', (event, { apiKey, slug }) => {
    if (isConnected) {
        if(socket) socket.close();
        isConnected = false;
        clearInterval(heartbeatInterval);
        mainWindow.webContents.send('status-update', 'Disconnected');
    } else {
        connectTunnel(apiKey, slug);
    }
});

ipcMain.handle('toggle-startup', (event, enabled) => {
    enabled ? autoLauncher.enable() : autoLauncher.disable();
    config.openOnStartup = enabled;
});

ipcMain.handle('toggle-stats', (event, enabled) => {
    config.sendStats = enabled;
});

app.whenReady().then(() => {
    createWindow();
    createTray();
});

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      mainWindow.show();
    }
  });
}