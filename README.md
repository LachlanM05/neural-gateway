Came here by accident or mistake?
Go back to https://ai.lachlanm05.com

# Neural Gateway

Neural Gateway routes AI requests from the internet to a user’s local hardware through a secure WebSocket tunnel. It is composed of:

- **Gateway (`server/gateway`)**: Express + WebSocket relay that receives HTTP requests and forwards them to a connected hardware client.
- **Dashboard (`server/dashboard`)**: Express UI for user auth, client management, and basic usage stats.
- **Electron client (`client/electron-app`)**: Connects local hardware to the gateway and proxies requests to a local Ollama instance.

Disclaimer:
This project is not affiliated with, endorsed by, or supported by any AI platform.
It is a general-purpose, free, open-source tool that users may choose to configure with services they already use.

## Architecture

1. Internet client sends HTTP requests to the Gateway.
2. Gateway forwards the request over a WebSocket tunnel to the Electron client.
3. Electron client proxies the request to a local Ollama instance and returns the response.
4. Dashboard provides user and client management, and usage stats.

## Requirements

- Node.js (recommended: v18+)
- npm
- Postgres (for the Dashboard/Gateway data store)
- Optional: Ollama running locally on the client machine (default `http://127.0.0.1:11434`)

## Repository layout

```
client/electron-app   # Electron desktop client
server/gateway        # HTTP + WebSocket gateway
server/dashboard      # Dashboard UI + auth
server/init_db.js     # Postgres schema bootstrap
```


## Setup

### Server dependencies

```bash
cd server
npm install
```

### Client dependencies

```bash
cd client/electron-app
npm install
```

## Configuration

### Postgres

The server uses `pg` and expects standard Postgres environment variables (or `DATABASE_URL`). For example:

```bash
export PGHOST=localhost
export PGPORT=5432
export PGUSER=neural_gateway
export PGPASSWORD=your_password
export PGDATABASE=neural_gateway
```

Initialize tables:

```bash
node server/init_db.js
```

### Gateway environment variables

- `PORT_GATEWAY` (default `8787`)
- `CORS_ALLOWED_ORIGINS` (comma-separated list; if unset, the Gateway allows any origin)

### Dashboard environment variables

- `PORT` (default `3333`)
- `SESSION_SECRET` (required for secure sessions)
- `NODE_ENV` (`production` enables secure cookies)

### Email verification

The dashboard uses Nodemailer to send verification emails. Configure a transporter in `server/dashboard/mailer.js` before running registration flows.


## Running the services

### Start the Gateway

```bash
node server/gateway/server.js
```


### Start the Dashboard

```bash
node server/dashboard/server.js
```


### Start the Electron client

```bash
cd client/electron-app
npm run start
```

> **Local development note**: The Electron app defaults to hosted endpoints. For local development, update the URLs near the top of `client/electron-app/main.js`:
>
> - `DASHBOARD_URL`
> - `GATEWAY_WS`
> - `LOCAL_OLLAMA`

## Request flow

Gateway requests are routed through:

```
POST /users/:username/:clientid/*
```


Include the client API key as a bearer token:

```
Authorization: Bearer <api_key>
```

The Gateway will forward the request body to the connected client and return its response.

## Security notes

- Gateway access is protected by API keys and per-client IP tracking.
- Sessions are cookie-based with `SESSION_SECRET` (set `NODE_ENV=production` for secure cookies).
- `CORS_ALLOWED_ORIGINS` should be set in production to avoid unwanted browser access.
