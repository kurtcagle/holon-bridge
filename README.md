# HolonBridge

**v2.9.0** — LLM ↔ Jena 6.0 semantic bridge.

HolonBridge sits between an Apache Jena Fuseki triplestore and any LLM client
(Claude, scripts, REST callers) and exposes it as a clean authenticated API:
SPARQL SELECT/CONSTRUCT/UPDATE, Graph Store Protocol push, SHACL 1.2 validation,
NL→SPARQL query, holon retrieval as DataBooks, named graph management, and a
federated profile registry.

The companion `mcp-remote/holonbridge-mcp-remote.js` server wraps all of the
above as MCP tools and exposes them to the **claude.ai web client** over
HTTPS/SSE — no Claude Code required.

---

## Architecture

```
claude.ai (web)       curl / DataBook CLI / scripts
     │                          │
  HTTPS/SSE                 HTTP REST
     │                          │
     ▼                          ▼
holonbridge-mcp-remote    ──────── HolonBridge REST API
:3032  (ngrok: kurtcagle-mcp.ngrok.io)     :3031  (ngrok: kurtcagle.ngrok.io)
                                                   │
                                            Apache Jena Fuseki
                                                  :3030  (internal only)
```

| Service | Local port | Public URL | Notes |
|---|---|---|---|
| Jena 6.0 Fuseki | 3030 | — | Never expose publicly |
| HolonBridge REST | 3031 | `kurtcagle.ngrok.io` | curl, DataBook CLI, artifacts |
| MCP remote SSE | 3032 | `kurtcagle-mcp.ngrok.io` | claude.ai integration |

---

## Prerequisites

- **Node.js ≥ 18.0.0**
- **Apache Jena Fuseki 6.x** — download from https://jena.apache.org/download/
- **ngrok** account (free tier works) — https://ngrok.com
- **Anthropic API key** — required for `nl_query` NL→SPARQL translation
- (Optional) **GitHub PAT** — for `github-push` / `github-delete` endpoints

---

## Repository layout

```
holon-bridge/
├── server.js                      # HolonBridge REST API (start this first)
├── sparql.js                      # top-level SPARQL helpers
├── package.json                   # v2.9.0; entry: server.js
├── .env.mcp-remote.example        # template for mcp-remote environment
├── holonbridge.config.ps1         # Windows path config (edit before first run)
├── lib/
│   ├── auth.js                    # Bearer token middleware
│   ├── databook.js                # DataBook parsing and routing
│   ├── format.js                  # response formatting
│   ├── llm.js                     # Anthropic SDK / NL→SPARQL
│   ├── shacl.js                   # SHACL 1.2 validation pipeline
│   ├── sparql.js                  # SPARQL query/update/GSP
│   └── validate.js                # input validation
├── mcp-remote/
│   ├── holonbridge-mcp-remote.js  # MCP SSE server for claude.ai
│   ├── package.json               # separate deps: @mcp/sdk, express, cors, zod
│   └── README-mcp-remote.md       # detailed MCP remote setup guide
├── registry/                      # federated endpoint registry
├── scripts/                       # setup and key generation helpers
└── Start-HolonBridge.ps1          # Windows: start all services in one go
```

---

## Installation

### 1. Clone and install (HolonBridge REST)

```bash
git clone https://github.com/kurtcagle/holon-bridge
cd holon-bridge
npm install
```

### 2. Install the MCP remote server

The MCP remote has its own package — install it separately:

```bash
cd mcp-remote
npm install
cd ..
```

---

## Configuration

### Generate tokens

You need **two separate secrets** before configuring anything:

```bash
# Token 1: authenticates callers to HolonBridge REST
openssl rand -hex 32

# Token 2: authenticates claude.ai (or other clients) to the MCP remote
openssl rand -hex 32
```

On Windows PowerShell:
```powershell
[System.Convert]::ToBase64String(
  [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
)
```

Store both securely (e.g. a password manager). **Never commit either to version control.**

---

### HolonBridge REST — `.env` (repo root)

Create `.env` in the repo root:

```env
# Fuseki connection
FUSEKI_URL=http://localhost:3030
FUSEKI_DATASET=ds

# Auth — paste Token 1 here
BEARER_TOKEN=<your-holonbridge-bearer-token>

# NL→SPARQL (required for nl_query endpoint)
ANTHROPIC_API_KEY=sk-ant-...

# Optional: GitHub integration (for /github-push and /github-delete endpoints)
# Generate at: https://github.com/settings/tokens
# Required scopes: repo (read + write contents)
GITHUB_PAT=ghp_...
GITHUB_OWNER=kurtcagle
GITHUB_REPO=chloe

# Server port (default: 3031)
PORT=3031

# SHACL validation gate (true = reject pushes that fail SHACL; false = warn only)
SHACL_REQUIRED=false
SHACL_GRAPH=urn:chloe:shacl
```

---

### MCP remote — `mcp-remote/.env`

```bash
cp .env.mcp-remote.example mcp-remote/.env
```

