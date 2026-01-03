import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import http from 'http';
import { WebSocketServer } from 'ws';
import db from '../db.js';

const { PORT = 8787, TRUST_PROXY = 'true' } = process.env;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// 1. ess middleware
app.set('trust proxy', TRUST_PROXY === 'true');
app.use(express.json({ limit: '10mb' }));
app.use(morgan('tiny'));
app.use(cors({ origin: '*' })); // global cors

// 2. global rate limit
app.use(rateLimit({
  windowMs: 60000,
  max: 250, // TODO: play with this number some more to find a perfect limit
  standardHeaders: true,
  legacyHeaders: false,
}));

// --- TUNNEL STATE MANAGEMENT ---
// key: "username/slug" example, "LachlanM05/webgpu" -> value: WebSocket
const activeTunnels = new Map();
const pendingRequests = new Map();

// helpy to ensure cors on errors
const sendError = (res, status, message) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.status(status).json({ error: message });
};

// 3. websocket handler
wss.on('connection', (ws, req) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    // 1. READ EXPLICIT PARAMS
    const username = url.searchParams.get('username');
    const slug = url.searchParams.get('slug');
    const apiKey = url.searchParams.get('key');

    if (!username || !slug || !apiKey) {
        console.log(`[WS] 🛑 Reject: Missing connection params`);
        ws.close(1008, 'Missing Params');
        return;
    }

    // 2. VERIFY EXACT MATCH
    const client = db.prepare(`
        SELECT clients.id, users.username 
        FROM clients 
        JOIN users ON clients.user_id = users.id 
        WHERE users.username = ? AND clients.client_slug = ? AND clients.api_key = ?
    `).get(username, slug, apiKey);

    if (!client) {
      console.log(`[WS] 🛑 Reject: Invalid Creds for ${username}/${slug}`);
      ws.close(1008, 'Invalid Credentials');
      return;
    }

    // 3. REGISTER TUNNEL (Explicit ID)
    const tunnelId = `${username}/${slug}`; // "LachlanM05/webgpu"
    
    // close existing connection if any
    if (activeTunnels.has(tunnelId)) {
        console.log(`[WS] ⚠️ Overwriting existing session for ${tunnelId}`);
        activeTunnels.get(tunnelId).terminate();
    }

    console.log(`[WS] 🔌 Hardware Online: ${tunnelId}`);
    activeTunnels.set(tunnelId, ws);
    
    // log session
    const sessionStart = new Date().toISOString();
    let sessionId = null;
    try {
        const result = db.prepare('INSERT INTO connection_logs (client_id, connected_at) VALUES (?, ?)').run(client.id, sessionStart);
        sessionId = result.lastInsertRowid;
    } catch (e) { console.error('Failed to log session start', e); }

    ws.on('close', () => {
        console.log(`[WS] ❌ Hardware Offline: ${tunnelId}`);
        activeTunnels.delete(tunnelId);
        
        if (sessionId) {
            try {
                db.prepare('UPDATE connection_logs SET disconnected_at = ? WHERE id = ?').run(new Date().toISOString(), sessionId);
            } catch (e) { console.error('Failed to log session end', e); }
        }
    });

    ws.on('message', (message) => {
        try {
            const response = JSON.parse(message);
            const pending = pendingRequests.get(response.requestId);
            if (pending) {
                // log stats
                try {
                    db.prepare('INSERT INTO request_logs (client_id, model, duration_ms) VALUES (?, ?, ?)')
                    .run(client.id, pending.model || 'unknown', Date.now() - pending.startTime);
                } catch (e) { console.error('Stats Log Error:', e); }

                pending.res.status(response.status || 200).json(response.data);
                pendingRequests.delete(response.requestId);
            }
        } catch (e) { console.error('[WS] Msg Error:', e); }
    });

  } catch (e) { ws.close(); }
});

// 4. HTTP security middleware
async function verifyAccess(req, res, next) {
  // allow preflight
  if (req.method === 'OPTIONS') return next();

  const { username, clientid } = req.params;
  const incomingIP = req.ip || req.connection.remoteAddress;

  console.log(`[HTTP] Request from ${incomingIP} -> /users/${username}/${clientid}`);

  // A. check user
  const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!user) {
      console.warn(`[HTTP] User not found: ${username}`);
      return sendError(res, 404, 'User not found');
  }

  // B. check client
  const client = db.prepare('SELECT id, api_key, whitelisted_ips, catch_mode FROM clients WHERE user_id = ? AND client_slug = ?').get(user.id, clientid);
  if (!client) {
      console.warn(`[HTTP] Client not found: ${clientid} for user ${username}`);
      return sendError(res, 404, 'Client Endpoint not found');
  }

  // C. API key check
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (token !== client.api_key) {
      console.warn(`[HTTP] Invalid API Key for ${username}/${clientid}`);
      return sendError(res, 401, 'Invalid API Key');
  }

  // D. IP checkzs
  db.prepare('UPDATE clients SET last_seen_ip = ? WHERE id = ?').run(incomingIP, client.id);

  if (client.catch_mode === 1) {
    console.log(`[Catch Mode] Allowed ${incomingIP}`);
    return next();
  }

  const allowed = client.whitelisted_ips.split(',').map(ip => ip.trim());
  if (!allowed.includes('*') && !allowed.includes(incomingIP)) {
    console.warn(`[Block] IP ${incomingIP} blocked`);
    return sendError(res, 403, `Access Denied: IP ${incomingIP} not whitelisted`);
  }

  next();
}

// 5. passthrough handler
async function handlePassthrough(req, res) {
  const { username, clientid } = req.params;
  
  // A. check tun status
  const tunnelId = `${username}/${clientid}`;
  const tunnel = activeTunnels.get(tunnelId);

  if (!tunnel || tunnel.readyState !== 1) {
    console.warn(`[HTTP] Tunnel Offline: ${tunnelId}`);
    return sendError(res, 502, 'User Hardware is offline.');
  }

  const requestId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
  
  // --- FIX: FORCE DISABLE STREAMING (disabled streaming due to a few bugs) ---
  const modifiedBody = req.body || {};
  if (modifiedBody.stream) {
      console.log(`[Proxy] ⚠️ Force-disabling stream for request ${requestId}`);
      modifiedBody.stream = false;
  }

  pendingRequests.set(requestId, { 
    res, 
    startTime: Date.now(), 
    model: modifiedBody.model 
  });

  // B. send to hardware
  tunnel.send(JSON.stringify({
    requestId,
    method: req.method,
    path: req.params[0],
    body: modifiedBody // send the modified body
  }));

  // C. safety timeout (5min)
  setTimeout(() => {
    if (pendingRequests.has(requestId)) {
      console.log(`[Proxy] ⏱️ Timeout for ${requestId}`);
      pendingRequests.get(requestId).res.status(504).json({ error: 'Gateway Timeout: GPU took too long.' });
      pendingRequests.delete(requestId);
    }
  }, 300000);
}

// 6. routes
app.all('/users/:username/:clientid/*', verifyAccess, handlePassthrough);

// 7. start
server.listen(PORT, () => {
  console.log(`Gateway listening on port ${PORT}`);
});
server.setTimeout(300000);
