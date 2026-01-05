#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const WebSocket = require('ws');
const axios = require('axios');
const si = require('systeminformation');

// conf consts
const CONFIG_FILE = path.join(process.cwd(), 'gateway.conf');
const CURRENT_VERSION = '1.0.0'; 
// expects a simple json response
const UPDATE_CHECK_URL = 'https://lachlanm05.com/ai/cli/updater/version.json';
const DASHBOARD_URL = 'https://ai.lachlanm05.com';
const GATEWAY_WS = 'wss://api.lachlanm05.com/tunnel';
const LOCAL_OLLAMA = 'http://127.0.0.1:11434';

// state
let config = {
    username: '',
    slug: '',
    apiKey: ''
};
let socket;
let isConnected = false;
let heartbeatInterval;

// cli args
const args = process.argv.slice(2);
const optOutStats = args.includes('--optout-data');

// logger helper
function log(msg, type = 'INFO') {
    const timestamp = new Date().toISOString().replace('T', ' ').split('.')[0];
    let color = '\x1b[37m'; // white
    if (type === 'ERROR' || type === 'FATAL') color = '\x1b[31m'; // red
    if (type === 'SUCCESS') color = '\x1b[32m'; // green
    if (type === 'WARN') color = '\x1b[33m'; // yellow
    if (type === 'NET') color = '\x1b[36m'; // cyan
    
    console.log(`${color}[${timestamp}] [${type}] ${msg}\x1b[0m`);
}

// update checker
// TODO: make the updater auto-fetch and grab latest, then run it and have new process do cleanup
async function checkForUpdates() {
    try {
        log('Checking for updates...', 'INFO');
        const res = await axios.get(UPDATE_CHECK_URL);
        const remoteVersion = res.data.version;
        
        if (remoteVersion !== CURRENT_VERSION) {
            log('----------------------------------------------------', 'WARN');
            log(`New version available: v${remoteVersion}`, 'WARN');
            log(`Please download it at: ${res.data.url}`, 'WARN');
            log('----------------------------------------------------', 'WARN');
        } else {
            log('Client is up to date.', 'SUCCESS');
        }
    } catch (e) {
        log(`Update check failed: ${e.message}`, 'WARN');
    }
}

// conf logic
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function askQuestion(query) {
    return new Promise(resolve => rl.question(query, resolve));
}

async function loadOrGenerateConfig() {
    if (fs.existsSync(CONFIG_FILE)) {
        try {
            const fileData = fs.readFileSync(CONFIG_FILE, 'utf8');
            const parsed = JSON.parse(fileData);
            
            // simple validation
            if (parsed.username && parsed.slug && parsed.apiKey) {
                config = parsed;
                log(`Loaded configuration for user: ${config.username}`, 'INFO');
                return true;
            } else {
                log('Configuration file exists but is incomplete.', 'WARN');
            }
        } catch (e) {
            log('Config file corrupted.', 'WARN');
        }
    }

    // if here, we need to setup
    console.log('\n==========================================');
    console.log('   Neural Gateway CLI - Initial Setup');
    console.log('==========================================\n');

    config.username = await askQuestion('Enter Username: ');
    config.slug = await askQuestion('Enter Client Slug (e.g. linux-server): ');
    config.apiKey = await askQuestion('Enter API Key: ');

    // write to file
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        console.log('\n[SUCCESS] Configuration saved to gateway.conf');
        console.log('You can edit this file manually if needed.\n');
        return true;
    } catch (e) {
        log(`Failed to write config file: ${e.message}`, 'FATAL');
        return false;
    }
}

