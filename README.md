---
id: https://w3id.org/holonbridge/docs/instructions-for-ben-v1
title: "HolonBridge: Access and Setup Instructions"
subtitle: "For Ben Wortley — GGSC Supply Chain Knowledge Graph"
type: databook
version: 1.0.0
date: 2026-06-15
status: active
author:
  name: Kurt Cagle
  organisation: Semantical LLC
audience: technical-setup
---

# HolonBridge: Access and Setup Instructions

**Prepared for:** Ben Wortley, UN Global Geodesy Coordinating Entity
**Date:** June 2026
**Contact:** kurt.cagle@gmail.com | kurt@holongraph.com

---

## What Is HolonBridge?

HolonBridge is a lightweight server that sits in front of a Jena Fuseki
triplestore and makes it accessible to Claude and other AI tools. It does
three things:

1. **Accepts natural language queries** and translates them to SPARQL
2. **Stores and retrieves RDF data** via a simple REST API
3. **Exposes everything as MCP tools** so Claude can call it directly during a
   conversation

The GGSC supply chain knowledge graph you have been working with lives in a
HolonBridge instance running on my machine in Olympia, WA, exposed publicly via
an ngrok tunnel at `https://kurtcagle.ngrok.io`. You have two options:

- **Option A** — Use my running instance directly (fastest; read/write access to
  the GGSC dataset)
- **Option B** — Run your own HolonBridge instance locally or on a server you
  control (full independence; required for client deployments)

Both options are covered below.

---

## Option A — Access My Running Instance from Claude

This gets you querying and writing to the GGSC knowledge graph from your own
Claude session within minutes. No installation required.

### What you need

- A Claude.ai account (Pro or higher)
- The bearer token I will send you separately via secure channel

### Step 1 — Verify the endpoint is reachable

Open a browser and go to:

```
https://kurtcagle.ngrok.io/health
```

You should see a JSON response with `"status": "ok"`. If you see a browser
error, the service may be temporarily offline — contact me.

### Step 2 — Test with curl (optional)

If you have curl available (macOS, Linux, or Windows PowerShell), verify
authenticated access:

```bash
curl -s -X POST https://kurtcagle.ngrok.io/query \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -d '{"nl":"How many workflow tiers are in the dataset?"}'
```

You should receive a JSON response with an `answer` field. If you get a 401
error, the token is incorrect.

### Step 3 — Query from Claude

The simplest approach is to paste queries into a Claude conversation and have
Claude call the API on your behalf. Share this prompt with Claude at the start
of a session:

```
I am working with the UN-GGCE supply chain knowledge graph hosted at
https://kurtcagle.ngrok.io. The bearer token is: YOUR_TOKEN_HERE

The dataset is called /ds and contains risk assessment data for five geodetic
workflows (EOP, ICRF, ITRF, Satellite Orbits, Global Gravity Field), scored
using a PPTD capability maturity framework.

Please query this endpoint to answer my questions about the supply chain data.
```

Claude will then call the `/query` endpoint using natural language or the
`/named-queries` endpoint for structured queries.

### Available endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/health` | GET | Check service status |
| `/query` | POST | Natural language query → SPARQL → answer |
| `/named-queries` | GET | List all registered named queries |
| `/query` with `queryId` | POST | Execute a named query directly |
| `/datasets` | GET | List available datasets |
| `/dataset` | POST | Switch active dataset |
| `/update` | POST | Push Turtle data to a named graph |
| `/reload` | POST | Reload context DataBooks |
| `/description` | GET | Current session configuration |

### Useful named queries (no parameters needed)

Call these with `POST /query` and `{"queryId": "query-name"}`:

| Query ID | What it returns |
|---|---|
| `list-tier-risk-scores` | All 25 tiers ranked by risk score |
| `pptd-by-workflow` | PPTD maturity averages per workflow |
| `pptd-dimension-summary` | Supply-chain-wide People/Process/Technology/Data averages |
| `principle-violation-summary` | Count of violations per guiding principle (P1–P6) |
| `named-graph-inventory` | All named graphs with triple counts |

### Example: run a named query

```bash
curl -s -X POST https://kurtcagle.ngrok.io/query \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -d '{"queryId": "list-tier-risk-scores"}'
```

---

## Option B — Set Up Your Own HolonBridge

This gives you a fully independent instance. You can load your own data,
define your own context, and connect it to your own Claude account. This is
the right approach for client deployments.

### Prerequisites

| Component | Version | Notes |
|---|---|---|
| Java | ≥ 11 | Required for Jena Fuseki |
| Node.js | ≥ 18.0.0 | Required for HolonBridge |
| npm | ≥ 9.0.0 | Installed with Node.js |
| Anthropic API key | — | Required for natural language queries |
| ngrok account | Free tier | Optional; only needed for external access |

