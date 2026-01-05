import db from './db.js';

try {
  db.exec(`CREATE TABLE IF NOT EXISTS request_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER,
    model TEXT,
    duration_ms INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  

  db.exec(`CREATE TABLE IF NOT EXISTS connection_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER,
    connected_at DATETIME,
    disconnected_at DATETIME
  )`);
  

  db.exec(`ALTER TABLE clients ADD COLUMN hardware_info TEXT`);
  db.exec(`ALTER TABLE clients ADD COLUMN app_uptime INTEGER DEFAULT 0`);

  console.log("Database upgraded for Stats & Admin.");
} catch (e) { console.log(e); }