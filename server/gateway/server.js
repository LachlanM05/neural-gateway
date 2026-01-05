import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import http from 'http';
import crypto from 'node:crypto'; 
import { WebSocketServer } from 'ws';
import db from '../db.js';

const PORT = process.env.PORT_GATEWAY || 8787;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));
app.use(morgan('tiny'));

const ALLOWED_ORIGINS = process.env.CORS_ALLOWED_ORIGINS 
    ? process.env.CORS_ALLOWED_ORIGINS.split(',').map(o => o.trim()) 
    : [];

console.log('[Gateway] Allowed Origins:', ALLOWED_ORIGINS);

app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        
        if (ALLOWED_ORIGINS.includes(origin)) {
            return callback(null, true);
        } else {
            console.log(`[CORS BLOCK] Blocked request from origin: '${origin}'`); 
            return callback(new Error(`CORS policy blocked access from: ${origin}`), false);
        }
    }
}));

app.use(rateLimit({
  windowMs: 60000,
  max: 200, 
  standardHeaders: true,
  legacyHeaders: false,
}));

const activeTunnels = new Map();
const pendingRequests = new Map();

const sendError = (res, status, message) => {
    res.status(status).json({ error: message });
};

// converted to async function to handle DB calls
wss.on('connection', async (ws, req) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    const username = url.searchParams.get('username');
    const slug = url.searchParams.get('slug');
    const apiKey = url.searchParams.get('key');

    if (!username || !slug || !apiKey) {
        console.log(`[WS] 🛑 Reject: Missing connection params`);
        ws.close(1008, 'Missing Params');
        return;
    }

    const res = await db.query(`
        SELECT clients.id, users.username 
        FROM clients 
        JOIN users ON clients.user_id = users.id 
        WHERE users.username = $1 AND clients.client_slug = $2 AND clients.api_key = $3
    `, [username, slug, apiKey]);

    const client = res.rows[0];

    if (!client) {
      console.log(`[WS] 🛑 Reject: Invalid Creds for ${username}/${slug}`);
      ws.close(1008, 'Invalid Credentials');
      return;
    }

    const tunnelId = `${username}/${slug}`;
    
    if (activeTunnels.has(tunnelId)) {
        console.log(`[WS] ⚠️ Overwriting existing session for ${tunnelId}`);
        activeTunnels.get(tunnelId).terminate();
    }

    console.log(`[WS] 🔌 Hardware Online: ${tunnelId}`);
    activeTunnels.set(tunnelId, ws);
    
    let sessionId = null;
    try {
        const logRes = await db.query(
            'INSERT INTO connection_logs (client_id, connected_at) VALUES ($1, NOW()) RETURNING id',
            [client.id]
        );
        sessionId = logRes.rows[0].id;
    } catch (e) { console.error('Failed to log session start', e); }

    ws.on('close', async () => {
        console.log(`[WS] ❌ Hardware Offline: ${tunnelId}`);
        activeTunnels.delete(tunnelId);
        
        if (sessionId) {
            try {
                await db.query('UPDATE connection_logs SET disconnected_at = NOW() WHERE id = $1', [sessionId]);
            } catch (e) { console.error('Failed to log session end', e); }
        }
    });

    ws.on('message', async (message) => {
        try {
            const response = JSON.parse(message);
            const pending = pendingRequests.get(response.requestId);
            if (pending) {
                db.query('INSERT INTO request_logs (client_id, model, duration_ms) VALUES ($1, $2, $3)', 
                    [client.id, pending.model || 'unknown', Date.now() - pending.startTime]
                ).catch(e => console.error('Stats Log Error:', e));

                pending.res.status(response.status || 200).json(response.data);
                pendingRequests.delete(response.requestId);
            }
        } catch (e) { console.error('[WS] Msg Error:', e); }
    });

  } catch (e) { 
      console.error(e);
      ws.close(); 
  }
});

async function verifyAccess(req, res, next) {
  if (req.method === 'OPTIONS') return next();

  const { username, clientid } = req.params;
  const incomingIP = req.ip || req.connection.remoteAddress;

  console.log(`[HTTP] Request from ${incomingIP} -> /users/${username}/${clientid}`);

  try {
      const userRes = await db.query('SELECT id FROM users WHERE username = $1', [username]);
      const user = userRes.rows[0];
      if (!user) return sendError(res, 404, 'User not found');

      const clientRes = await db.query('SELECT id, api_key FROM clients WHERE user_id = $1 AND client_slug = $2', [user.id, clientid]);
      const client = clientRes.rows[0];
      if (!client) return sendError(res, 404, 'Client Endpoint not found');

      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.replace('Bearer ', '').trim();
      if (token !== client.api_key) return sendError(res, 401, 'Invalid API Key');

      await db.query('UPDATE clients SET last_seen_ip = $1 WHERE id = $2', [incomingIP, client.id]);

      next();
  } catch (e) {
      console.error("Verify Error", e);
      return sendError(res, 500, "Internal Auth Error");
  }
}

async function handlePassthrough(req, res) {
  const { username, clientid } = req.params;
  const tunnelId = `${username}/${clientid}`;
  const tunnel = activeTunnels.get(tunnelId);

  if (!tunnel || tunnel.readyState !== 1) {
    return sendError(res, 502, 'User Hardware is offline.');
  }

  const requestId = Date.now() + '-' + crypto.randomBytes(4).toString('hex');
  const modifiedBody = req.body || {};
  
  if (modifiedBody.stream) {
      modifiedBody.stream = false; 
  }

  pendingRequests.set(requestId, { 
    res, 
    startTime: Date.now(), 
    model: modifiedBody.model 
  });

  tunnel.send(JSON.stringify({
    requestId,
    method: req.method,
    path: req.params[0],
    body: modifiedBody
  }));

  setTimeout(() => {
    if (pendingRequests.has(requestId)) {
      pendingRequests.get(requestId).res.status(504).json({ error: 'Gateway Timeout: GPU took too long.' });
      pendingRequests.delete(requestId);
    }
  }, 300000);
}

app.all('/users/:username/:clientid/*', verifyAccess, handlePassthrough);

server.listen(PORT, () => {
  console.log(`Gateway listening on port ${PORT}`);
});
server.setTimeout(300000);
