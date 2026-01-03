Came here by accident or mistake?
Go back to https://lachlanm05.com/neural-gateway or https://ai.lachlanm05.com

# Neural Gateway

Neural Gateway is a two-part system for routing AI requests from the internet to a user’s local hardware. It includes:

- **Gateway (server/gateway)**: An Express + WebSocket relay that accepts inbound HTTP requests and forwards them to a connected hardware client.
- **Dashboard (server/dashboard)**: An Express UI for user auth, client management, and basic stats.
- **Electron client (client/electron-app)**: Connects local hardware to the gateway and forwards requests to a local Ollama instance.

Disclaimer:
This project is not affiliated with, endorsed by, or supported by any AI platform.
It is a general-purpose, free, open-source tool that users may choose to configure with services they already use.

## Architecture

1. Internet client sends HTTP requests to the Gateway.
2. Gateway forwards the request over a WebSocket tunnel to the Electron client.
3. Electron client proxies the request to a local Ollama instance and returns the response.
4. Dashboard provides user and client management, IP whitelist controls, and basic usage stats.

## Requirements

- Node.js (recommended: v18+)
- npm
- Optional: Ollama running locally on the client machine (default `http://127.0.0.1:11434`)

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

## Running the services

### Start the Gateway

```bash
node server/gateway/server.js
```

- Default port: `8787`
- Environment variables:
  - `PORT` (default `8787`)
  - `TRUST_PROXY` (`true`/`false`, default `true`)

### Start the Dashboard

```bash
node server/dashboard/server.js
```

- Default port: `3333`
- Environment variables:
  - `PORT` (default `3333`)

### Start the Electron client

```bash
cd client/electron-app
npm run start
```

> **Note:** The Electron app is currently configured to connect to hosted endpoints. For local development, update the URLs near the top of `client/electron-app/main.js`:
>
> - `DASHBOARD_URL`
> - `GATEWAY_WS`
> - `LOCAL_OLLAMA`

## Data storage

The server uses SQLite via `better-sqlite3`. The database file is created at:

```
server/database.sqlite
```

## Security notes

- Gateway access is protected by API keys and an IP whitelist per client.
- Enable `catch_mode` in the dashboard to allow all IPs temporarily (logged).
- The dashboard’s email verification sender (`server/dashboard/mailer.js`) expects a configured Nodemailer transporter.
