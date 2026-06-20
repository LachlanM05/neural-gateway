import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from '../db.js';
import rateLimit from 'express-rate-limit';
import { sendVerificationEmail, sendPasswordResetEmail, sendGlobalEmail } from './mailer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3333;
const IS_PROD = process.env.NODE_ENV === 'production';
const app = express();

// Rate limite for login and registration to prevent abuse
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 7, // limit each IP to 7 requests per windowMs
  message: "Too many attempts from this IP, please try again after 15 minutes",
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
});

app.set('trust proxy', true); 

app.use(express.static(path.join(__dirname, 'public')));
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const IGNORED_LOG_PATHS = ['/dashboard', '/settings', '/update-url', '/admin', '/.well-known/security.txt'];

app.use((req, res, next) => {
  res.on('finish', () => {
    const p = req.path;
    if (IGNORED_LOG_PATHS.includes(p) || p.endsWith('.css') || p.endsWith('.ico') || p.endsWith('.png') || p.endsWith('.jpg')) {
      return;
    }
    console.log(`[PM2] ACCESS: ${req.method} ${req.originalUrl} | IP: ${req.ip} | STATUS: ${res.statusCode}`);
    
    db.query(
      'INSERT INTO access_logs (ip_address, method, path, status_code) VALUES ($1, $2, $3, $4)', 
      [req.ip, req.method, req.originalUrl, res.statusCode]
    ).catch(e => console.error("[PM2] Failed to log access to DB", e.message));
  });
  next();
});

app.use(session({ 
  secret: process.env.SESSION_SECRET || 'dev-fallback-do-not-use-in-prod', 
  resave: false, 
  saveUninitialized: false,
  name: 'ng_sid',
  cookie: {
    secure: IS_PROD, 
    httpOnly: true,  
    maxAge: 1000 * 60 * 60 * 24 * 7, 
    sameSite: 'lax'
  }
}));

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

app.get('/', (req, res) => res.render('index', { user: req.session.userId }));
app.get('/cli', (req, res) => res.render('cli', { user: req.session.userId }));
app.get('/login', (req, res) => {
  const verified = req.query.verified === 'true'; 
  const error = req.query.error;
  res.render('login', { verified, error });
});

app.post('/login', authLimiter, async (req, res, next) => {
  const { username, password } = req.body;
  const ip = req.ip;

  try {
    const { rows } = await db.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = rows[0];
    
    if (user && await bcrypt.compare(password, user.password_hash)) {
      if (user.is_suspended === 1) {
         console.log(`[PM2] LOGIN BLOCKED: Suspended account '${username}' from IP ${ip}`);
         return res.redirect('/login?error=Account Deletion in Progress. Contact Admin.');
      }

      await db.query('UPDATE users SET last_login_ip = $1 WHERE id = $2', [ip, user.id]);

      req.session.regenerate((err) => {
          if (err) return next(err);

          req.session.userId = user.id;
          req.session.username = user.username;
          console.log(`[PM2] LOGIN SUCCESS: User '${username}' from IP ${ip}`);

          req.session.save((err) => {
              if (err) return next(err);
              if (user.username === 'LachlanM05') return res.redirect('/admin');
              res.redirect('/dashboard');
          });
      });

    } else {
      console.log(`[PM2] LOGIN FAILED: User '${username}' from IP ${ip}`);
      res.redirect('/login?error=Invalid credentials');
    }
  } catch (err) {
    next(err);
  }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

app.get('/register', (req, res) => {
  if (req.session.userId) return res.redirect('/dashboard');
  res.render('register');
});

app.post('/register', authLimiter, async (req, res) => {
  // Verify Turnstile
  const turnstileToken = req.body['cf-turnstile-response'];

  // kick if no token
  if (!turnstileToken) {
    console.log(`[PM2] REGISTRATION FAILED: No Turnstile token from IP ${req.ip}`);
    return res.status(400).send('Bot validation failed, please try again.');
  }

  const formData = new FormData();
  formData.append('secret', process.env.TURNSTILE_SECRET);
  formData.append('response', turnstileToken);
  formData.append('remoteip', req.ip);

  const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    body: formData,
    method: 'POST',
  });

  const outcome = await result.json();
  if (!outcome.success) {
    return res.status(403).send('Bot validation failed, please try again.');
  }

  const { username, password, email, mailing_list } = req.body;
  if (!email || !username || !password) return res.send('All fields required.');

  const hash = await bcrypt.hash(password, 10);
  const token = crypto.randomBytes(32).toString('hex');
  const ip = req.ip;
  const mailingListValue = mailing_list === 'on' ? 1 : 0;

  try {
    const stmt = `
        INSERT INTO users (username, password_hash, email, verify_token, verified, signup_ip, last_login_ip, mailing_list) 
        VALUES ($1, $2, $3, $4, 0, $5, $6, $7)
    `;
    await db.query(stmt, [username, hash, email, token, ip, ip, mailingListValue]);
    
    try { await sendVerificationEmail(email, token); } catch(e) { console.error("Email failed", e); }
    console.log(`[PM2] REGISTRATION SUCCESS: User '${username}' from IP ${ip}`);

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
    console.log(`[PM2] REGISTRATION FAILED: '${username}' or '${email}' taken. IP ${ip}`);
    res.send('Username or Email already taken.'); 
  }
});

