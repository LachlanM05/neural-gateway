import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from '../db.js';
import { sendVerificationEmail } from './mailer.js';

// path fix
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// app init
const PORT = process.env.PORT || 3333;
const app = express();

// middleware
app.set('trust proxy', true); // essential for apache ip tracking
app.use(express.static(path.join(__dirname, 'public')));
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({ secret: 'dev-secret', resave: false, saveUninitialized: false }));

// auth middleware
const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.redirect('/login');
  next();
};

const requireAdmin = (req, res, next) => {
  if (req.session.username !== 'LachlanM05') {
    return res.status(403).send('Access Denied: Admin Clearance Required.');
  }
  next();
};

// routes

// 1. landing page
app.get('/', (req, res) => res.render('index', { user: req.session.userId }));

// 2. login routes
app.get('/login', (req, res) => {
  const verified = req.query.verified === 'true'; 
  const error = req.query.error;
  res.render('login', { verified, error });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const ip = req.ip;

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  
  if (user && await bcrypt.compare(password, user.password_hash)) {
    // check suspsension
    if (user.is_suspended === 1) {
       return res.redirect('/login?error=Account Deletion in Progress. Contact Admin.');
    }

    // uppdate ip tracking
    db.prepare('UPDATE users SET last_login_ip = ? WHERE id = ?').run(ip, user.id);

    req.session.userId = user.id;
    req.session.username = user.username;
    
    if (user.username === 'LachlanM05') {
      return res.redirect('/admin');
    }
    
    res.redirect('/dashboard');
  } else {
    res.redirect('/login?error=Invalid credentials');
  }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// 3. registration routes
app.get('/register', (req, res) => {
  if (req.session.userId) return res.redirect('/dashboard');
  res.render('register');
});

app.post('/register', async (req, res) => {
  const { username, password, email, mailing_list } = req.body;
  if (!email || !username || !password) return res.send('All fields required.');

  const hash = await bcrypt.hash(password, 10);
  const token = crypto.randomBytes(32).toString('hex');
  const ip = req.ip;
  const mailingListValue = mailing_list === 'on' ? 1 : 0;

  try {
    const stmt = db.prepare(`
        INSERT INTO users (username, password_hash, email, verify_token, verified, signup_ip, last_login_ip, mailing_list) 
        VALUES (?, ?, ?, ?, 0, ?, ?, ?)
    `);
    stmt.run(username, hash, email, token, ip, ip, mailingListValue);
    
    try { sendVerificationEmail(email, token); } catch(e) { console.error("Email failed", e); }

    res.send(`
      <link rel="stylesheet" href="/style.css">
      <div class="splash-container">
        <div class="splash-card">
            <h1>Registration successful!</h1>
            <p>Please check your email (${email}) to verify your account.</p>
            <a href="/login" class="btn-primary" style="display:inline-block; margin-top:10px; text-decoration:none;">Login Now</a>
        </div>
      </div>
    `);
  } catch (e) { 
    console.error(e);
    res.send('Username or Email already taken.'); 
  }
});

// 4. verification routes
app.get('/verify', (req, res) => {
  const { token } = req.query;
  if (!token) return res.send('Invalid token.');
  const user = db.prepare('SELECT id FROM users WHERE verify_token = ?').get(token);
  if (!user) return res.send('Invalid or expired verification link.');
  db.prepare('UPDATE users SET verified = 1, verify_token = NULL WHERE id = ?').run(user.id);
  res.redirect('/login?verified=true');
});

// 5. admin panel (main)
app.get('/admin', requireAuth, requireAdmin, (req, res) => {
  const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users WHERE is_suspended = 0').get().count;
  const suspendedUsers = db.prepare('SELECT COUNT(*) as count FROM users WHERE is_suspended = 1').get().count;
  
  let totalQueries = 0;
  let active24h = 0;
  let logs = [];
  let hourlyStats = [];

  try {
      totalQueries = db.prepare('SELECT COUNT(*) as count FROM request_logs').get().count;
      active24h = db.prepare(`SELECT COUNT(DISTINCT client_id) as count FROM connection_logs WHERE connected_at > datetime('now', '-1 day')`).get().count;
      logs = db.prepare(`SELECT request_logs.*, clients.client_slug, users.username FROM request_logs JOIN clients ON request_logs.client_id = clients.id JOIN users ON clients.user_id = users.id ORDER BY timestamp DESC LIMIT 50`).all();
      
      hourlyStats = db.prepare(`
        SELECT strftime('%H:00', timestamp) as hour, COUNT(*) as count 
        FROM request_logs 
        WHERE timestamp > datetime('now', '-24 hours') 
        GROUP BY hour 
        ORDER BY timestamp ASC
      `).all();

  } catch (e) {
      console.log("Admin tables missing.");
  }

  res.render('admin', { totalUsers, suspendedUsers, totalQueries, active24h, logs, hourlyStats });
});

// 5b. admin subpage (userlist)
app.get('/admin/users', requireAuth, requireAdmin, (req, res) => {
    // detailed user list
    const users = db.prepare(`
      SELECT 
        users.*,
        (SELECT COUNT(*) FROM clients WHERE user_id = users.id) as client_count,
        (SELECT MAX(connected_at) FROM connection_logs 
         JOIN clients ON connection_logs.client_id = clients.id 
         WHERE clients.user_id = users.id) as last_active_connection
      FROM users
      ORDER BY id DESC
    `).all();
    
    res.render('admin_users', { users });
});

// 5c. admin hard delete
app.post('/admin/delete-user', requireAuth, requireAdmin, (req, res) => {
    const { user_id } = req.body;
    
    // prevent deleting self
    const target = db.prepare('SELECT username FROM users WHERE id = ?').get(user_id);
    if (target.username === 'LachlanM05') return res.redirect('/admin/users');

    try {
        // cascade delete (Clients -> Logs -> User)
        // purge logs, as i need storage space.
        const clients = db.prepare('SELECT id FROM clients WHERE user_id = ?').all(user_id);
        clients.forEach(c => {
            db.prepare('DELETE FROM request_logs WHERE client_id = ?').run(c.id);
            db.prepare('DELETE FROM connection_logs WHERE client_id = ?').run(c.id);
        });
        db.prepare('DELETE FROM clients WHERE user_id = ?').run(user_id);
        db.prepare('DELETE FROM users WHERE id = ?').run(user_id);
        
        console.log(`[Admin] Deleted user ${target.username}`);
    } catch(e) {
        console.error("Delete failed", e);
    }
    
    res.redirect('/admin/users');
});

// 6. user dash
app.get('/dashboard', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  const clients = db.prepare('SELECT * FROM clients WHERE user_id = ?').all(req.session.userId);
  res.render('dashboard', { user, clients });
});

// 7. user settings
app.get('/settings', requireAuth, (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    res.render('settings', { user });
});

app.post('/settings/update', requireAuth, (req, res) => {
    const { mailing_list, home_url } = req.body;
    const isSubscribed = mailing_list === 'on' ? 1 : 0;
    
    db.prepare('UPDATE users SET mailing_list = ?, home_url = ? WHERE id = ?')
      .run(isSubscribed, home_url, req.session.userId);
      
    res.redirect('/settings');
});

app.post('/account/delete', requireAuth, (req, res) => {
    // soft delete: mark for deletion by admin.
    db.prepare('UPDATE users SET is_suspended = 1 WHERE id = ?').run(req.session.userId);
    req.session.destroy();
    res.redirect('/login?error=Account marked for deletion.');
});

// 8. client management routes
app.post('/update-url', requireAuth, (req, res) => {
  db.prepare('UPDATE users SET home_url = ? WHERE id = ?').run(req.body.home_url, req.session.userId);
  res.redirect('/dashboard');
});

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

// 9. API endpoints
app.post('/api/report-stats', (req, res) => {
    const { apiKey, slug, specs, uptime } = req.body;
    try {
        const result = db.prepare('UPDATE clients SET hardware_info = ?, app_uptime = ?, last_seen_ip = ? WHERE api_key = ?')
                         .run(JSON.stringify(specs), uptime, req.ip, apiKey);
        if (result.changes === 0) return res.status(404).json({ error: "Invalid Key" });
        res.json({ ok: true });
    } catch(e) {
        res.status(500).json({ error: "Failed to log stats" });
    }
});

// start serv
app.listen(PORT, () => console.log(`Dashboard running on port ${PORT}`));
