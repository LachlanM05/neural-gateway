// grab elements
const statusText = document.getElementById('statusText');
const statusDot = document.getElementById('statusDot');
const loginForm = document.getElementById('loginForm');
const connectedControls = document.getElementById('connectedControls');
const statusIndicator = document.getElementById('statusIndicator');

// inputs
const usernameInput = document.getElementById('usernameInput'); 
const slugInput = document.getElementById('slugInput');
const keyInput = document.getElementById('keyInput');

// buttons
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');

// toggles
const startupBtn = document.getElementById('startupBtn');
const statsBtn = document.getElementById('statsBtn');

// init

// 1. load credentials
usernameInput.value = localStorage.getItem('username') || '';
slugInput.value = localStorage.getItem('slug') || '';
keyInput.value = localStorage.getItem('apiKey') || '';

// 2. load toggle states
let isStartupEnabled = localStorage.getItem('startup') === 'true';
// default stats to true if not set
let isStatsEnabled = localStorage.getItem('stats') !== 'false'; 

window.api.getVersion().then(version => {
    document.getElementById('appVersionText').innerText = `v${version}`;
});

updateToggleUI(startupBtn, isStartupEnabled);
updateToggleUI(statsBtn, isStatsEnabled);
// sync main process with loaded variables
window.api.toggleStartup(isStartupEnabled);
window.api.toggleStats(isStatsEnabled);

// welcome modal logic
const welcomeModal = document.getElementById('welcomeModal');
const closeWelcomeBtn = document.getElementById('closeWelcomeBtn');

if (!localStorage.getItem('welcomeShown')) {
    welcomeModal.classList.remove('hidden');
}

closeWelcomeBtn.addEventListener('click', () => {
    welcomeModal.classList.add('hidden');
    localStorage.setItem('welcomeShown', 'true');
});

// toggle handlers

startupBtn.addEventListener('click', () => {
    isStartupEnabled = !isStartupEnabled;
    localStorage.setItem('startup', isStartupEnabled);
    updateToggleUI(startupBtn, isStartupEnabled);
    window.api.toggleStartup(isStartupEnabled);
});

statsBtn.addEventListener('click', () => {
    isStatsEnabled = !isStatsEnabled;
    localStorage.setItem('stats', isStatsEnabled);
    updateToggleUI(statsBtn, isStatsEnabled);
    window.api.toggleStats(isStatsEnabled);
});

function updateToggleUI(btn, active) {
    if (active) {
        btn.classList.add('active');
        btn.innerText = "ON";
    } else {
        btn.classList.remove('active');
        btn.innerText = "OFF";
    }
}

// con logic

connectBtn.addEventListener('click', async () => {
    const username = usernameInput.value.trim();
    const slug = slugInput.value.trim();
    const apiKey = keyInput.value.trim();

    if (!username || !slug || !apiKey) {
        alert('Please fill in Username, Slug, and API Key'); 
        return;
    }

    localStorage.setItem('username', username);
    localStorage.setItem('slug', slug);
    localStorage.setItem('apiKey', apiKey);

    await window.api.toggleConnection({ username, apiKey, slug });
});

disconnectBtn.addEventListener('click', async () => {
    await window.api.toggleConnection({ 
        username: usernameInput.value, 
        apiKey: keyInput.value, 
        slug: slugInput.value 
    });
});

// status update ehandler
window.api.onStatus((message) => {
    statusText.innerText = message; 

    if (message.includes('Connected') && !message.includes('Error')) {
        // online
        statusIndicator.className = 'status-row connected';
        statusText.style.color = 'var(--ok)';
        loginForm.style.display = 'none';
        connectedControls.style.display = 'block';
    } else if (message.includes('Disconnected') || message.includes('Error')) {
        // offline
        statusIndicator.className = 'status-row disconnected';
        statusText.style.color = 'var(--danger)';
        loginForm.style.display = 'block';
        connectedControls.style.display = 'none';
    }
});


// --- DIAGNOSTICS LOGIC ---
const appVersionText = document.getElementById('appVersionText');
const diagModal = document.getElementById('diagModal');
const closeDiagBtn = document.getElementById('closeDiagBtn');
const runTestsBtn = document.getElementById('runTestsBtn');
const copyLogsBtn = document.getElementById('copyLogsBtn');
const diagLogs = document.getElementById('diagLogs');

function logDiag(msg) {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    diagLogs.value += `[${time}] ${msg}\n`;
    diagLogs.scrollTop = diagLogs.scrollHeight;
}

// Open Diagnostic Window
appVersionText.addEventListener('click', () => {
    diagModal.classList.remove('hidden');
});

// Close Diagnostic Window
closeDiagBtn.addEventListener('click', () => {
    diagModal.classList.add('hidden');
});

// Copy Logs
copyLogsBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(diagLogs.value);
    const oldText = copyLogsBtn.innerText;
    copyLogsBtn.innerText = "Copied!";
    setTimeout(() => copyLogsBtn.innerText = oldText, 2000);
});

// Execute Tests Sequence
runTestsBtn.addEventListener('click', async () => {
    runTestsBtn.disabled = true;
    diagLogs.value = ""; // Clear previous
    logDiag("STARTING NODE DIAGNOSTICS...");

    // 1. OLLAMA TEST
    logDiag("-> Running Ollama Local Test...");
    const ollamaResult = await window.api.testLocalOllama();
    if (ollamaResult.success) {
        logDiag(`[PASS] Ollama is online (${ollamaResult.modelsCount} models found)`);
    } else {
        logDiag(`[FAIL] Ollama unreachable: ${ollamaResult.error}`);
    }

    // 2. SERVER ROUNDTRIP TEST
    const username = localStorage.getItem('username');
    const slug = localStorage.getItem('slug');
    const apiKey = localStorage.getItem('apiKey');

    if (!username || !slug || !apiKey) {
        logDiag("[SKIP] Server test skipped (Node credentials missing).");
    } else {
        logDiag("-> Running Server -> Node -> Ollama Test...");
        logDiag("Waiting for server response (this may take up to 15s)...");
        
        const serverResult = await window.api.testServerRoundtrip({ username, slug, apiKey });
        if (serverResult.success) {
            logDiag(`[PASS] End-to-End Tunnel Verified!`);
        } else {
            logDiag(`[FAIL] Server roundtrip failed: ${serverResult.error}`);
        }
    }

    logDiag("DIAGNOSTICS COMPLETE.");
    runTestsBtn.disabled = false;
});