app.get('/verify', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.send('Invalid token.');
  
  try {
    const { rows } = await db.query('SELECT id FROM users WHERE verify_token = $1', [token]);
    const user = rows[0];
    
    if (!user) return res.send('Invalid or expired verification link.');
    
    await db.query('UPDATE users SET verified = 1, verify_token = NULL WHERE id = $1', [user.id]);
    res.redirect('/login?verified=true');
  } catch (err) {
    res.status(500).send("Verification Error");
  }
});

app.get('/forgot-password', (req, res) => {
  res.render('forgot_password', { error: req.query.error, success: req.query.success });
});

app.post('/forgot-password', authLimiter, async (req, res) => {
  const { email } = req.body;
  const ip = req.ip;
  console.log(`[PM2] PASSWORD RESET REQUEST: Email '${email}' from IP ${ip}`);
  try {
    const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = rows[0];
    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      await db.query('UPDATE users SET reset_token = $1 WHERE id = $2', [token, user.id]);
      try { await sendPasswordResetEmail(email, token); } catch (e) { console.error("[PM2] ERROR sending reset email:", e); }
    }
    res.redirect('/forgot-password?success=If your email exists in our system, a password reset link has been sent.');
  } catch (err) {
    console.error("[PM2] ERROR in forgot password:", err);
    res.redirect('/forgot-password?error=Server error');
  }
});

app.get('/reset-password', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.send('Invalid token.');
  try {
    const { rows } = await db.query('SELECT id FROM users WHERE reset_token = $1', [token]);
    if (!rows[0]) return res.send('Invalid or expired reset link.');
    res.render('reset_password', { token, error: req.query.error });
  } catch (err) {
    res.status(500).send("Database Error");
  }
});

app.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.redirect(`/reset-password?token=${token}&error=All fields required.`);
  try {
    const { rows } = await db.query('SELECT id, username FROM users WHERE reset_token = $1', [token]);
    const user = rows[0];
    if (!user) return res.send('Invalid or expired reset link.');
    
    const hash = await bcrypt.hash(password, 10);
    await db.query('UPDATE users SET password_hash = $1, reset_token = NULL WHERE id = $2', [hash, user.id]);
    console.log(`[PM2] PASSWORD RESET SUCCESS: User '${user.username}'`);
    
    res.redirect('/login?verified=true'); 
  } catch (err) {
    console.error("[PM2] ERROR resetting password:", err);
    res.redirect(`/reset-password?token=${token}&error=Server error`);
  }
});

