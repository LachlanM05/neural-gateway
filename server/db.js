import Database from 'better-sqlite3';
import path from 'node:path';

const dbPath = path.resolve('database.sqlite');
const db = new Database(dbPath);

// init tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    email TEXT,
    password_hash TEXT,
    home_url TEXT,
    verify_token TEXT,
    verified INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    client_slug TEXT,
    api_key TEXT,
    whitelisted_ips TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);

export default db;