// gateway/server.js — ESM
// The Central AI Passthrough Gateway (WebSocket Edition + Stats)
import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import http from 'http';
import { WebSocketServer } from 'ws';
import db from '../db.js'; // Shared DB

const {
  PORT = 8787,
  TRUST_PROXY = 'true'
} = process.env;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// 1. Essential Middleware
app.set('trust proxy', TRUST_PROXY === 'true');
app.use(express.json({ limit: '10mb' }));
app.use(morgan('tiny'));
app.use(cors());

// 2. Global Rate Limiter
const limiter = rateLimit({
  windowMs: 60000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// --- TUNNEL STATE MANAGEMENT ---
// Map<ClientSlug, WebSocket>
const activeTunnels = new Map();
// Map<RequestId, { res, startTime, model }>
const pendingRequests = new Map();


// 3. WebSocket Handler (Hardware Connections)
wss.on('connection', (ws, req) => {
  try {
    // Parse params: ws://api.lachlanm05.com/tunnel?slug=test&key=sk-123
    const url = new URL(req.url, `http://${req.headers.host}`);
    const slug = url.searchParams.get('slug');
    const apiKey = url.searchParams.get('key');

    // Authenticate the Hardware
    const client = db.prepare('SELECT * FROM clients WHERE client_slug = ? AND api_key = ?').get(slug, apiKey);

    if (!client) {
      console.log(`[WS] Connection rejected: Invalid credentials for slug ${slug}`);
      ws.close(1008, 'Invalid Credentials');
      return;
    }

    // --- START SESSION LOGGING ---
    const sessionStart = new Date().toISOString();
    let sessionId = null;
    try {
      const result = db.prepare('INSERT INTO connection_logs (client_id, connected_at) VALUES (?, ?)').run(client.id, sessionStart);
      sessionId = result.lastInsertRowid;
    } catch (e) { console.error('Failed to log session start', e); }

    // Success - Register Tunnel
    console.log(`[WS] 🔌 Hardware Online: ${slug}`);
    activeTunnels.set(slug, ws);

    // Handle Disconnect
    ws.on('close', () => {
      console.log(`[WS] ❌ Hardware Offline: ${slug}`);
      activeTunnels.delete(slug);

      // --- END SESSION LOGGING ---
      if (sessionId) {
        try {
          const now = new Date().toISOString();
          db.prepare('UPDATE connection_logs SET disconnected_at = ? WHERE id = ?').run(now, sessionId);
        } catch (e) { console.error('Failed to log session end', e); }
      }
    });

    // Handle Responses from Hardware
    ws.on('message', (message) => {
      try {
        const response = JSON.parse(message);
        const { requestId, status, data } = response;

        // Find the HTTP request waiting for this answer
        const pending = pendingRequests.get(requestId);
        if (pending) {
          
          // --- STATS LOGGING ---
          try {
            const duration = Date.now() - pending.startTime;
            const modelUsed = pending.model || 'unknown';
            db.prepare('INSERT INTO request_logs (client_id, model, duration_ms) VALUES (?, ?, ?)')
              .run(client.id, modelUsed, duration);
          } catch (e) { console.error('Stats Log Error:', e); }

          // Send the answer back to the internet user
          pending.res.status(status || 200).json(data);
          pendingRequests.delete(requestId);
        }
      } catch (e) {
        console.error('[WS] Error processing message:', e);
      }
    });

  } catch (e) {
    console.error('[WS] Connection error:', e);
    ws.close();
  }
});


// 4. HTTP Security Middleware (The Guard)
async function verifyAccess(req, res, next) {
  const { username, clientid } = req.params;

  // A. Find User
  const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // B. Find Client
  const client = db.prepare('SELECT id, api_key, whitelisted_ips, catch_mode FROM clients WHERE user_id = ? AND client_slug = ?').get(user.id, clientid);
  if (!client) return res.status(404).json({ error: 'Client ID not found' });

  // D. API Key Check (Must be valid first)
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();

  if (token !== client.api_key) {
    return res.status(401).json({ error: 'Invalid API Key' });
  }

  // --- NEW: IP CAPTURE LOGIC ---
  const incomingIP = req.ip || req.connection.remoteAddress;
  
  // 1. Always update the 'last_seen_ip' so the user can see it in Dashboard
  db.prepare('UPDATE clients SET last_seen_ip = ? WHERE id = ?').run(incomingIP, client.id);

  // 2. Check Catch Mode
  if (client.catch_mode === 1) {
    // Catch Mode is ON: Allow everything, log to console
    console.log(`[Catch Mode] Allowed IP ${incomingIP} for ${clientid}`);
    return next();
  }

  // C. Normal Whitelist Check
  const allowed = client.whitelisted_ips.split(',').map(ip => ip.trim());
  const isAllowed = allowed.includes('*') || allowed.includes(incomingIP);

  if (!isAllowed) {
    console.warn(`[Block] IP ${incomingIP} tried to access ${username}/${clientid}`);
    res.header('Access-Control-Allow-Origin', '*');
    return res.status(403).json({ 
      error: 'Access Denied: IP not whitelisted',
      detected_ip: incomingIP 
    });
  }

  next();
}

// 5. The Passthrough Handler (HTTP -> WebSocket)
async function handlePassthrough(req, res) {
  const { clientid } = req.params;

  // A. Check if Hardware is Online
  const tunnel = activeTunnels.get(clientid);
  if (!tunnel || tunnel.readyState !== 1) { // 1 = OPEN
    return res.status(502).json({ 
      error: 'Bad Gateway', 
      message: 'User Hardware is currently offline or disconnected.' 
    });
  }

  // B. Create Request Package
  const requestId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
  
  // Extract model name for logging (if present)
  const modelName = req.body && req.body.model ? req.body.model : null;

  // Store the HTTP 'res' object so we can reply later
  // Added startTime and model for stats logging
  pendingRequests.set(requestId, { 
    res, 
    startTime: Date.now(), 
    model: modelName 
  });

  // C. Send to Hardware
  const payload = {
    requestId,
    method: req.method,
    path: req.params[0], // The wildcard part (e.g. 'api/generate')
    body: req.body
  };

  tunnel.send(JSON.stringify(payload));

  // D. Safety Timeout (UPDATED to 5 Minutes / 300000ms)
  setTimeout(() => {
    if (pendingRequests.has(requestId)) {
      pendingRequests.get(requestId).res.status(504).json({ error: 'Gateway Timeout: Hardware did not respond in time.' });
      pendingRequests.delete(requestId);
    }
  }, 300000);
}

// 6. Routes
// Matches: /users/lachlan/test/api/generate
app.all('/users/:username/:clientid/*', verifyAccess, handlePassthrough);

// 7. Start Server
const listener = server.listen(PORT, () => {
  console.log(`Gateway listening on port ${PORT}`);
  console.log(`WebSocket endpoint ready at ws://localhost:${PORT}/tunnel`);
});

// FORCE Socket Timeout to 5 minutes (prevents 'NetworkError' on long gens)
listener.setTimeout(300000);