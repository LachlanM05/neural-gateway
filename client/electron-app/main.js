const {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  shell,
  dialog,
} = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const WebSocket = require("ws");
const axios = require("axios");
const si = require("systeminformation");
const AutoLaunch = require("auto-launch");
const { exec, spawn } = require('child_process');


// conf
const DASHBOARD_URL = "https://ai.lachlanm05.com";
const GATEWAY_WS = "wss://api.lachlanm05.com/tunnel";
const LOCAL_OLLAMA = "http://127.0.0.1:11434";
const UPDATE_URL = "https://thelit.club/api/neural/";


let mainWindow;
let setupWindow;
let tray;

let socket;
let isConnected = false;
let isManualDisconnect = false;
let heartbeatInterval;
let config = { sendStats: true, openOnStartup: false };

const autoLauncher = new AutoLaunch({
  name: "Neural Gateway",
  path: app.getPath("exe"),
});

autoUpdater.setFeedURL({
  provider: "generic",
  url: UPDATE_URL,
});

autoUpdater.autoDownload = false;

function setupUpdater() {
  autoUpdater.on("checking-for-update", () =>
    sendToUI("Checking for updates..."),
  );

  autoUpdater.on("update-available", (info) => {
    sendToUI(`Update available: v${info.version}`);
    // prompt user or just download
    dialog
      .showMessageBox(mainWindow, {
        type: "info",
        title: "Update Available",
        message: `A new version (v${info.version}) is available. Download now?`,
        buttons: ["Yes", "No"],
      })
      .then((result) => {
        if (result.response === 0) {
          sendToUI("Downloading update...");
          autoUpdater.downloadUpdate();
        }
      });
  });

  autoUpdater.on("update-not-available", () =>
    sendToUI("Client is up to date."),
  );

  autoUpdater.on("error", (err) => {
    sendToUI(`Update Error: ${err.message}`, "error");
  });

  autoUpdater.on("update-downloaded", () => {
    sendToUI("Update downloaded. Restarting...");
    // wait a moment then quit and install
    setTimeout(() => {
      autoUpdater.quitAndInstall();
    }, 2000);
  });

  // check for updates shortly after launch
  setTimeout(() => {
    if (process.env.NODE_ENV !== "development") {
      autoUpdater.checkForUpdates();
    }
  }, 5000);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 650,
    resizable: false,
    icon: path.join(__dirname, "icon.ico"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: false,
  });

  mainWindow.loadFile("index.html");

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    if (process.env.NODE_ENV !== "development") setupUpdater();
  });

  // min to tray instead of closing
  mainWindow.on("close", (event) => {
    if (!app.isQuiting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

function createSetupWindow() {
  if (setupWindow) {
    setupWindow.focus();
    return;
  }

  setupWindow = new BrowserWindow({
    width: 700,
    height: 700,
    resizable: false,
    icon: path.join(__dirname, "icon.ico"),
    autoHideMenuBar: true,
    title: "Setup Wizard",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  setupWindow.loadFile("setup.html");

  setupWindow.on("closed", () => {
    setupWindow = null;
  });
}


function createTray() {
  const iconPath = path.join(__dirname, "icon.ico");

  try {
    tray = new Tray(iconPath);

    const contextMenu = Menu.buildFromTemplate([
      { label: "Open Interface", click: () => mainWindow.show() },
      {
        label: "Check for Updates",
        click: () => autoUpdater.checkForUpdates(),
      },
      { type: "separator" },
      {
        label: "Quit Neural Gateway",
        click: () => {
          app.isQuiting = true;
          app.quit();
        },
      },
    ]);

    tray.setToolTip("Lachlan AI Client");
    tray.setContextMenu(contextMenu);

    // left click to open gui
    tray.on("click", () => {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    });

    // double click
    tray.on("double-click", () => mainWindow.show());
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

function sendToUI(msg, type = "info") {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("status-update", msg);
    if (type === "error") console.error(msg);
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
    sendToUI("Error: Local Ollama is OFFLINE (Check Port 11434)");
    return;
  }

  sendToUI(`Connecting to Gateway...`);

  // pass username in url query
  const wsUrl = `${GATEWAY_WS}?username=${username}&slug=${slug}&key=${apiKey}`;
  socket = new WebSocket(wsUrl);

  socket.on("open", () => {
    isConnected = true;
    sendToUI("Connected (Tunnel Active)");

    // Initial transmission
    if (config.sendStats) sendSystemStats();

    // Heartbeat to keep connection alive and update online status/uptime
    clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.ping();
        if (config.sendStats) sendSystemStats();
      }
    }, 30000);
  });

  socket.on("message", async (data) => {
    try {
      const req = JSON.parse(data);
      sendToUI(`Processing: ${req.method} ...`);

      // forward to ollama
      const response = await axios({
        method: req.method,
        url: `${LOCAL_OLLAMA}/${req.path}`,
        data: req.body,
        timeout: 300000,
        validateStatus: () => true,
      });

      sendToUI(`Sent Response: ${response.status}`);

      socket.send(
        JSON.stringify({
          requestId: req.requestId,
          status: response.status,
          data: response.data,
        }),
      );

      setTimeout(() => {
        if (isConnected) sendToUI("Connected (Idle)");
      }, 2000);
    } catch (e) {
      sendToUI(`Ollama Error: ${e.message}`);
      // tell gateway we failed
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            requestId: JSON.parse(data).requestId,
            status: 502,
            data: { error: "Local Client Error: " + e.message },
          }),
        );
      }
    }
  });

  socket.on("close", (code) => {
    isConnected = false;
    clearInterval(heartbeatInterval);

    let msg = "Disconnected";
    if (code === 1008) msg = "Error: Invalid Credentials";
    sendToUI(msg);

    // only retry if it wasn't a manual discon and not an auth issue
    if (!isManualDisconnect && code !== 1008) {
      sendToUI("Connection lost. Retrying in 5s...");
      setTimeout(() => connectTunnel(username, apiKey, slug), 5000);
    }
  });

  socket.on("error", (err) => {
    if (!isManualDisconnect) sendToUI("Connection Error");
  });
}

