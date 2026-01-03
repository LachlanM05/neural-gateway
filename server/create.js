import db from './db.js';

console.log("STARTING DATABASE RESET...");

try {
  // 1. users table
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password_hash TEXT,
      email TEXT UNIQUE,
      verify_token TEXT,
      verified INTEGER DEFAULT 0,
      home_url TEXT,
      
      -- NEW TRACKING COLUMNS
      signup_ip TEXT,
      last_login_ip TEXT,
      mailing_list INTEGER DEFAULT 0,
      is_suspended INTEGER DEFAULT 0, -- Soft Delete status
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log("Users Table Created ✅");

  // 2. clients table (tuns)
  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      client_slug TEXT,
      api_key TEXT,
      whitelisted_ips TEXT,
      catch_mode INTEGER DEFAULT 0,
      last_seen_ip TEXT,
      hardware_info TEXT,
      app_uptime INTEGER DEFAULT 0,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  console.log("Clients Table Created ✅");

  // 3. request logs
  db.exec(`
    CREATE TABLE IF NOT EXISTS request_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER,
      model TEXT,
      duration_ms INTEGER,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(client_id) REFERENCES clients(id)
    )
  `);
  console.log("Request Logs Table Created ✅");

  // 4. con logs
  db.exec(`
    CREATE TABLE IF NOT EXISTS connection_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER,
      connected_at DATETIME,
      disconnected_at DATETIME,
      FOREIGN KEY(client_id) REFERENCES clients(id)
    )
  `);
  console.log("Connection Logs Table Created ✅");

  console.log("\n✅ DATABASE SUCCESSFULLY INITIALIZED. ✅");

} catch (e) {
  console.error("❌ ERROR:", e.message);
}