**Installing Java (if not already installed):**

- Windows: download from https://adoptium.net (Temurin 21 LTS recommended)
- macOS: `brew install openjdk@21`
- Ubuntu/Debian: `sudo apt install openjdk-21-jdk`

**Installing Node.js:**

- All platforms: download from https://nodejs.org (LTS version)
- macOS: `brew install node`
- Ubuntu/Debian: `sudo apt install nodejs npm`

---

### Part 1 — Install Jena Fuseki

Fuseki is the RDF triplestore that HolonBridge wraps.

**Step 1 — Download**

Go to https://jena.apache.org/download/ and download the latest
`apache-jena-fuseki-X.X.X.zip` release (currently 6.1.0).

**Step 2 — Extract**

```bash
# macOS / Linux
unzip apache-jena-fuseki-6.1.0.zip
cd apache-jena-fuseki-6.1.0

# Windows: extract to C:\apache\apache-jena-fuseki-6.1.0
# Then open PowerShell and cd to that directory
```

**Step 3 — Start Fuseki**

```bash
# macOS / Linux (in-memory dataset — data is lost on restart)
./fuseki-server --update --mem /ds

# Windows PowerShell (in-memory)
.\fuseki-server.bat --update --mem /ds
```

For persistent storage (data survives restarts):

```bash
# macOS / Linux
./fuseki-server --update --loc ./data /ds

# Windows
.\fuseki-server.bat --update --loc .\data /ds
```

Fuseki starts on port 3030. Verify at `http://localhost:3030` — you should
see the Fuseki web interface.

**Important:** Never expose port 3030 to the internet. Fuseki has no
authentication. HolonBridge provides the authentication layer.

---

### Part 2 — Install HolonBridge

**Step 1 — Clone the repository**

```bash
git clone https://github.com/kurtcagle/holon-bridge
cd holon-bridge
npm install
```

**Step 2 — Create the environment file**

Create a file called `.env` in the `holon-bridge` directory:

```
HOLONBRIDGE_URL=http://localhost:3031
FUSEKI_URL=http://localhost:3030
FUSEKI_DATASET=ds
ANTHROPIC_API_KEY=sk-ant-YOUR_KEY_HERE
BEARER_TOKEN=YOUR_GENERATED_TOKEN_HERE
SHACL_REQUIRED=false
```

To generate a bearer token:

```bash
# macOS / Linux
openssl rand -hex 32

# Windows PowerShell
[System.Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

Copy the output and paste it as your `BEARER_TOKEN`. Store this securely —
treat it as a password.

Your Anthropic API key is available at https://console.anthropic.com/settings/keys.

**Step 3 — Start HolonBridge**

```bash
# From the holon-bridge directory
node server.js
```

You should see:

```
HolonBridge v2.4.0 listening on :3031
Fuseki: http://localhost:3030/ds
Dataset: ds
```

**Step 4 — Verify**

```bash
curl http://localhost:3031/health
```

Expected response: `{"status":"ok","dataset":"ds",...}`

---

### Part 3 — Install the MCP Server (holonbridge-mcp)

The MCP server is what allows Claude to call HolonBridge directly as a tool
during a conversation.

**Step 1 — Clone**

```bash
git clone https://github.com/kurtcagle/chloe
cd chloe/holonbridge-mcp
npm install
```

**Step 2 — Configure**

Create `.env` in the `chloe/holonbridge-mcp` directory:

```
HOLONBRIDGE_URL=http://localhost:3031
BEARER_TOKEN=YOUR_SAME_TOKEN_HERE
FUSEKI_URL=http://localhost:3030
FUSEKI_DATASET=ds
ANTHROPIC_API_KEY=sk-ant-YOUR_KEY_HERE
MCP_TRANSPORT=stdio
```

Use the same bearer token as in Part 2.

**Step 3 — Register with Claude Code** (if using Claude Code)

Add the following to your Claude Code MCP configuration file.

On macOS: `~/.claude/claude_desktop_config.json`
On Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "holonbridge": {
      "command": "node",
      "args": ["/full/path/to/chloe/holonbridge-mcp/index.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "HOLONBRIDGE_URL": "http://localhost:3031",
        "BEARER_TOKEN": "YOUR_TOKEN_HERE",
        "FUSEKI_URL": "http://localhost:3030",
        "FUSEKI_DATASET": "ds",
        "ANTHROPIC_API_KEY": "sk-ant-YOUR_KEY_HERE"
      }
    }
  }
}
```

Replace `/full/path/to/chloe` with the actual path where you cloned the
repository.

Restart Claude Code after saving this file. You should see HolonBridge listed
in the available MCP tools.

---

### Part 4 — Set Up the Context DataBook