// hwstats
async function sendSystemStats() {
    if (optOutStats) {
        log('Statistics collection skipped (User Opt-out)', 'INFO');
        return;
    }

    try {
        const cpu = await si.cpu();
        const mem = await si.mem();
        const memLayout = await si.memLayout();
        const graphics = await si.graphics();
        const diskLayout = await si.diskLayout();
        const os = await si.osInfo();

        // RAM formatting
        const totalRamGB = Math.round(mem.total / 1024 / 1024 / 1024);
        let ramString = `${totalRamGB}GB`;
        if (memLayout && memLayout.length > 0) {
            const stick = memLayout[0];
            if (stick.type) ramString += ` ${stick.type}`;
            if (stick.clockSpeed) ramString += `@${stick.clockSpeed}MT/s`;
        }

        // GPU formatting
        const gpuString = graphics.controllers
            .map(g => g.model)
            .filter(model => model && model.length > 0)
            .join(' + ');

        // disk formatting
        const driveTypes = diskLayout.map(d => {
            const interfaceType = d.interfaceType || '';
            const type = d.type || 'Disk';
            return `${interfaceType} ${type}`.trim();
        }).join(', ');

        const hardwareInfoObj = {
            cpu: `[CLI] ${cpu.manufacturer} ${cpu.brand}`, // adds cli prefix for info
            ram: ramString,
            gpu: gpuString || 'Unknown GPU',
            storage: driveTypes || 'Unknown Storage',
            os: `${os.distro} ${os.release} (CLI)`
        };

        await axios.post(`${DASHBOARD_URL}/api/report-stats`, {
            apiKey: config.apiKey,
            slug: config.slug,
            specs: hardwareInfoObj,
            uptime: process.uptime()
        });

        log('Hardware stats sent to dashboard.', 'INFO');

    } catch (e) {
        log(`Failed to send stats: ${e.message}`, 'WARN');
    }
}

// tun logic
async function checkOllama() {
    try {
        await axios.get(LOCAL_OLLAMA);
        return true;
    } catch (e) {
        return false;
    }
}

async function connectTunnel() {
    if (isConnected) return;

    // check ollama
    const ollamaUp = await checkOllama();
    if (!ollamaUp) {
        log('Local Ollama is OFFLINE (Check Port 11434). Retrying in 10s...', 'ERROR');
        setTimeout(connectTunnel, 10000);
        return;
    }

    log(`Connecting to Gateway...`, 'NET');
    
    const wsUrl = `${GATEWAY_WS}?username=${config.username}&slug=${config.slug}&key=${config.apiKey}`;
    socket = new WebSocket(wsUrl);
    
    socket.on('open', () => {
        isConnected = true;
        log('Connected to Neural Gateway (To opt-out of data collection, run with --optout-data', 'SUCCESS');
        
        // send stats on conn
        sendSystemStats();

        // keep alive
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
            log(`Processing Request: ${req.method} ${req.path}`, 'NET');
            
            // forward to ollama
            const response = await axios({
                method: req.method,
                url: `${LOCAL_OLLAMA}/${req.path}`,
                data: req.body,
                timeout: 300000, // 5 min timeout for slow response
                validateStatus: () => true 
            });

            log(`Ollama Response: ${response.status}`, 'INFO');

            socket.send(JSON.stringify({
                requestId: req.requestId,
                status: response.status,
                data: response.data
            }));

        } catch (e) {
            log(`Ollama Error: ${e.message}`, 'ERROR');
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({
                    requestId: JSON.parse(data).requestId,
                    status: 502,
                    data: { error: 'CLI Client Error: ' + e.message }
                }));
            }
        }
    });

    socket.on('close', (code) => {
        isConnected = false;
        clearInterval(heartbeatInterval);
        
        let msg = 'Disconnected';
        let level = 'WARN';
        
        if (code === 1008) {
            msg = 'Connection Rejected: Invalid Credentials';
            level = 'FATAL';
        }

        log(msg, level);

        if (code === 1008) {
            log('Please check gateway.conf and restart.', 'FATAL');
            process.exit(1);
        } else {
            log('Retrying connection in 5s...', 'INFO');
            setTimeout(connectTunnel, 5000);
        }
    });

    socket.on('error', (err) => {
        log(`Socket Error: ${err.message}`, 'ERROR');
    });
}

// main ex flow
(async () => {
    // check up first
    await checkForUpdates();

    // load/create conf
    const configLoaded = await loadOrGenerateConfig();
    
    // close readline as we don't need user input anymore
    rl.close();

    if (configLoaded) {
        // start con
        connectTunnel();
    }
})();