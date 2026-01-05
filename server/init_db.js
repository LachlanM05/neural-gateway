import db from './db.js';

const schema = `
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    verify_token TEXT,
    verified INTEGER DEFAULT 0,
    signup_ip TEXT,
    last_login_ip TEXT,
    mailing_list INTEGER DEFAULT 0,
    is_suspended INTEGER DEFAULT 0,
    home_url TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS clients (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    client_slug TEXT NOT NULL,
    api_key TEXT NOT NULL,
    whitelisted_ips TEXT,
    hardware_info TEXT,
    app_uptime INTEGER DEFAULT 0,
    last_seen_ip TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS connection_logs (
    id SERIAL PRIMARY KEY,
    client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
    connected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    disconnected_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS request_logs (
    id SERIAL PRIMARY KEY,
    client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
    model TEXT,
    duration_ms INTEGER,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
`;

async function run() {
    try {
        console.log("⏳ Connecting to Postgres...");
        await db.query(schema);
        console.log("✅ Success! Tables created.");
        process.exit(0);
    } catch (err) {
        console.error("❌ Error:", err.message);
        process.exit(1);
    }
}

run();