// --- HARDWARE INFO LOGIC ---
let cachedSpecs = null;

async function sendSystemStats() {
  try {
    // Only run the heavy system info checks once
    if (!cachedSpecs) {
      const cpu = await si.cpu();
      const mem = await si.mem();
      const memLayout = await si.memLayout();
      const graphics = await si.graphics();
      const diskLayout = await si.diskLayout();
      const os = await si.osInfo();

      const totalRamGB = Math.round(mem.total / 1024 / 1024 / 1024);
      let ramString = `${totalRamGB}GB`;

      if (memLayout && memLayout.length > 0) {
        const stick = memLayout[0];
        if (stick.type) ramString += ` ${stick.type}`;
        if (stick.clockSpeed) ramString += `@${stick.clockSpeed}MT/s`;
      }

      const gpuString = graphics.controllers
        .map((g) => g.model)
        .filter((model) => model && model.length > 0)
        .join(" + ");

      const driveTypes = diskLayout
        .map((d) => {
          const interfaceType = d.interfaceType || "";
          const type = d.type || "Disk";
          return `${interfaceType} ${type}`.trim();
        })
        .join(", ");

      cachedSpecs = {
        cpu: `${cpu.manufacturer} ${cpu.brand}`,
        ram: ramString,
        gpu: gpuString || "Unknown GPU",
        storage: driveTypes || "Unknown Storage",
        os: `${os.distro} ${os.release}`,
      };
    }

    // Send stats through the WebSocket instead of HTTP
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          type: "stats",
          specs: cachedSpecs,
          uptime: process.uptime(),
        }),
      );
    }
  } catch (e) {
    console.log("Stats failed", e.message);
  }
}

// ipc handlers
ipcMain.handle("toggle-connection", (event, { username, apiKey, slug }) => {
  if (isConnected) {
    // manual discon
    isManualDisconnect = true;
    if (socket) socket.close();
    isConnected = false;
    clearInterval(heartbeatInterval);
    sendToUI("Disconnected");
  } else {
    connectTunnel(username, apiKey, slug);
  }
});

ipcMain.handle("toggle-startup", (event, enabled) => {
  enabled ? autoLauncher.enable() : autoLauncher.disable();
});

ipcMain.handle("toggle-stats", (event, enabled) => {
  config.sendStats = enabled;
});

// dynamic version handling lmao
const appVersion = require("./package.json").version;
ipcMain.handle("get-version", () => appVersion);

// --- SETUP WIZARD HANDLERS ---

// Configure Ollama to allow local network connections via PowerShell
ipcMain.handle('run-setup-ollama', async () => {
    return new Promise((resolve) => {
        // Set the environment variable at the User level
        const command = "powershell.exe -Command \"[System.Environment]::SetEnvironmentVariable('OLLAMA_HOST', '0.0.0.0', 'User')\"";
        exec(command, (err, stdout, stderr) => {
            if (err) {
                resolve({ success: false, error: stderr || err.message });
            } else {
                resolve({ success: true, output: stdout });
            }
        });
    });
});

// Launch the bundled llmfit executable in a new window
ipcMain.handle('launch-llmfit', async () => {
    return new Promise((resolve) => {
        const basePath = app.isPackaged ? process.resourcesPath : __dirname;
        const llmfitPath = path.join(basePath, 'bin', 'llmfit.exe');

        // Spawn a detached command prompt running the TUI
        const child = spawn('cmd.exe', ['/c', 'start', 'Hardware Check', llmfitPath], {
            detached: true,
            stdio: 'ignore'
        });
        
        child.unref();
        resolve({ success: true });
    });
});


// --- DIAGNOSTIC TESTS ---

// Test 1: Directly Ping Local Ollama
ipcMain.handle('test-local-ollama', async () => {
    try {
        // Hitting the tags endpoint is the standard way to check if Ollama is awake
        const res = await axios.get(`${LOCAL_OLLAMA}/api/tags`, { timeout: 5000 });
        return { success: true, modelsCount: res.data.models ? res.data.models.length : 0 };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

// Test 2: Ask the Server for a Test Prompt
ipcMain.handle('test-server-roundtrip', async (event, { username, slug, apiKey }) => {
    try {
        const res = await axios.post(`https://api.lachlanm05.com/api/diagnostic/ping-node`, {
            username, slug, key: apiKey
        }, { timeout: 125000 }); // 125s timeout to allow generation
        
        return { success: true, data: res.data };
    } catch (err) {
        // Extract useful server error message if it exists
        const errorMsg = err.response && err.response.data 
            ? JSON.stringify(err.response.data) 
            : err.message;
        return { success: false, error: errorMsg };
    }
});

ipcMain.handle('open-setup-wizard', () => {
    createSetupWindow();
});

ipcMain.handle('get-connection-status', () => {
    return isConnected;
});

ipcMain.handle('trigger-connection', (event, creds) => {
    if (!isConnected) {
        connectTunnel(creds.username, creds.apiKey, creds.slug);
        return { success: true };
    }
    return { success: true, alreadyConnected: true };
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
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}