Edit `mcp-remote/.env`:

```env
# Public ngrok URL of HolonBridge REST (not localhost — the MCP remote is a
# separate process that cannot reach HolonBridge via localhost in all setups)
HOLONBRIDGE_URL=https://kurtcagle.ngrok.io

# Paste Token 1 here (same value as BEARER_TOKEN in root .env)
HB_BEARER_TOKEN=<your-holonbridge-bearer-token>

# Paste Token 2 here — this is what you enter in claude.ai's auth header field
MCP_REMOTE_TOKEN=<your-mcp-remote-token>

# MCP remote port
MCP_PORT=3032

# Your public MCP remote URL (used in OAuth metadata responses)
MCP_PUBLIC_URL=https://kurtcagle-mcp.ngrok.io

# Optional: legacy GSP tracking (no longer used by push_turtle, kept for /health)
FUSEKI_GSP=http://localhost:3030/ds/data

# Optional named profiles for federation
# Pattern: PROFILE_<NAME>_URL and PROFILE_<NAME>_LABEL
# PROFILE_GGSC_URL=https://ggsc.holongraph.com
# PROFILE_GGSC_LABEL=UN GGSC production bridge
# PROFILE_LOCAL_URL=http://localhost:3031
# PROFILE_LOCAL_LABEL=local dev
```

> **Two-token model:** `HB_BEARER_TOKEN` authenticates the MCP remote server
> to HolonBridge. `MCP_REMOTE_TOKEN` authenticates claude.ai to the MCP remote.
> They must be **different** values and neither is ever sent to Anthropic's API.

---

## Starting the stack

### Step 1 — Start Fuseki

```bash
# Linux / macOS
cd /path/to/apache-jena-fuseki
./fuseki-server --update --loc /path/to/data /ds

# Windows (edit holonbridge.config.ps1 paths first)
start-fuseki.bat
```

Verify: http://localhost:3030

### Step 2 — Start HolonBridge REST

```bash
# From the repo root
node server.js
# or: npm start
```

Expected output:
```
HolonBridge v2.9.0 listening on :3031
  Fuseki : http://localhost:3030/ds
  SHACL  : disabled
```

### Step 3 — Start the MCP remote

```bash
# From mcp-remote/
node holonbridge-mcp-remote.js
```

Expected output:
```
holonbridge-mcp-remote v1.9.0 listening on :3032
  HolonBridge target  : https://kurtcagle.ngrok.io
  Profiles            : default
  SSE endpoint        : http://localhost:3032/sse
  Health              : http://localhost:3032/health
```

### Step 4 — Open two ngrok tunnels

```bash
# Terminal A — HolonBridge REST
ngrok http --url=kurtcagle.ngrok.io 3031

# Terminal B — MCP remote
ngrok http --url=kurtcagle-mcp.ngrok.io 3032
```

Both subdomains are reserved and persist across restarts (ngrok free tier).

Verify:
```bash
curl https://kurtcagle.ngrok.io/health \
  -H "Authorization: Bearer <BEARER_TOKEN>"

curl https://kurtcagle-mcp.ngrok.io/health \
  -H "Authorization: Bearer <MCP_REMOTE_TOKEN>"
```

---

## Connect to claude.ai

1. Open **claude.ai → Settings → Integrations → Add custom integration**
2. **URL:** `https://kurtcagle-mcp.ngrok.io/sse`
3. **Authorization header:** `Authorization: Bearer <MCP_REMOTE_TOKEN>`
4. Save — Claude discovers the 12 MCP tools automatically.

At the start of each session, call `switch_dataset` to set the active Fuseki
dataset:
```
switch_dataset("chloe")   # or "storme", "ggsc", etc.
```

---

## Windows convenience

### One-shot dev start

Edit `holonbridge.config.ps1` to set your paths, then:

```powershell
.\Start-HolonBridge.ps1
```

This starts Fuseki, HolonBridge, both ngrok tunnels, and the MCP remote in
separate windows.

### Install as Windows services (NSSM)

```powershell
.\Install-HolonBridgeService.ps1
```

