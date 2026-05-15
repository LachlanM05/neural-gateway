import db from './db.js';

async function upgrade() {
  try {
    console.log("Creating access_logs table...");
    await db.query(`
        CREATE TABLE IF NOT EXISTS access_logs (
            id SERIAL PRIMARY KEY,
            ip_address TEXT,
            method TEXT,
            path TEXT,
            status_code INTEGER,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);
    console.log("Database upgraded for Access Logging.");
  } catch (e) { 
    console.log("Error:", e.message); 
  }
  process.exit(0);
}

upgrade();
