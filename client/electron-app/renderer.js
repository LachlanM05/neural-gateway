const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const slugInput = document.getElementById('slug');
const keyInput = document.getElementById('apiKey');
const statusText = document.getElementById('statusText');
const statusIndicator = document.getElementById('statusIndicator');
const loginForm = document.getElementById('loginForm');
const connectedControls = document.getElementById('connectedControls');

// settings buttons
const startupBtn = document.getElementById('startupBtn');
const statsBtn = document.getElementById('statsBtn');

let isStatsEnabled = true;
let isStartupEnabled = false;

window.api.onStatus((status) => {
    
    statusText.innerText = status; // show full status message

    if (status === 'Connected') {
        statusIndicator.className = 'status-row connected';
        statusText.style.color = 'var(--ok)'; // green
        loginForm.style.display = 'none';
        connectedControls.style.display = 'block';
    } else {
        statusIndicator.className = 'status-row disconnected';
        statusText.style.color = 'var(--danger)'; // whole lotta red
        loginForm.style.display = 'block';
        connectedControls.style.display = 'none';
    }
});

connectBtn.addEventListener('click', () => {
    window.api.toggleConnection({ 
        apiKey: keyInput.value, 
        slug: slugInput.value 
    });
});

disconnectBtn.addEventListener('click', () => {
    window.api.toggleConnection({}); // empty triggers a disconnect logic in main
});

// settings logic
startupBtn.addEventListener('click', () => {
    isStartupEnabled = !isStartupEnabled;
    updateToggle(startupBtn, isStartupEnabled);
    window.api.toggleStartup(isStartupEnabled);
});

statsBtn.addEventListener('click', () => {
    isStatsEnabled = !isStatsEnabled;
    updateToggle(statsBtn, isStatsEnabled);
    window.api.toggleStats(isStatsEnabled);
});

function updateToggle(btn, active) {
    if (active) {
        btn.classList.add('active');
        btn.innerText = 'ON';
    } else {
        btn.classList.remove('active');
        btn.innerText = 'OFF';
    }
}