Installs HolonBridge REST and the MCP remote as persistent background services
that survive reboots. Requires [NSSM](https://nssm.cc).

### Linux (systemd)

```bash
bash install-holonbridge-service.sh
```

### macOS (launchd)

```bash
bash install-holonbridge-launchd.sh
```

---

## MCP tools (claude.ai)

| Tool | Description |
|---|---|
| `switch_dataset` | Set active Fuseki dataset for this session |
| `list_datasets` | List all datasets on the Fuseki instance |
| `sparql_select` | Run a SPARQL SELECT query; returns JSON bindings |
| `sparql_construct` | Run a SPARQL CONSTRUCT query; returns Turtle |
| `sparql_update` | Run a SPARQL UPDATE (INSERT/DELETE/CLEAR) |
| `push_turtle` | Push Turtle into a named graph (append by default; `mode="replace"` to overwrite) |
| `validate_turtle` | Validate Turtle against a SHACL shapes graph |
| `get_holon` | Retrieve a holon as a DataBook |
| `list_graphs` | List named graphs with triple counts |
| `nl_query` | Natural language → SPARQL → results |
| `list_endpoints` | List federation profiles |
| `set_endpoint` | Switch to a named federation profile |

> **`push_turtle` note:** uses `mode="append"` (POST/merge) by default. Pass
> `mode="replace"` only when you intend to overwrite the entire named graph.
> For targeted additions to an existing graph, prefer `sparql_update` INSERT DATA.

---

## REST API reference (direct callers)

All endpoints require `Authorization: Bearer <BEARER_TOKEN>`.

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/query` | `{ nl, graph? }` | NL→SPARQL query |
| POST | `/sparql-select` | `{ sparql }` | SPARQL SELECT |
| POST | `/sparql-construct` | `{ query }` | SPARQL CONSTRUCT |
| POST | `/sparql-update` | `{ update }` | SPARQL UPDATE |
| POST | `/update` | `{ turtle, graph?, mode? }` | GSP push via HolonBridge (`mode`: `append`\|`replace`, default `append`) |
| POST | `/dataset` | `{ dataset }` | Switch active Fuseki dataset |
| GET | `/datasets` | — | List all Fuseki datasets |
| GET | `/graphs` | — | List named graphs + triple counts |
| GET | `/health` | — | Health check + version |
| GET | `/description` | — | Full capability description |
| POST | `/github-push` | `{ owner, repo, branch, path, content, message }` | Push file to GitHub (requires `GITHUB_PAT`) |

---

## Key / token reference

| Key | Where | What it does |
|---|---|---|
| `BEARER_TOKEN` | root `.env` | Authenticates all callers to HolonBridge REST |
| `ANTHROPIC_API_KEY` | root `.env` | Powers `nl_query` NL→SPARQL translation |
| `GITHUB_PAT` | root `.env` | Enables `/github-push` and `/github-delete` |
| `HB_BEARER_TOKEN` | `mcp-remote/.env` | MCP remote → HolonBridge auth (same value as `BEARER_TOKEN`) |
| `MCP_REMOTE_TOKEN` | `mcp-remote/.env` | Authenticates claude.ai → MCP remote |

To generate `BEARER_TOKEN` / `MCP_REMOTE_TOKEN`:
```bash
openssl rand -hex 32
```

To generate a `GITHUB_PAT`:
- Go to https://github.com/settings/tokens
- Create a **fine-grained PAT** scoped to the target repo
- Required permission: **Contents: Read and write**

---

## Federation (named profiles)

To connect to a second HolonBridge instance (e.g. a collaborator's server),
add profile entries to `mcp-remote/.env`:

```env
PROFILE_GGSC_URL=https://ggsc-bridge.ngrok.io
PROFILE_GGSC_LABEL=GGSC production bridge
```

Then from claude.ai:
```
set_endpoint("ggsc")     # switch to GGSC bridge
sparql_select(...)       # queries run against GGSC's Fuseki
set_endpoint("default")  # switch back
```

Each profile points at a different HolonBridge REST instance. The MCP remote
holds the credentials; the LLM just names the profile.

---

## Troubleshooting

**401 on `/sse`**
The `MCP_REMOTE_TOKEN` in `mcp-remote/.env` doesn't match what you entered in
claude.ai's auth header. Check for trailing spaces.

**401 on HolonBridge calls**
`HB_BEARER_TOKEN` in `mcp-remote/.env` doesn't match `BEARER_TOKEN` in root `.env`.

**ECONNREFUSED from MCP remote**
`HOLONBRIDGE_URL` is set to `localhost` — the MCP remote is a separate process
and needs the public ngrok URL, not a local address.

**push_turtle overwrites graph data**
Expected if you called it without `mode="append"` on a pre-v1.9.0 server.
Upgrade to v1.9.0+ (default is now `append`). For existing graphs always prefer
`sparql_update` INSERT DATA.

**`nl_query` returns poor results**
Ensure data has `rdfs:label` annotations. Use full context in the question:
`"In the publications graph, which articles are in draft?"`

**ngrok session expired (`POST /message` returns 404)**
The free ngrok tier idles after 30s of inactivity. Reconnect from claude.ai,
or upgrade to ngrok paid for persistent tunnels.

**`PREFIX` syntax error in push_turtle**
Turtle payloads must use `@prefix` declarations, not SPARQL `PREFIX` keyword.

---

## Related

- [mcp-remote/README-mcp-remote.md](mcp-remote/README-mcp-remote.md) — detailed MCP remote setup
- [SKILL.md](SKILL.md) — AI-readable reference skill for Claude sessions
- [W3C Holon Community Group](https://www.w3.org/community/holon/)
- [holongraph.com](https://holongraph.com)

---

*Maintained by Kurt Cagle / Chloe Shannon — [holongraph.com](https://holongraph.com)*  
*Part of the [Holon Graph Architecture](https://github.com/w3c-cg/holon) project.*