HolonBridge uses a DataBook file to teach the NL→SPARQL pipeline about your
data's vocabulary. Without this, natural language queries will not produce
useful results.

**Step 1 — Create the context directory**

```bash
# macOS / Linux
mkdir -p context/localhost-3030/ds

# Windows PowerShell
New-Item -ItemType Directory -Path "context\localhost-3030\ds" -Force
```

**Step 2 — Create the context DataBook**

Create a file called `context.databook.md` in the directory above. A minimal
working example for the GGSC supply chain:

```markdown
---
id: urn:context:ds:local
title: DS Dataset Context
type: databook
version: 1.0.0
dataset: ds
---

# DS Dataset Context

## prefix-registry

PREFIX ggce:     <https://w3id.org/un/ggce/>
PREFIX ggcewf:   <https://w3id.org/un/ggce/workflow/>
PREFIX ggcetier: <https://w3id.org/un/ggce/tier/>
PREFIX ggcecap:  <https://w3id.org/un/ggce/capability/>
PREFIX rdfs:     <http://www.w3.org/2000/01/rdf-schema#>
PREFIX dcterms:  <http://purl.org/dc/terms/>
PREFIX xsd:      <http://www.w3.org/2001/XMLSchema#>

## class-index

ggce:Workflow — a geodetic supply chain workflow (EOP, ICRF, ITRF, satellite_orbits, gravity).
ggce:WorkflowTier — a tier within a workflow, scored for risk. Tiers numbered 0-4.
ggce:CapabilityScore — a PPTD maturity score for a specific capability.
ggce:GuidingPrinciple — one of six principles P1-P6.
ggce:RiskClassification — Critical, High, Significant, or Minor.

## property-index

ggce:tierRiskScore — xsd:decimal. Range 0-25. Primary risk metric.
ggce:pptdGap — xsd:decimal. Capability maturity gap.
ggce:criticalityScore — xsd:integer (1-5). Step criticality.
ggce:hasTier — links Workflow to its WorkflowTier instances.
ggce:workflow — links WorkflowTier to parent Workflow.
ggce:tier — xsd:integer (0-4). Tier number.
ggce:relatedPrinciples — links WorkflowTier to violated GuidingPrinciple.
ggce:hasCapabilityScore — links WorkflowTier to CapabilityScore instances.
ggce:weightedAvg — xsd:decimal. Weighted average of PPTD dimensions.
ggce:peopleScore / processScore / technologyScore / dataScore — PPTD dimension scores.

## nl-hints

CRITICAL: Use ggce: namespace (https://w3id.org/un/ggce/) for all supply chain data.
WORKFLOWS: ggcewf:eop, ggcewf:icrf, ggcewf:itrf, ggcewf:satellite_orbits, ggcewf:gravity.
TIERS: IRI pattern ggcetier:{workflow}_t{n}. Use GRAPH ?g wrappers.
RISK SCORES: Highest risk = Satellite Orbits T3 at 15.70. High classification = 11 or above.
```

**Step 3 — Reload**

After placing the context DataBook, trigger a reload:

```bash
curl -s -X POST http://localhost:3031/reload \
  -H "Authorization: Bearer YOUR_TOKEN"
```

Check the `schemaChars` field in the response — it should be greater than zero.
If it is zero, the DataBook was not parsed. Check the file is saved as UTF-8
without a BOM, and that the section headings (`## prefix-registry`, etc.) are
present.

---

### Part 5 — Load the GGSC Data

To load the same supply chain data that is currently in my `/ds` dataset,
push each named graph via the `/update` endpoint. The easiest method is to
use the DataBook files from the `colossalhop/un-ggce-supply-chain` repository.

**Using curl to push a Turtle file:**

```bash
# Replace the graph IRI and file path as needed
curl -s -X POST http://localhost:3031/update \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "turtle": "<paste turtle content here>",
    "graph": "https://w3id.org/un/ggce/databook/eop-workflow-v3"
  }'
```

Alternatively, I can export the full dataset from my Fuseki instance as a
TriG or N-Quads file, which you can import directly into your Fuseki using
the Fuseki web interface at `http://localhost:3030`.

---

### Part 6 — Optional: Expose Publicly via ngrok

If you want to access your HolonBridge from outside your local network —
including from Claude.ai on another machine — you need to expose it via a
tunnel. ngrok is the easiest option.

**Step 1 — Install ngrok**

Download from https://ngrok.com/download. Create a free account.

**Step 2 — Authenticate**

```bash
ngrok config add-authtoken YOUR_NGROK_TOKEN
```

Your token is available at https://dashboard.ngrok.com.

**Step 3 — Start the tunnel**

```bash
ngrok http 3031
```

