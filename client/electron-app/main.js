const { app, BrowserWindow, ipcMain, Tray, Menu, shell, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const WebSocket = require('ws');
const axios = require('axios');
const si = require('systeminformation');
const AutoLaunch = require('auto-launch');

// conf
const DASHBOARD_URL = 'https://ai.lachlanm05.com';     
const GATEWAY_WS = 'wss://api.lachlanm05.com/tunnel';  
const LOCAL_OLLAMA = 'http://127.0.0.1:11434';
const UPDATE_URL = 'https://lachlanm05.com/ai/updater/';

let mainWindow;
let tray;
let socket;
let isConnected = false;
let isManualDisconnect = false;
let heartbeatInterval;
let config = { sendStats: true, openOnStartup: false };

const autoLauncher = new AutoLaunch({ name: 'Neural Gateway', path: app.getPath('exe') });

autoUpdater.setFeedURL({
    provider: 'generic',
    url: UPDATE_URL
});

autoUpdater.autoDownload = false;

function setupUpdater() {
    autoUpdater.on('checking-for-update', () => sendToUI('Checking for updates...'));
    
    autoUpdater.on('update-available', (info) => {
        sendToUI(`Update available: v${info.version}`);
        // prompt user or just download
        dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'Update Available',
            message: `A new version (v${info.version}) is available. Download now?`,
            buttons: ['Yes', 'No']
        }).then((result) => {
            if (result.response === 0) {
                sendToUI('Downloading update...');
                autoUpdater.downloadUpdate();
            }
        });
    });

    autoUpdater.on('update-not-available', () => sendToUI('Client is up to date.'));

    autoUpdater.on('error', (err) => {
        sendToUI(`Update Error: ${err.message}`, 'error');
    });

    autoUpdater.on('update-downloaded', () => {
        sendToUI('Update downloaded. Restarting...');
        // wait a moment then quit and install
        setTimeout(() => {
            autoUpdater.quitAndInstall();
        }, 2000);
    });

    // check for updates shortly after launch
    setTimeout(() => {
        if (process.env.NODE_ENV !== 'development') {
            autoUpdater.checkForUpdates();
        }
    }, 5000);
}

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
        if (process.env.NODE_ENV !== 'development') setupUpdater();
    });

    // min to tray instead of closing
    mainWindow.on('close', (event) => {
        if (!app.isQuiting) {
            event.preventDefault();
            mainWindow.hide();
        }
    });

    // open external links in default browser
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });
}

function createTray() {
    const iconPath = path.join(__dirname, 'icon.ico');
    
    try {
        tray = new Tray(iconPath);
        
        const contextMenu = Menu.buildFromTemplate([
            { label: 'Open Interface', click: () => mainWindow.show() },
            { label: 'Check for Updates', click: () => autoUpdater.checkForUpdates() },
            { type: 'separator' },
            { label: 'Quit Neural Gateway', click: () => { app.isQuiting = true; app.quit(); } }
        ]);

        tray.setToolTip('Lachlan AI Client');
        tray.setContextMenu(contextMenu);

        // left click to open gui
        tray.on('click', () => {
            if (mainWindow.isVisible()) {
                mainWindow.hide();
            } else {
                mainWindow.show();
                mainWindow.focus();
            }
        });

        // double click
        tray.on('double-click', () => mainWindow.show());

    } catch (e) {
        console.error("Tray Icon Failed:", e);
    }
}

// diagnostics
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

// tun logic
async function connectTunnel(username, apiKey, slug) {
    if (isConnected) return;
    
    // reset manual flag
    isManualDisconnect = false;

    // 1. check local ollama
    const ollamaUp = await checkOllama();
    if (!ollamaUp) {
        sendToUI('Error: Local Ollama is OFFLINE (Check Port 11434)');
        return;
    }

    sendToUI(`Connecting to Gateway...`);
    
    // pass username in url query
    const wsUrl = `${GATEWAY_WS}?username=${username}&slug=${slug}&key=${apiKey}`;
    socket = new WebSocket(wsUrl);
    
    socket.on('open', () => {
        isConnected = true;
        sendToUI('Connected (Tunnel Active)');
        if (config.sendStats) sendSystemStats(apiKey, slug);

        // heartbeat to keep con alive
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
            
            // forward to ollama
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
            // tell gateway we failed
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

        // only retry if it wasn't a manual discon and not an auth issue
        if (!isManualDisconnect && code !== 1008) {
            sendToUI('Connection lost. Retrying in 5s...');
            setTimeout(() => connectTunnel(username, apiKey, slug), 5000);
        }
    });

    socket.on('error', (err) => {
        if (!isManualDisconnect) sendToUI('Connection Error');
    });
}

// --- HARDWARE INFO LOGIC ---
async function sendSystemStats(apiKey, slug) {
    try {
        // Fetch specific data points
        const cpu = await si.cpu();
        const mem = await si.mem();
        const memLayout = await si.memLayout();
        const graphics = await si.graphics();
        const diskLayout = await si.diskLayout();
        const os = await si.osInfo();

        // 1. Process RAM: "32GB DDR4@2400MT/s"
        const totalRamGB = Math.round(mem.total / 1024 / 1024 / 1024);
        let ramString = `${totalRamGB}GB`;
        
        // Try to get detailed stick info from the first bank found
        if (memLayout && memLayout.length > 0) {
            const stick = memLayout[0];
            if (stick.type) ramString += ` ${stick.type}`;
            if (stick.clockSpeed) ramString += `@${stick.clockSpeed}MT/s`;
        }

        // 2. Process GPU: Get all controllers (Integrated + Dedicated)
        // Filter out empty models and join them
        const gpuString = graphics.controllers
            .map(g => g.model)
            .filter(model => model && model.length > 0)
            .join(' + ');

        // 3. Process Storage: Find main drive type (SSD/HDD + Interface)
        // We look at all physical disks. 
        const driveTypes = diskLayout.map(d => {
            // e.g. "NVMe" or "SATA"
            const interfaceType = d.interfaceType || ''; 
            // e.g. "SSD" or "HDD" - systeminformation usually provides this in 'type'
            const type = d.type || 'Disk'; 
            return `${interfaceType} ${type}`.trim();
        }).join(', ');

        const hardwareInfoObj = {
            cpu: `${cpu.manufacturer} ${cpu.brand}`,
            ram: ramString,
            gpu: gpuString || 'Unknown GPU',
            storage: driveTypes || 'Unknown Storage',
            os: `${os.distro} ${os.release}`
        };

        // note: json stringing due to only using one specific column in the db schema, so for now it'll be ugly,
        // but it's just usage stats, anyway. in future, i'll expand the db schema.
        await axios.post(`${DASHBOARD_URL}/api/report-stats`, {
            apiKey, slug, 
            specs: hardwareInfoObj, // pass as object, server logic should handle it
            uptime: process.uptime()
        });

    } catch(e) { console.log('Stats failed', e.message); }
}

// ipc handlers
ipcMain.handle('toggle-connection', (event, { username, apiKey, slug }) => {
    if (isConnected) {
        // manual discon
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

// app lifecycle
app.whenReady().then(() => {
    createWindow();
    createTray();
});

// single instance lock
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