app.get('/admin', requireAuth, requireAdmin, async (req, res) => {
  try {
      const userCountRes = await db.query('SELECT COUNT(*) as count FROM users WHERE is_suspended = 0');
      const suspendedCountRes = await db.query('SELECT COUNT(*) as count FROM users WHERE is_suspended = 1');
      const queryCountRes = await db.query('SELECT COUNT(*) as count FROM request_logs');
      
      // Postgres interval syntax
      const activeRes = await db.query(`SELECT COUNT(DISTINCT client_id) as count FROM connection_logs WHERE connected_at > NOW() - INTERVAL '1 day'`);
      
      const logsRes = await db.query(`
          SELECT request_logs.*, clients.client_slug, users.username 
          FROM request_logs 
          JOIN clients ON request_logs.client_id = clients.id 
          JOIN users ON clients.user_id = users.id 
          ORDER BY timestamp DESC LIMIT 50
      `);

      // Postgres to_char for formatting hour
      const hourlyRes = await db.query(`
        SELECT to_char(timestamp, 'HH24:00') as hour, COUNT(*) as count 
        FROM request_logs 
        WHERE timestamp > NOW() - INTERVAL '24 hours'
        GROUP BY hour 
        ORDER BY MIN(timestamp) ASC
      `);

      const totalUsers = userCountRes.rows[0].count;
      const suspendedUsers = suspendedCountRes.rows[0].count;
      const totalQueries = queryCountRes.rows[0].count;
      const active24h = activeRes.rows[0].count;
      const logs = logsRes.rows;
      const hourlyStats = hourlyRes.rows;

      res.render('admin', { totalUsers, suspendedUsers, totalQueries, active24h, logs, hourlyStats });
  } catch (e) {
      console.error("Admin stats error:", e);
      res.status(500).send("Database Error");
  }
});

app.get('/admin/users', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { rows: users } = await db.query(`
          SELECT 
            users.*,
            (SELECT COUNT(*) FROM clients WHERE user_id = users.id) as client_count,
            (SELECT MAX(connected_at) FROM connection_logs 
             JOIN clients ON connection_logs.client_id = clients.id 
             WHERE clients.user_id = users.id) as last_active_connection
          FROM users
          ORDER BY id DESC
        `);
        
        res.render('admin_users', { users });
    } catch (e) {
        console.error(e);
        res.status(500).send("DB Error");
    }
});

app.post('/admin/delete-user', requireAuth, requireAdmin, async (req, res) => {
    const { user_id } = req.body;
    
    try {
        const { rows } = await db.query('SELECT username FROM users WHERE id = $1', [user_id]);
        if (rows[0] && rows[0].username === 'LachlanM05') return res.redirect('/admin/users');

        await db.query('DELETE FROM users WHERE id = $1', [user_id]);
        
    } catch(e) {
        console.error("Delete failed", e);
    }
    
    res.redirect('/admin/users');
});

app.post('/admin/send-reset', requireAuth, requireAdmin, async (req, res) => {
    const { user_id } = req.body;
    try {
        const { rows } = await db.query('SELECT id, email, username FROM users WHERE id = $1', [user_id]);
        const user = rows[0];
        if (user) {
            const token = crypto.randomBytes(32).toString('hex');
            await db.query('UPDATE users SET reset_token = $1 WHERE id = $2', [token, user.id]);
            try { await sendPasswordResetEmail(user.email, token); } catch (e) { console.error("[PM2] ERROR sending reset email from admin:", e); }
            console.log(`[PM2] ADMIN SENT RESET: For user '${user.username}'`);
        }
    } catch(e) {
        console.error("[PM2] ERROR admin reset:", e);
    }
    res.redirect('/admin/users');
});

app.get('/admin/mailer', requireAuth, requireAdmin, (req, res) => {
    res.render('admin_mailer', { success: req.query.success, error: req.query.error });
});