ngrok will display a public URL like `https://abc123.ngrok-free.app`. Use
this URL anywhere you would use `http://localhost:3031`.

For a stable URL that does not change between restarts, upgrade to an ngrok
paid plan and reserve a custom subdomain:

```bash
ngrok http --url=yourname.ngrok.io 3031
```

---

## Running as a Background Service

On a server or a machine that should run HolonBridge continuously, you will
want it to start automatically and restart if it crashes.

### Windows (NSSM)

NSSM (Non-Sucking Service Manager) manages Node.js processes as Windows services.

```powershell
# Download NSSM from https://nssm.cc/download
# Extract and add to PATH, then:

nssm install HolonBridge "C:\Program Files\nodejs\node.exe"
nssm set HolonBridge AppParameters "C:\path\to\holon-bridge\server.js"
nssm set HolonBridge AppDirectory "C:\path\to\holon-bridge"
nssm set HolonBridge AppEnvironmentExtra "FUSEKI_URL=http://localhost:3030"
nssm set HolonBridge AppEnvironmentExtra "BEARER_TOKEN=YOUR_TOKEN"
nssm set HolonBridge AppEnvironmentExtra "ANTHROPIC_API_KEY=sk-ant-..."
nssm start HolonBridge
```

### macOS (launchd)

Create `/Library/LaunchDaemons/io.holongraph.bridge.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>         <string>io.holongraph.bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/holon-bridge/server.js</string>
  </array>
  <key>WorkingDirectory</key>  <string>/path/to/holon-bridge</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>FUSEKI_URL</key>          <string>http://localhost:3030</string>
    <key>BEARER_TOKEN</key>        <string>YOUR_TOKEN</string>
    <key>ANTHROPIC_API_KEY</key>   <string>sk-ant-...</string>
  </dict>
  <key>RunAtLoad</key>     <true/>
  <key>KeepAlive</key>     <true/>
</dict>
</plist>
```

```bash
sudo launchctl load /Library/LaunchDaemons/io.holongraph.bridge.plist
```

### Linux (systemd)

Create `/etc/systemd/system/holonbridge.service`:

```ini
[Unit]
Description=HolonBridge RDF Gateway
After=network.target

[Service]
Type=simple
User=holonbridge
WorkingDirectory=/opt/holon-bridge
ExecStart=/usr/bin/node /opt/holon-bridge/server.js
Environment=FUSEKI_URL=http://localhost:3030
Environment=BEARER_TOKEN=YOUR_TOKEN
Environment=ANTHROPIC_API_KEY=sk-ant-...
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable holonbridge
sudo systemctl start holonbridge
sudo systemctl status holonbridge
```

---

## Quick Reference

### Service startup order

Always start services in this order:

1. **Fuseki** first (port 3030)
2. **HolonBridge** second (port 3031)
3. **ngrok** last (optional; external access)

### Checking everything is running

```bash
# Fuseki
curl http://localhost:3030/$/ping

# HolonBridge
curl http://localhost:3031/health

# ngrok (check the dashboard or look for the forwarding URL in the terminal)
```

### Key file locations

| File | Purpose |
|---|---|
| `holon-bridge/.env` | HolonBridge environment variables |
| `chloe/holonbridge-mcp/.env` | MCP server environment variables |
| `~/.holonbridge/config.json` | Named endpoint profiles |
| `context/localhost-3030/ds/*.databook.md` | NL pipeline vocabulary context |
| Claude Code MCP config | Registers holonbridge-mcp with Claude Code |

### Common problems

| Symptom | Likely cause | Fix |
|---|---|---|
| `/health` returns connection refused | HolonBridge not running | Start `node server.js` |
| `/health` returns 401 | Bearer token missing or wrong | Check `Authorization: Bearer` header |
| NL query returns generic or wrong results | Context DataBook not loaded | Check `schemaChars > 0` after `/reload` |
| Named graph count is 0 | No data pushed yet | Push data via `/update` |
| Claude Code can't find holonbridge tools | MCP config not saved or path wrong | Check config file path; restart Claude Code |
| ngrok URL changes on restart | Free ngrok plan | Upgrade for stable URL or update clients |

---

## Getting Help

For questions about this setup, contact Kurt Cagle:

- Email: kurt.cagle@gmail.com
- Secondary: kurt@holongraph.com
- Phone: (443) 837-8725

The HolonBridge repositories:

- HolonBridge server: https://github.com/kurtcagle/holon-bridge
- holonbridge-mcp and context files: https://github.com/kurtcagle/chloe

W3C Holon Community Group (the standards context for HGA):
https://www.w3.org/groups/cg/holon/

---

*HolonBridge v2.4.0 · W3C Holon Community Group working implementation*
*Copyright 2026 Kurt Cagle / Semantical LLC*
