# holonbridge-mcp-remote

Remote (HTTP/SSE) MCP transport for HolonBridge, enabling the **Claude web client** (`claude.ai`) to connect to a running HolonBridge/Fuseki instance as a native MCP integration — no Artifacts scaffolding, no manual `fetch()` wiring required.

## Architecture

```
claude.ai (web client)
    │
    │  HTTPS / SSE  ← MCP remote protocol
    ▼
holonbridge-mcp-remote   :3032  (this server, ngrok-exposed)
    │
    │  HTTP REST + Bearer token
    ▼
HolonBridge REST API     :3031
    │
    ▼
Apache Jena Fuseki       :3030
```

## Prerequisites

- Node.js ≥ 18
- A running HolonBridge instance (local or remote) with a valid bearer token
- An [ngrok](https://ngrok.com) account (free tier sufficient) for public HTTPS exposure
- A Claude.ai account with custom integrations enabled

## Setup

### 1. Install dependencies

The MCP remote server has its own dependency set, separate from HolonBridge.
Copy `package.mcp-remote.json` to `package.json` in a dedicated directory,
or merge the dependencies into HolonBridge's existing `package.json`:

```bash
mkdir holonbridge-mcp-remote
cp holonbridge-mcp-remote.js holonbridge-mcp-remote/
cp package.mcp-remote.json  holonbridge-mcp-remote/package.json
cd holonbridge-mcp-remote
npm install
```

Dependencies: `@modelcontextprotocol/sdk`, `express`, `cors`, `dotenv`, `zod`.

### 2. Configure environment

```bash
cp ../.env.mcp-remote.example .env
```

Edit `.env`:

```env
# Public HTTPS URL of your HolonBridge instance (ngrok URL, not localhost)
HOLONBRIDGE_URL=https://your-bridge.ngrok.io

# Bearer token that HolonBridge expects on incoming requests
HB_BEARER_TOKEN=<your-holonbridge-bearer-token>

# A separate secret that claude.ai must send to reach THIS server
# Generate: openssl rand -hex 32
MCP_REMOTE_TOKEN=<generate-a-new-secret>

# Port this server listens on
MCP_PORT=3032
```

> **Two-token model.** `HB_BEARER_TOKEN` authenticates this server to HolonBridge.
> `MCP_REMOTE_TOKEN` authenticates claude.ai to this server. They must be different values.
> Neither token is ever transmitted to the Claude API.

### 3. (Optional) Add named profiles

Named profiles let you switch between multiple HolonBridge endpoints from within
a Claude session via the `set_endpoint` tool:

```env
PROFILE_GGSC_URL=https://ggsc.ngrok.io
PROFILE_GGSC_LABEL=UN GGSC production bridge
PROFILE_LOCAL_URL=http://localhost:3031
PROFILE_LOCAL_LABEL=local dev bridge
```

Clients can list profiles with `list_endpoints` and switch with `set_endpoint`.
Profiles are server-side only — clients cannot add or remove them.

### 4. Start the server

```bash
node holonbridge-mcp-remote.js
```

Expected output:

```
holonbridge-mcp-remote listening on :3032
  HolonBridge target : https://your-bridge.ngrok.io
  Profiles           : default
  SSE endpoint       : http://localhost:3032/sse
  Health             : http://localhost:3032/health
```

### 5. Expose via ngrok

```bash
ngrok http 3032
# or with a stable subdomain:
ngrok http --url=your-name.ngrok.io 3032
```

Verify:

```bash
curl https://your-name.ngrok.io/health \
  -H "Authorization: Bearer <MCP_REMOTE_TOKEN>"
```

Expected:

```json
{
  "status": "ok",
  "server": "holonbridge-mcp-remote",
  "version": "1.0.0",
  "holonbridge": "https://your-bridge.ngrok.io",
  "profiles": ["default"],
  "activeProfile": "default"
}
```

### 6. Add to Claude.ai

1. Open **claude.ai → Settings → Integrations → Add custom integration**
2. **URL:** `https://your-name.ngrok.io/sse`
3. **Auth header:** `Authorization: Bearer <MCP_REMOTE_TOKEN>`
4. Save. Claude will discover the tools automatically.

---

## Available tools

All tools from the `holonbridge-mcp` stdio server (P1–P3) are exposed:

### Endpoint management

| Tool | Description |
|---|---|
| `list_endpoints` | List all named HolonBridge profiles |
| `get_endpoint` | Show the currently active profile |
| `set_endpoint(name)` | Switch to a named profile |

### SPARQL (P1)

| Tool | Description |
|---|---|
| `sparql_select(query, graph?)` | Execute a SELECT query; returns JSON bindings |
| `sparql_construct(query, graph?)` | Execute a CONSTRUCT query; returns Turtle |
| `sparql_update(update)` | Execute a SPARQL UPDATE (INSERT/DELETE/CLEAR) |

### Graph management (P1)

| Tool | Description |
|---|---|
| `push_turtle(turtle, graph_iri, shapes_graph?)` | PUT Turtle into a named graph via GSP; optionally SHACL-validate before push |
| `get_holon(holon_iri, projection_mode?)` | Retrieve a holon as a DataBook; modes: `immersive`, `cinematic`, `active_inference`, `exploded_view` |
| `list_graphs(filter?)` | List named graphs in Fuseki with triple counts |

### SHACL validation (P2)

| Tool | Description |
|---|---|
| `validate_turtle(turtle, shapes_graph)` | Validate a Turtle payload against a SHACL shapes graph; returns `sh:ValidationReport` as Turtle |

### Natural language query (P3)

| Tool | Description |
|---|---|
| `nl_query(question, graph?)` | Pose a natural language question; HolonBridge translates to SPARQL and returns results |

---

## CORS note

The server explicitly allows `https://claude.ai` and `https://api.claude.ai` as
origins, with `Authorization` and `Content-Type` in `Access-Control-Allow-Headers`,
and handles `OPTIONS` preflight before the auth middleware runs. This is required
for the web client's `fetch()` calls to reach the SSE endpoint.

HolonBridge itself also needs `Authorization` in its CORS allowed headers — see
the companion patch in `server.js` (commit `759dcee`).

---

## Troubleshooting

**`401 Unauthorized` on `/sse`**  
The `Authorization: Bearer <MCP_REMOTE_TOKEN>` header is missing or wrong in
your claude.ai integration config.

**`OPTIONS` returns `401`**  
The auth middleware is running before the CORS preflight handler. Ensure
`app.options('*', cors())` appears before `app.use(authMiddleware)` in the file.

**`POST /message` returns `404 No active session`**  
The SSE connection dropped before the message arrived (ngrok free tier idles
after 30 s of inactivity). Reconnect from claude.ai, or upgrade to ngrok paid
for persistent tunnels.

**HolonBridge calls fail with `ECONNREFUSED`**  
`HOLONBRIDGE_URL` is pointing at `localhost` — the MCP server cannot reach
HolonBridge's local port. Set `HOLONBRIDGE_URL` to the public ngrok HTTPS URL
of HolonBridge, not its local address.

---

## Running as a service (Linux)

```ini
# /etc/systemd/system/holonbridge-mcp-remote.service
[Unit]
Description=HolonBridge MCP Remote SSE Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/holonbridge-mcp-remote
ExecStart=/usr/bin/node holonbridge-mcp-remote.js
Restart=on-failure
EnvironmentFile=/opt/holonbridge-mcp-remote/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now holonbridge-mcp-remote
```

## Running as a service (Windows)

Use the same NSSM pattern as the main HolonBridge service:

```powershell
nssm install HolonbridgeMcpRemote "C:\Program Files\nodejs\node.exe"
nssm set HolonbridgeMcpRemote AppParameters "C:\holon\holonbridge-mcp-remote\holonbridge-mcp-remote.js"
nssm set HolonbridgeMcpRemote AppDirectory "C:\holon\holonbridge-mcp-remote"
nssm start HolonbridgeMcpRemote
```

---

*Part of the [HolonBridge](https://github.com/kurtcagle/holon-bridge) project.*  
*Maintained by Kurt Cagle / Chloe Shannon — [holongraph.com](https://holongraph.com)*
