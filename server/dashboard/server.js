// dashboard/server.js — ESM
import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from '../db.js';
import { sendVerificationEmail } from './mailer.js';

// --- PATH FIX ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- APP INITIALIZATION ---
// Use 3000 by default, or 3333 if 3000 is busy/specified
const PORT = process.env.PORT || 3333;
const app = express(); // <--- MUST be defined before app.use()

// --- MIDDLEWARE ---
// 1. Static Files (CSS/Assets) - This was causing your error!
app.use(express.static(path.join(__dirname, 'public')));

// 2. View Engine
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// 3. Parsers & Session
app.use(express.urlencoded({ extended: true }));
app.use(express.json()); // Needed for API JSON bodies
app.use(session({ secret: 'dev-secret', resave: false, saveUninitialized: false }));


// --- AUTH MIDDLEWARE ---
const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.redirect('/login');
  next();
};

const requireAdmin = (req, res, next) => {
  // Hardcoded Admin Username check
  if (req.session.username !== 'LachlanM05') {
    return res.status(403).render('error', { message: 'Access Denied: Admin Clearance Required.' }); 
    // ^ Ensure you have an error.ejs or just use res.send('Access Denied')
  }
  next();
};


// --- ROUTES ---

// 1. Landing / Login
app.get('/', (req, res) => res.render('index', { user: req.session.userId }));

app.get('/login', (req, res) => {
  const verified = req.query.verified === 'true'; 
  res.render('login', { verified });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  
  if (user && await bcrypt.compare(password, user.password_hash)) {
    req.session.userId = user.id;
    req.session.username = user.username;
    
    // REDIRECT ADMIN vs USER
    if (user.username === 'LachlanM05') {
      return res.redirect('/admin');
    }
    
    res.redirect('/dashboard');
  } else {
    res.send('Invalid credentials');
  }
});

app.post('/register', async (req, res) => {
  const { username, password, email } = req.body;
  if (!email || !username || !password) return res.send('All fields required.');

  const hash = await bcrypt.hash(password, 10);
  const token = crypto.randomBytes(32).toString('hex');

  try {
    const stmt = db.prepare('INSERT INTO users (username, password_hash, email, verify_token, verified) VALUES (?, ?, ?, ?, 0)');
    stmt.run(username, hash, email, token);
    sendVerificationEmail(email, token);
    res.send(`<h1>Registration successful!</h1><p>Check ${email} for verification.</p><a href="/login">Login</a>`);
  } catch (e) { 
    console.error(e);
    res.send('Username or Email already taken.'); 
  }
});

// 2. Admin Panel
app.get('/admin', requireAuth, requireAdmin, (req, res) => {
  // Fetch Stats
  const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  
  // Safely check if table exists (in case you didn't run upgrade script)
  let totalQueries = 0;
  let active24h = 0;
  let logs = [];

  try {
      totalQueries = db.prepare('SELECT COUNT(*) as count FROM request_logs').get().count;
      active24h = db.prepare(`SELECT COUNT(DISTINCT client_id) as count FROM connection_logs WHERE connected_at > datetime('now', '-1 day')`).get().count;
      logs = db.prepare(`SELECT request_logs.*, clients.client_slug FROM request_logs JOIN clients ON request_logs.client_id = clients.id ORDER BY timestamp DESC LIMIT 50`).all();
  } catch (e) {
      console.log("Admin tables missing (request_logs/connection_logs). Logs disabled.");
  }

  res.render('admin', { totalUsers, totalQueries, active24h, logs });
});

// 3. User Dashboard
app.get('/dashboard', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  const clients = db.prepare('SELECT * FROM clients WHERE user_id = ?').all(req.session.userId);
  res.render('dashboard', { user, clients });
});

app.post('/update-url', requireAuth, (req, res) => {
  db.prepare('UPDATE users SET home_url = ? WHERE id = ?').run(req.body.home_url, req.session.userId);
  res.redirect('/dashboard');
});

// 4. Client Management
app.post('/create-client', requireAuth, (req, res) => {
  const { slug, ip_whitelist } = req.body;
  const apiKey = 'sk-' + Math.random().toString(36).substr(2, 9) + Math.random().toString(36).substr(2, 9);
  db.prepare('INSERT INTO clients (user_id, client_slug, api_key, whitelisted_ips) VALUES (?, ?, ?, ?)').run(req.session.userId, slug, apiKey, ip_whitelist);
  res.redirect('/dashboard');
});

app.post('/toggle-catch-mode', requireAuth, (req, res) => {
  const { client_id } = req.body;
  const client = db.prepare('SELECT catch_mode FROM clients WHERE id = ? AND user_id = ?').get(client_id, req.session.userId);
  if (client) {
    db.prepare('UPDATE clients SET catch_mode = ? WHERE id = ?').run(client.catch_mode ? 0 : 1, client_id);
  }
  res.redirect('/dashboard');
});

app.post('/update-whitelist', requireAuth, (req, res) => {
  const { client_id, whitelisted_ips } = req.body;
  db.prepare('UPDATE clients SET whitelisted_ips = ? WHERE id = ? AND user_id = ?').run(whitelisted_ips, client_id, req.session.userId);
  res.redirect('/dashboard');
});

// 5. API Endpoints (For Electron App)
app.post('/api/report-stats', (req, res) => {
    const { apiKey, slug, specs, uptime } = req.body;
    try {
        db.prepare('UPDATE clients SET hardware_info = ?, app_uptime = ? WHERE client_slug = ?').run(JSON.stringify(specs), uptime, slug);
        res.json({ ok: true });
    } catch(e) {
        console.error("Stats Error:", e.message);
        res.status(500).json({ error: "Failed to log stats" });
    }
});

// Start Server
app.listen(PORT, () => console.log(`Dashboard running on port ${PORT}`));