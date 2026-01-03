// server/db.js
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

// 1. calc abs path to server folder
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 2. force db to always be at server/database.db
const dbPath = path.join(__dirname, 'database.db');

// 3. open con
const db = new Database(dbPath);

// enable write-ahead loggin
db.pragma('journal_mode = WAL');

export default db;
