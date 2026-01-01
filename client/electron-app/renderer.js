// Grab Elements
const statusText = document.getElementById('statusText');
const statusDot = document.getElementById('statusDot'); // Ensure you have this in HTML or remove if not using dot
const loginForm = document.getElementById('loginForm');
const connectedControls = document.getElementById('connectedControls');

// Inputs
// MAKE SURE these IDs match your index.html exactly!
const usernameInput = document.getElementById('usernameInput'); 
const slugInput = document.getElementById('slugInput');
const keyInput = document.getElementById('keyInput');

// Buttons
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');

// Toggles (Assumes you have these IDs in HTML)
const startupToggle = document.getElementById('startupToggle');
const statsToggle = document.getElementById('statsToggle');

// 1. Load Saved Data on Startup
usernameInput.value = localStorage.getItem('username') || '';
slugInput.value = localStorage.getItem('slug') || '';
keyInput.value = localStorage.getItem('apiKey') || '';

// 2. Connect Button Listener
connectBtn.addEventListener('click', async () => {
    const username = usernameInput.value.trim();
    const slug = slugInput.value.trim();
    const apiKey = keyInput.value.trim();

    if (!username || !slug || !apiKey) {
        // Simple alert since we don't have a log box in your specific snippet
        alert('Please fill in Username, Slug, and API Key'); 
        return;
    }

    // Save for next time
    localStorage.setItem('username', username);
    localStorage.setItem('slug', slug);
    localStorage.setItem('apiKey', apiKey);

    // Send everything to Main
    // THIS WAS THE MISSING PART
    await window.api.toggleConnection({ username, apiKey, slug });
});

// 3. Disconnect Button Listener
disconnectBtn.addEventListener('click', async () => {
    // We send the current creds just in case, but Main handles the disconnect logic
    await window.api.toggleConnection({ 
        username: usernameInput.value, 
        apiKey: keyInput.value, 
        slug: slugInput.value 
    });
});

// 4. Handle Status Updates from Main
window.api.onStatus((message) => {
    // Show full status message
    statusText.innerText = message; 

    // Simple State Machine for UI
    if (message.includes('Connected') && !message.includes('Error')) {
        // ONLINE STATE
        // If you are using specific classes for the indicator:
        if(document.getElementById('statusIndicator')) {
             document.getElementById('statusIndicator').className = 'status-row connected';
        }
        
        statusText.style.color = 'var(--ok)'; // Green
        loginForm.style.display = 'none';
        connectedControls.style.display = 'block';
    } else if (message.includes('Disconnected') || message.includes('Error')) {
        // OFFLINE STATE
        if(document.getElementById('statusIndicator')) {
             document.getElementById('statusIndicator').className = 'status-row disconnected';
        }

        statusText.style.color = 'var(--danger)'; // Red
        loginForm.style.display = 'block';
        connectedControls.style.display = 'none';
    }
});