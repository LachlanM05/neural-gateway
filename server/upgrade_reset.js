import db from './db.js';

async function upgrade() {
  try {
    console.log("Adding reset_token to users table...");
    await db.query(`ALTER TABLE users ADD COLUMN reset_token TEXT;`);
    console.log("Database upgraded for Password Resets.");
  } catch (e) { 
    console.log("Error or column already exists:", e.message); 
  }
  process.exit(0);
}

upgrade();