app.post('/admin/mailer', requireAuth, requireAdmin, async (req, res) => {
    const { target, subject, body } = req.body;
    console.log(`[PM2] ADMIN MAILER INITIATED: Target '${target}', Subject '${subject}'`);
    try {
        let query = 'SELECT email FROM users WHERE is_suspended = 0 AND verified = 1';
        if (target === 'mailing_list') {
            query += ' AND mailing_list = 1';
        }
        const { rows } = await db.query(query);
        const emails = rows.map(r => r.email);
        
        console.log(`[PM2] ADMIN MAILER: Sending to ${emails.length} users.`);
        if (emails.length > 0) {
            sendGlobalEmail(emails, subject, body).catch(e => console.error("[PM2] ERROR sending global email:", e));
        }
        res.redirect('/admin/mailer?success=Emails dispatched to background sender.');
    } catch(e) {
        console.error("[PM2] ERROR admin mailer:", e);
        res.redirect('/admin/mailer?error=Database error');
    }
});

app.get('/admin/access-logs', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { rows } = await db.query('SELECT * FROM access_logs ORDER BY id DESC LIMIT 500');
        res.render('admin_access_logs', { logs: rows });
    } catch (e) {
        console.error(e);
        res.status(500).send("DB Error");
    }
});

app.get('/dashboard', requireAuth, async (req, res) => {
  try {
      const userRes = await db.query('SELECT * FROM users WHERE id = $1', [req.session.userId]);
      const clientsRes = await db.query('SELECT * FROM clients WHERE user_id = $1', [req.session.userId]);
      res.render('dashboard', { user: userRes.rows[0], clients: clientsRes.rows });
  } catch (e) {
      res.status(500).send("DB Error");
  }
});

app.get('/settings', requireAuth, async (req, res) => {
    try {
        const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [req.session.userId]);
        res.render('settings', { user: rows[0] });
    } catch (e) {
        res.status(500).send("DB Error");
    }
});

app.post('/settings/update', requireAuth, async (req, res) => {
    const { mailing_list, home_url } = req.body;
    const isSubscribed = mailing_list === 'on' ? 1 : 0;
    
    await db.query('UPDATE users SET mailing_list = $1, home_url = $2 WHERE id = $3', 
        [isSubscribed, home_url, req.session.userId]);
      
    res.redirect('/settings');
});

app.post('/account/delete', requireAuth, async (req, res) => {
    await db.query('UPDATE users SET is_suspended = 1 WHERE id = $1', [req.session.userId]);
    req.session.destroy();
    res.redirect('/login?error=Account marked for deletion.');
});

app.post('/update-url', requireAuth, async (req, res) => {
  await db.query('UPDATE users SET home_url = $1 WHERE id = $2', [req.body.home_url, req.session.userId]);
  res.redirect('/dashboard');
});

app.post('/create-client', requireAuth, async (req, res) => {
  const { slug } = req.body;
  
  const apiKey = 'sk-' + crypto.randomBytes(24).toString('hex');
  const dummyIP = '*'; 
  
  await db.query('INSERT INTO clients (user_id, client_slug, api_key, whitelisted_ips) VALUES ($1, $2, $3, $4)', 
    [req.session.userId, slug, apiKey, dummyIP]);
  res.redirect('/dashboard');
});

app.post('/api/report-stats', async (req, res) => {
    const { apiKey, slug, specs, uptime } = req.body;
    try {
        const result = await db.query(
            'UPDATE clients SET hardware_info = $1, app_uptime = $2, last_seen_ip = $3 WHERE api_key = $4',
            [JSON.stringify(specs), uptime, req.ip, apiKey]
        );
        if (result.rowCount === 0) return res.status(404).json({ error: "Invalid Key" });
        res.json({ ok: true });
    } catch(e) {
        res.status(500).json({ error: "Failed to log stats" });
    }
});

app.listen(PORT, () => console.log(`Dashboard running on port ${PORT}`));
