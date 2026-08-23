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
const wss = new WebSocketServer({ noServer: true });

app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
    res.on('finish', () => {
        const ip = req.ip || req.connection.remoteAddress;
        
        console.log(`[Gateway] HTTP ${req.method} ${req.originalUrl} | IP: ${ip} | STATUS: ${res.statusCode}`);
        
        db.query(
            'INSERT INTO access_logs (ip_address, method, path, status_code) VALUES ($1, $2, $3, $4)', 
            [ip, req.method, req.originalUrl, res.statusCode]
        ).catch(e => console.error("[Gateway] Failed to log access to DB", e.message));
    });
    next();
});

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

server.on('upgrade', async (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const username = url.searchParams.get('username');
    const slug = url.searchParams.get('slug');
    const apiKey = url.searchParams.get('key');
    const incomingIP = request.headers['x-forwarded-for']?.split(',')[0].trim() || request.socket.remoteAddress;

    if (!username || !slug || !apiKey) {
        console.log(`[WS] 🛑 Reject: Missing connection params from ${incomingIP}`);
        db.query('INSERT INTO access_logs (ip_address, method, path, status_code) VALUES ($1, $2, $3, $4)', [incomingIP, 'WS-UPGRADE', request.url, 400]).catch(()=>{});
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
    }

    try {
        const resDb = await db.query(`
            SELECT clients.id, users.username 
            FROM clients 
            JOIN users ON clients.user_id = users.id 
            WHERE users.username = $1 AND clients.client_slug = $2 AND clients.api_key = $3
        `, [username, slug, apiKey]);

        const client = resDb.rows[0];

        if (!client) {
            console.log(`[WS] 🛑 Reject: Invalid Creds for ${username}/${slug} from IP ${incomingIP}`);
            db.query('INSERT INTO access_logs (ip_address, method, path, status_code) VALUES ($1, $2, $3, $4)', [incomingIP, 'WS-UPGRADE', `/users/${username}/${slug}`, 401]).catch(()=>{});
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }

        db.query('INSERT INTO access_logs (ip_address, method, path, status_code) VALUES ($1, $2, $3, $4)', [incomingIP, 'WS-UPGRADE', `/users/${username}/${slug}`, 101]).catch(()=>{});

        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request, client);
        });
    } catch (e) {
        console.error(e);
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        socket.destroy();
    }
});

