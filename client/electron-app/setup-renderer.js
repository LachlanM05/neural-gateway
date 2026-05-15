// setup-renderer.js
// handles the standalone setup wizard logic with terminal logging

const terminalLog = document.getElementById('terminalLog');
const step1Btn = document.getElementById('step1-btn');
const step2Btn = document.getElementById('step2-btn');
const step3Btn = document.getElementById('step3-btn');
const step4Btn = document.getElementById('step4-btn');
const disclaimerModal = document.getElementById('disclaimerModal');
const acceptDisclaimerBtn = document.getElementById('acceptDisclaimerBtn');

const modelSelect = document.getElementById('model-select');
const exportBtn = document.getElementById('export-btn');

function log(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    let prefix = "[INFO]";
    if (type === 'error') prefix = "[ERROR]";
    if (type === 'success') prefix = "[SUCCESS]";
    if (type === 'command') prefix = ">";

    const line = `[${time}] ${prefix} ${msg}\n`;
    terminalLog.innerText += line;
    terminalLog.scrollTop = terminalLog.scrollHeight;
    console.log(`[SETUP] ${prefix} ${msg}`);
}

function logResponse(method, data) {
    log(`${method} RESPONSE RECEIVED:`, 'success');
    terminalLog.innerText += `${JSON.stringify(data, null, 2)}\n\n`;
    terminalLog.scrollTop = terminalLog.scrollHeight;
}

// Step 1: Configure Ollama
step1Btn.addEventListener('click', async () => {
    log("Starting Step 1: Configuring Ollama for network access...", 'command');

    try {
        const result = await window.gatewaySetup.configureOllama();
        if (result.success) {
            log("Ollama environment variable 'OLLAMA_HOST' set to '0.0.0.0'.", 'success');
            log("NOTE: You must restart the Ollama application for this to take effect.", 'info');
        } else {
            log(`Failed to configure Ollama: ${result.error}`, 'error');
        }
    } catch (err) {
        log(`System Error: ${err.message}`, 'error');
    }
});

// Step 2: LLMFit (with Disclaimer)
step2Btn.addEventListener('click', () => {
    disclaimerModal.classList.remove('hidden');
});

acceptDisclaimerBtn.addEventListener('click', async () => {
    disclaimerModal.classList.add('hidden');
    log("User accepted disclaimer. Launching LLMFit...", 'command');
    
    try {
        const result = await window.gatewaySetup.openLlmfit();
        if (result.success) {
            log("LLMFit process spawned successfully in a new window.", 'success');
        } else {
            log(`Failed to launch LLMFit: ${result.error}`, 'error');
        }
    } catch (err) {
        log(`System Error: ${err.message}`, 'error');
    }
});

// Step 3: Test Local Model & Fetch Tags
step3Btn.addEventListener('click', async () => {
    log("Step 3: Fetching model list from Ollama...", 'command');

    try {
        const response = await fetch('http://localhost:11434/api/tags');
        const data = await response.json();
        
        if (response.ok && data.models) {
            log(`Success: Found ${data.models.length} models.`, 'success');
            
            // Populate dropdown
            modelSelect.innerHTML = '';
            data.models.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m.name;
                opt.innerText = m.name;
                modelSelect.appendChild(opt);
            });

            const firstModel = data.models[0].name;
            log(`Running test with: ${firstModel}`, 'info');

            // Run actual test prompt
            const testRes = await fetch('http://localhost:11434/api/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: firstModel,
                    prompt: 'Reply exactly with the word OK',
                    stream: false
                })
            });
            
            if (testRes.ok) {
                log("Local model verification successful.", 'success');
                step4Btn.disabled = false;
            } else {
                log(`Model test failed with status: ${testRes.status}`, 'error');
            }
        } else {
            log("Failed to fetch models. Is Ollama running?", 'error');
        }
    } catch (err) {
        log(`Ollama Error: ${err.message}`, 'error');
    }
});

// Step 4: Verify Gateway
step4Btn.addEventListener('click', async () => {
    const username = localStorage.getItem('username');
    const slug = localStorage.getItem('slug');
    const apiKey = localStorage.getItem('apiKey');
    const selectedModel = modelSelect.value;

    if (!selectedModel) {
        log("Error: Please select a model from the dropdown first.", 'error');
        return;
    }

    log("Step 4: Testing Neural Gateway tunnel...", 'command');

    if (!username || !slug || !apiKey) {
        log("CRITICAL ERROR: Credentials missing in Main Dashboard!", 'error');
        log("Please go back to the Main Window and enter your Username, Slug, and API Key.", 'info');
        log("Step 4 cannot continue without these identification markers.", 'info');
        alert("Action Required: Please fill in your Username, Slug, and API Key in the main dashboard before verifying the gateway.");
        return;
    }


    log(`Identifying as ${username} (${slug}) | Model: ${selectedModel}`, 'info');

    const isConnected = await window.gatewaySetup.getConnectionStatus();
    if (!isConnected) {
        log("Node is OFFLINE. Triggering connection...", 'info');
        await window.gatewaySetup.triggerConnection({ username, slug, apiKey });
        await new Promise(r => setTimeout(r, 3000));
    }

    const url = "https://api.lachlanm05.com";
    const endpoint = `${url}/users/${username}/${slug}/v1/chat/completions`;
    
    try {
        log(`POST ${endpoint}`, 'info');
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: selectedModel,
                messages: [{ role: 'user', content: 'Ping' }]
            })
        });

        const text = await response.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            log(`Gateway returned non-JSON (Status ${response.status}).`, 'error');
            terminalLog.innerText += `--- RAW RESPONSE ---\n${text.substring(0, 300)}...\n--------------------\n\n`;
            return;
        }

        if (response.ok) {
            log("Gateway connection healthy! Setup complete.", 'success');
            logResponse('GATEWAY', data);
        } else {
            log(`Gateway error: ${response.status}`, 'error');
            logResponse('GATEWAY_ERR', data);
        }
    } catch (err) {
        log(`Network Error: ${err.message}`, 'error');
    }
});

// Export Log with Redaction
exportBtn.addEventListener('click', () => {
    const username = localStorage.getItem('username') || 'unknown';
    const slug = localStorage.getItem('slug') || 'unknown';
    const apiKey = localStorage.getItem('apiKey') || 'sk-';
    
    let content = terminalLog.innerText;

    // 1. Redact IP Addresses
    content = content.replace(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/g, '[IP_REDACTED]');

    // 2. Redact API Keys
    const keyEscaped = apiKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    content = content.replace(new RegExp(keyEscaped, 'g'), '[KEY_REDACTED]');
    // Generic fallback for any sk- keys
    content = content.replace(/sk-[a-zA-Z0-9]{32,}/g, '[KEY_REDACTED]');

    // 3. Redact Username and Slug
    if (username !== 'unknown') {
        const userEscaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        content = content.replace(new RegExp(userEscaped, 'g'), '[USER_REDACTED]');
    }
    if (slug !== 'unknown') {
        const slugEscaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        content = content.replace(new RegExp(slugEscaped, 'g'), '[CLIENT_REDACTED]');
    }

    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `neural-setup-${Date.now()}.log`;
    a.click();
    URL.revokeObjectURL(url);
    
    log("Log exported successfully (sensitive data redacted).", 'success');
});