// converted to async function to handle DB calls
wss.on('connection', async (ws, req, client) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    const username = url.searchParams.get('username');
    const slug = url.searchParams.get('slug');

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

    // Replace the ws.on('close') event in server/gateway/server.js with this:
    ws.on('close', async () => {
        console.log('[WS] ❌ Hardware Offline: ' + tunnelId);
        activeTunnels.delete(tunnelId);
        
        try {
            // Reset uptime to 0 so the dashboard shows Offline
            await db.query('UPDATE clients SET app_uptime = 0 WHERE id = $1', [client.id]);
            
            if (sessionId) {
                await db.query('UPDATE connection_logs SET disconnected_at = NOW() WHERE id = $1', [sessionId]);
            }
        } catch (e) { 
            console.error('Failed to log session end', e); 
        }
    });

    ws.on('message', async (message) => {
        try {
            const response = JSON.parse(message);
            
            // Intercept stats/online status pings from the client
            if (response.type === 'stats') {
                const incomingIP = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
                
                // Ensure uptime is an integer to prevent Postgres int32 conversion errors
                const safeUptime = Math.round(Number(response.uptime)) || 0;

                await db.query(
                    'UPDATE clients SET hardware_info = $1, app_uptime = $2, last_seen_ip = $3 WHERE id = $4',
                    [JSON.stringify(response.specs), safeUptime, incomingIP, client.id]
                );
                return; // Stop processing further for stats messages
            }

            // Normal model response processing
            const pending = pendingRequests.get(response.requestId);
            if (pending) {
                if (pending.keepAliveInterval) {
                    clearInterval(pending.keepAliveInterval);
                    pending.keepAliveInterval = null;
                }

                if (response.isStreamChunk) {
                    if (!pending.headersSent) {
                        pending.res.setHeader('Content-Type', 'application/x-ndjson');
                        pending.res.setHeader('Cache-Control', 'no-cache');
                        pending.res.setHeader('Connection', 'keep-alive');
                        pending.res.setHeader('X-Accel-Buffering', 'no');
                        pending.res.flushHeaders();
                        pending.headersSent = true;
                    }
                    if (!pending.res.writableEnded) {
                        pending.res.write(response.data);
                    }
                } else if (response.isStreamEnd) {
                    if (pending.keepAliveInterval) {
                        clearInterval(pending.keepAliveInterval);
                        pending.keepAliveInterval = null;
                    }
                    db.query('INSERT INTO request_logs (client_id, model, duration_ms) VALUES ($1, $2, $3)', 
                        [client.id, pending.model || 'unknown', Date.now() - pending.startTime]
                    ).catch(e => console.error('Stats Log Error:', e));
                    if (!pending.res.writableEnded) {
                        pending.res.end();
                    }
                    pendingRequests.delete(response.requestId);
                } else {
                    db.query('INSERT INTO request_logs (client_id, model, duration_ms) VALUES ($1, $2, $3)', 
                        [client.id, pending.model || 'unknown', Date.now() - pending.startTime]
                    ).catch(e => console.error('Stats Log Error:', e));

                    if (pending.headersSent) {
                        pending.res.write(JSON.stringify(response.data));
                        pending.res.end();
                    } else {
                        pending.res.status(response.status || 200).json(response.data);
                    }
                    pendingRequests.delete(response.requestId);
                }
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

      await db.query('UPDATE clients SET last_seen_ip = $1 WHERE id = $2', [req.ip || req.connection.remoteAddress, client.id]);

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
  
  const isStream = modifiedBody.stream === true;

  const pending = { 
    res, 
    startTime: Date.now(), 
    model: modifiedBody.model,
    headersSent: false,
    isStream
  };

  // for streaming requests, immediately flush headers so Cloudflare sees activity
  if (isStream) {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.status(200);
    res.flushHeaders();
    pending.headersSent = true;
  }

  // keep-alive: send periodic bytes to prevent Cloudflare 524
  pending.keepAliveInterval = setInterval(() => {
    const p = pendingRequests.get(requestId);
    if (p && !res.writableEnded) {
      if (p.isStream) {
        // ignored by ndjson parser, but keeps conn alive
        p.res.write(': keep-alive\n\n');
      } else {
        // for non streaming requests, send a single space to keep conn alive
        // JSON.parse() ignores leading whitespace
        if (!p.headersSent) {
          p.res.setHeader('Content-Type', 'application/json');
          p.res.status(200);
          p.res.flushHeaders();
          p.headersSent = true;
        }
        p.res.write(' ');
      }
    }
  }, 15000);

  pendingRequests.set(requestId, pending);

  tunnel.send(JSON.stringify({
    requestId,
    method: req.method,
    path: req.params[0],
    body: modifiedBody
  }));

  setTimeout(() => {
    if (pendingRequests.has(requestId)) {
      const p = pendingRequests.get(requestId);
      if (p.keepAliveInterval) clearInterval(p.keepAliveInterval);
      if (!res.writableEnded) {
        if (p.headersSent) {
            p.res.end(JSON.stringify({ error: 'Gateway Timeout: GPU took too long.' }));
        } else {
            p.res.status(504).json({ error: 'Gateway Timeout: GPU took too long.' });
        }
      }
      pendingRequests.delete(requestId);
    }
  }, 300000);
}

// --- DIAGNOSTIC ENDPOINT ---
app.post('/api/diagnostic/ping-node', async (req, res) => {
  const { username, slug, key } = req.body;

  if (!username || !slug || !key) {
      return sendError(res, 400, 'Missing credentials for diagnostic test.');
  }

  try {
      // 1. Verify credentials against the database
      const dbRes = await db.query(`
          SELECT clients.id
          FROM clients 
          JOIN users ON clients.user_id = users.id 
          WHERE users.username = $1 AND clients.client_slug = $2 AND clients.api_key = $3
      `, [username, slug, key]);

      if (dbRes.rows.length === 0) {
          return sendError(res, 401, 'Diagnostic Failed: Invalid Credentials');
      }

      // 2. Check if the WebSocket tunnel is currently active
      const tunnelId = `${username}/${slug}`;
      const tunnel = activeTunnels.get(tunnelId);

      if (!tunnel || tunnel.readyState !== 1) { // 1 = WebSocket.OPEN
          return sendError(res, 502, 'Diagnostic Failed: Node is not connected to the Gateway.');
      }

      // 3. Send the diagnostic request through the tunnel
      const requestId = 'diag-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
      
      // We leverage the existing pendingRequests system. 
      // When the node replies, the standard ws.on('message') will fulfill this HTTP response.
      pendingRequests.set(requestId, { 
          res, 
          startTime: Date.now(), 
          model: 'diagnostic-ping' 
      });

      // We use the lightweight api/tags endpoint to verify Ollama is reachable 
      // without triggering a heavy generation task.
      tunnel.send(JSON.stringify({
          requestId,
          method: 'GET',
          path: 'api/tags', 
          body: {}
      }));

      // 4. Timeout fallback (14 seconds to respond just before the client's 15s timeout hits)
      setTimeout(() => {
          if (pendingRequests.has(requestId)) {
              pendingRequests.get(requestId).res.status(504).json({ error: 'Diagnostic Timeout: Node did not respond in time.' });
              pendingRequests.delete(requestId);
          }
      }, 14000);

  } catch (e) {
      console.error('[Gateway] Diagnostic error:', e);
      sendError(res, 500, 'Internal Server Error during diagnostic ping');
  }
});

app.all('/users/:username/:clientid/*', verifyAccess, handlePassthrough);

server.listen(PORT, () => {
  console.log(`Gateway listening on port ${PORT}`);
});
server.setTimeout(300000);
