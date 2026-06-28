---
name: holonbridge
description: >
  Reference skill for HolonBridge — the Node.js/Express server that bridges the
  Holon Graph Architecture (HGA) pipeline to external clients. Load this skill
  whenever working on HolonBridge setup, configuration, endpoint usage, DataBook
  ingestion via the bridge, SPARQL query patterns against a live Fuseki backend,
  SHACL validation through the bridge, the holonbridge-mcp-remote MCP server, or
  profile management. Also trigger on: "HolonBridge", "holonbridge-mcp-remote",
  "Fuseki bridge", "GSP push", "NL query", "nl_query", "sparql_select",
  "sparql_construct", "push_turtle", "get_holon", "list_graphs",
  "validate_turtle", "holon endpoint", "Bearer token HGA", or "ngrok holon".
---

# HolonBridge Skill

HolonBridge is the **Node.js/Express implementation of the HGA Server** — the
operational bridge between the Holon Graph Architecture pipeline and external
clients. It wraps a Jena 6.0 Fuseki triplestore, exposes a clean REST API
for DataBook ingestion and SPARQL operations, and provides an MCP remote server
(`mcp-remote/holonbridge-mcp-remote.js`) for integration with claude.ai via
HTTP/SSE.

**Current version: v2.9.0**  
**Repository: https://github.com/kurtcagle/holon-bridge**

The key architectural idea: external clients — Claude, browser extensions,
CLI tools — never talk directly to Fuseki. HolonBridge is the single entry
point. It handles authentication, SHACL validation gating, named graph routing,
and the NL→SPARQL translation pathway.

---

## Quick orientation

| Need | Section |
|---|---|
| What HolonBridge actually is | [Architecture](#architecture) |
| Install and run it | [Setup](#setup) |
| Configure named profiles | [Profile configuration](#profile-configuration) |
| Push a DataBook | [Core operations → push_turtle](#push_turtle) |
| Run a SPARQL query | [Core operations → SPARQL tools](#sparql-tools) |
| Validate against shapes | [Core operations → validate_turtle](#validate_turtle) |
| Query in natural language | [Core operations → nl_query](#nl_query) |
| Connect from claude.ai | [Connection modes](#connection-modes) |
| Expose publicly via ngrok | [External access](#external-access) |
| Common workflows | [Workflows](#workflows) |
| Troubleshooting | [Troubleshooting](#troubleshooting) |

---

## Architecture

### The three layers

```
External clients                Two servers                     Backend
(claude.ai, browser, CLI)

  claude.ai (SSE) ─────────── mcp-remote/                 ┌──────────────┐
                               holonbridge-mcp-remote.js   │              │
                               :3032 (ngrok-exposed)  ───  │  HolonBridge │
                                                      │    │  server.js   │
  curl / databook CLI ────────────────────────────────┘    │  :3031       │
                                                           │  (ngrok)     │
                                                           └──────┬───────┘
                                                                  │
                                                           ┌──────▼───────┐
                                                           │  Jena 6.0    │
                                                           │  Fuseki      │
                                                           │  :3030       │
                                                           │  (internal)  │
                                                           └──────────────┘
```

### Port assignments

| Service | Local port | ngrok URL | Notes |
|---|---|---|---|
| Jena 6.0 Fuseki | 3030 | — | Internal only. Never exposed. |
| HolonBridge REST API | 3031 | `kurtcagle.ngrok.io` | Main bridge. DataBook CLI, artifact fetch(). |
| MCP remote SSE | 3032 | `kurtcagle-mcp.ngrok.io` | claude.ai MCP integration endpoint. |

**Critical:** Fuseki at :3030 is internal only. HolonBridge at :3031 is
the public REST face. The MCP remote at :3032 is the claude.ai integration
face. All three must be running for a full session.

### Repository layout

```
holon-bridge/
├── server.js                        # HolonBridge REST API — start this first
├── sparql.js                        # top-level SPARQL helpers
├── package.json                     # v2.9.0; main: server.js
├── .env.mcp-remote.example          # template for mcp-remote env
├── lib/
│   ├── auth.js                      # Bearer token middleware
│   ├── databook.js                  # DataBook parsing/routing
│   ├── format.js                    # response formatting
│   ├── llm.js                       # Anthropic API / NL→SPARQL
│   ├── shacl.js                     # SHACL validation pipeline
│   ├── sparql.js                    # SPARQL query/update routing
│   └── validate.js                  # input validation helpers
├── mcp-remote/
│   ├── holonbridge-mcp-remote.js    # MCP SSE server for claude.ai
│   ├── package.json                 # separate deps: @mcp/sdk, express, cors, zod
│   ├── README-mcp-remote.md         # full MCP remote setup guide
│   └── README.md
├── registry/                        # federated endpoint registry
├── scripts/                         # setup and key generation
├── context/                         # local context files
├── Start-HolonBridge.ps1            # Windows: start all services
├── Install-HolonBridgeService.ps1   # Windows: install as NSSM service
├── start-holonbridge.sh             # Linux: start all services
├── install-holonbridge-service.sh   # Linux: install as systemd service
├── install-holonbridge-launchd.sh   # macOS: install as launchd service
├── start-holon-stack.bat            # Windows: quick dev stack launcher
├── kurtcagle.ngrok.io               # ngrok domain marker (empty)
└── kurtcagle-mcp.ngrok.io           # ngrok domain marker (empty)
```

### What HolonBridge does that Fuseki alone doesn't

1. **Authentication gating** — Bearer token check before any read or write
2. **SHACL validation pipeline** — optionally validates payload against a
   named shapes graph before accepting a push
3. **DataBook-aware routing** — reads DataBook frontmatter to determine named
   graph targets; clients don't need to know graph IRIs
4. **NL→SPARQL translation** — `/nl_query` endpoint accepts natural language,
   returns query results (calls Anthropic API via `lib/llm.js`)
5. **Holon retrieval** — `GET /holon/:id` returns a holon as a DataBook,
   not as raw Turtle; clients work at DataBook level
6. **Profile abstraction** — named profiles let clients switch between local
   Fuseki and remote servers without changing code

### The MCP remote layer

`mcp-remote/holonbridge-mcp-remote.js` is a separate Node.js process that
exposes HolonBridge functionality as MCP tools. It connects to claude.ai
via **HTTP/SSE** on port 3032, exposed publicly via ngrok.

It is **not** a stdio server and has **no** `index.js`. The entry point is
always `node holonbridge-mcp-remote.js` run from the `mcp-remote/` directory.

---

## Setup

### Prerequisites

- Node.js ≥ 18.0.0
- Jena 6.0 Fuseki running locally (or remote Fuseki endpoint)
- An Anthropic API key (required for `nl_query`)
- ngrok account (free tier sufficient for development)

### 1. Install HolonBridge REST server

```bash
git clone https://github.com/kurtcagle/holon-bridge
cd holon-bridge
npm install
```

### 2. Install the MCP remote server

The MCP remote has its own separate package; install it from within the
`mcp-remote/` subdirectory:

```bash
cd holon-bridge/mcp-remote
npm install
```

Dependencies: `@modelcontextprotocol/sdk`, `express`, `cors`, `dotenv`, `zod`.

### 3. Start Fuseki

```bash
# From your Jena installation
fuseki-server --update --mem /ds
# Or with persistent storage:
fuseki-server --update --loc /path/to/data /ds
```

Fuseki defaults to port 3030. Verify at http://localhost:3030.

### 4. Generate tokens

Two tokens are required — they must be different values:

```bash
# Generate HB_BEARER_TOKEN (HolonBridge auth)
openssl rand -hex 32

# Generate MCP_REMOTE_TOKEN (claude.ai → MCP remote auth)
openssl rand -hex 32
```

### 5. Configure HolonBridge REST (.env in repo root)

```bash
FUSEKI_URL=http://localhost:3030
FUSEKI_DATASET=ds
BEARER_TOKEN=<HB_BEARER_TOKEN value>
ANTHROPIC_API_KEY=sk-ant-...
PORT=3031
```

### 6. Configure MCP remote (.env in mcp-remote/)

```bash
cp .env.mcp-remote.example mcp-remote/.env
```

Edit `mcp-remote/.env`:

```bash
# Public HTTPS URL of HolonBridge REST (ngrok, not localhost)
HOLONBRIDGE_URL=https://kurtcagle.ngrok.io

# Bearer token HolonBridge expects — same as BEARER_TOKEN in root .env
HB_BEARER_TOKEN=<same token as above>

# Separate secret for claude.ai to authenticate to this server
MCP_REMOTE_TOKEN=<second generated token>

MCP_PORT=3032
```

Optional named profiles (for federation):

```bash
PROFILE_GGSC_URL=https://ggsc.ngrok.io
PROFILE_GGSC_LABEL=UN GGSC production bridge
```

### 7. Start HolonBridge REST

```bash
# From holon-bridge/
node server.js
# or: npm start
# Listening on :3031
```

### 8. Start MCP remote

```bash
# From holon-bridge/mcp-remote/
node holonbridge-mcp-remote.js
# holonbridge-mcp-remote listening on :3032
```

### 9. Expose via ngrok (two tunnels)

```bash
# Tunnel 1 — HolonBridge REST
ngrok http --url=kurtcagle.ngrok.io 3031

# Tunnel 2 — MCP remote SSE
ngrok http --url=kurtcagle-mcp.ngrok.io 3032
```

Both URLs are reserved ngrok subdomains — they persist across restarts.

### 10. Register with claude.ai

1. Open **claude.ai → Settings → Integrations → Add custom integration**
2. **URL:** `https://kurtcagle-mcp.ngrok.io/sse`
3. **Auth header:** `Authorization: Bearer <MCP_REMOTE_TOKEN>`
4. Save — Claude discovers tools automatically.

### Windows convenience scripts

`Start-HolonBridge.ps1` and `start-holon-stack.bat` start Fuseki, HolonBridge,
and both ngrok tunnels together. For persistent service installation, use
`Install-HolonBridgeService.ps1` (NSSM-based).

---

## Profile configuration

Named profiles let you switch between multiple HolonBridge endpoints from
within a Claude session via `set_endpoint`. Profiles are defined in the
MCP remote server's `.env` file (not a JSON config file).

### Profile tools

```
list_endpoints          List all named profiles and their URLs
get_endpoint            Show the currently active profile
set_endpoint(name)      Switch to a named profile
```

### Session start

Always call `switch_dataset` at the start of a session to set the active
Fuseki dataset. The MCP remote does not persist dataset state across
HolonBridge restarts.

```
switch_dataset("chloe")    # or "storme", "ggsc", "causalspark", etc.
```

---

## Core operations

### SPARQL tools

#### sparql_select

Execute a SPARQL SELECT query. Returns JSON bindings.

```
sparql_select(query, graph?)
```

Always include full PREFIX declarations — HolonBridge does not inject them:

```sparql
PREFIX dct:   <http://purl.org/dc/terms/>
PREFIX chloe: <urn:chloe:ontology#>

SELECT ?id ?title ?status WHERE {
  GRAPH <urn:chloe:memory:publications> {
    ?id a chloe:Publication ;
        dct:title  ?title ;
        chloe:status ?status .
  }
}
ORDER BY ?title
```

Use `graph` to restrict to a specific named graph:
```
sparql_select(query, graph="urn:chloe:memory:publications")
```

#### sparql_construct

Execute a SPARQL CONSTRUCT query. Returns Turtle.

```
sparql_construct(query)
```

Useful for extracting a subgraph or retrieving all triples about an entity:

```sparql
PREFIX dct:   <http://purl.org/dc/terms/>
PREFIX chloe: <urn:chloe:ontology#>

CONSTRUCT { ?s ?p ?o }
WHERE {
  GRAPH <urn:chloe:memory:publications> {
    ?s a chloe:Publication .
    ?s ?p ?o .
  }
}
```

#### sparql_update

Execute a SPARQL UPDATE (INSERT DATA, DELETE DATA, CLEAR, etc.).

```
sparql_update(update)
```

Routes to Fuseki's `/update` endpoint — do not use SELECT syntax here.

**Prefer `sparql_update` INSERT DATA over `push_turtle` for additive
operations on existing named graphs.** `push_turtle` uses GSP PUT which
replaces the entire named graph. `sparql_update` INSERT DATA is always
additive and safe to use on graphs with existing content.

```sparql
PREFIX dct:   <http://purl.org/dc/terms/>
PREFIX chloe: <urn:chloe:ontology#>

INSERT DATA {
  GRAPH <urn:chloe:memory:publications> {
    <urn:chloe:publications:ont:2026-06-28-example>
        a chloe:Publication ;
        dct:title "Example Article" ;
        chloe:status "draft" .
  }
}
```

To update a single property without replacing the record:

```sparql
PREFIX chloe: <urn:chloe:ontology#>
PREFIX schema: <https://schema.org/>

DELETE {
  GRAPH <urn:chloe:memory:publications> {
    <urn:chloe:publications:ont:2026-06-28-example> chloe:status ?old .
  }
}
INSERT {
  GRAPH <urn:chloe:memory:publications> {
    <urn:chloe:publications:ont:2026-06-28-example>
        chloe:status "published" ;
        schema:url <https://ontologist.substack.com/p/example> .
  }
}
WHERE {
  GRAPH <urn:chloe:memory:publications> {
    <urn:chloe:publications:ont:2026-06-28-example> chloe:status ?old .
  }
}
```

---

### push_turtle

Push Turtle content directly into a named graph in Fuseki via GSP PUT.

```
push_turtle(turtle, graph_iri, shapes_graph?)
```

- `turtle` — valid Turtle 1.1 or 1.2 string using `@prefix` declarations
  (not `PREFIX` keyword — Turtle syntax only, no trailing dots on PREFIX)
- `graph_iri` — target named graph IRI
- `shapes_graph` (optional) — IRI of a SHACL shapes graph for pre-push
  validation; push is rejected on SHACL violation

**⚠️ GSP PUT replaces the entire named graph.** If the graph already
contains content you want to keep, use `sparql_update` INSERT DATA instead.
Reserve `push_turtle` for initial population of a named graph or deliberate
full replacement.

```turtle
@prefix ex:    <https://example.org/> .
@prefix xsd:   <http://www.w3.org/2001/XMLSchema#> .

ex:sensor-A1
    a ex:TemperatureSensor ;
    ex:temperature "22.4"^^xsd:decimal ;
    ex:observedAt  "2026-06-13T09:00:00Z"^^xsd:dateTime .
```

```
push_turtle(turtle=<above>, graph_iri="https://example.org/graphs/sensors")
```

---

### get_holon

Retrieve a holon from Fuseki and return it as a DataBook.

```
get_holon(holon_iri, projection_mode?)
```

- `holon_iri` — the IRI of the target holon
- `projection_mode` — `immersive` (default), `cinematic`, `active_inference`,
  `exploded_view`

Returns a DataBook with frontmatter, a `turtle12` block with current holon
state, a `sparql` block with the retrieval query, and optionally a `shacl`
block with boundary shapes.

---

### list_graphs

List all named graphs in the active Fuseki dataset, with triple counts.

```
list_graphs(filter?)
```

- `filter` — optional substring match on graph IRI

```
list_graphs()                  -- all graphs
list_graphs("publications")    -- graphs whose IRI contains "publications"
list_graphs("urn:storme")      -- storme dataset graphs
```

---

### validate_turtle

Validate Turtle content against a SHACL shapes graph already in Fuseki.

```
validate_turtle(turtle, shapes_graph)
```

Returns a SHACL `sh:ValidationReport` in Turtle. Use this before `push_turtle`
for data quality gating:

```
1. validate_turtle(payload, "urn:chloe:shacl")
2. If sh:conforms true  → push_turtle(payload, graph_iri)
3. If sh:conforms false → inspect sh:result nodes; do not push
```

Or use the combined form: `push_turtle(..., shapes_graph=...)`.

---

### nl_query

Submit a natural language question; receive SPARQL results.

```
nl_query(question, graph?)
```

HolonBridge translates via `lib/llm.js` (Anthropic API). Returns the
generated SPARQL, raw results, and a natural-language summary.

```
nl_query("What articles are currently in draft status?")
nl_query("List all characters in the storme dataset", graph="urn:storme:characters")
```

Works best for simple SELECT patterns over well-labelled data. For complex
CONSTRUCT or UPDATE operations, write SPARQL directly.

---

## Connection modes

### claude.ai web client — HTTP/SSE (primary)

claude.ai connects to `holonbridge-mcp-remote.js` over HTTPS/SSE.
All 11 tools are registered as MCP tools and appear in Claude's tool palette.

**Integration URL:** `https://kurtcagle-mcp.ngrok.io/sse`  
**Auth:** `Authorization: Bearer <MCP_REMOTE_TOKEN>`

The MCP remote uses a two-token model:
- `MCP_REMOTE_TOKEN` — authenticates claude.ai to the MCP remote server
- `HB_BEARER_TOKEN` — authenticates the MCP remote server to HolonBridge REST

Neither token is transmitted to the Anthropic API.

### Artifact fetch() — direct REST access

Claude.ai artifacts can call HolonBridge REST directly via `fetch()`,
bypassing the MCP layer:

```javascript
const response = await fetch('https://kurtcagle.ngrok.io/sparql-select', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer <HB_BEARER_TOKEN>',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    sparql: 'SELECT ?s ?p ?o WHERE { GRAPH <urn:scene:current> { ?s ?p ?o } } LIMIT 10'
  })
});
const data = await response.json();
```

Note: the REST endpoint is `POST /sparql-select` with JSON body `{ sparql: "..." }`,
not the SPARQL Protocol `application/sparql-query` content type.

---

## External access

### ngrok tunnels (two required)

```bash
# Terminal 1 — HolonBridge REST (port 3031)
ngrok http --url=kurtcagle.ngrok.io 3031

# Terminal 2 — MCP remote SSE (port 3032)
ngrok http --url=kurtcagle-mcp.ngrok.io 3032
```

Both are reserved ngrok subdomains and persist across restarts. Verify:

```bash
curl https://kurtcagle-mcp.ngrok.io/health \
  -H "Authorization: Bearer <MCP_REMOTE_TOKEN>"
# Expected: {"status":"ok","server":"holonbridge-mcp-remote","version":"1.0.0",...}
```

---

## Workflows

### Workflow 1 — Session start

```
1. switch_dataset("chloe")        # or whichever dataset is needed
2. list_graphs()                  # orient to available data
3. Proceed with queries or updates
```

### Workflow 2 — Add data to existing graph (safe)

```
1. list_graphs("target-graph")    # confirm graph exists and triple count
2. sparql_update(INSERT DATA { GRAPH <iri> { ... } })
3. list_graphs("target-graph")    # confirm count increased
```

### Workflow 3 — Initial population of a new named graph

```
1. validate_turtle(payload, shapes_graph)   # optional pre-check
2. push_turtle(payload, graph_iri)          # safe on empty/new graph
3. list_graphs()                            # confirm
```

### Workflow 4 — Update a single field on an existing record

```sparql
DELETE { GRAPH <g> { ?s :field ?old } }
INSERT { GRAPH <g> { ?s :field "newValue" } }
WHERE  { GRAPH <g> { ?s :field ?old } }
```

Use `sparql_update` — never `push_turtle` for targeted updates.

### Workflow 5 — Cross-server query (federation)

```
set_endpoint("ggsc")
sparql_select("SELECT * WHERE { GRAPH ?g { ?s a ex:Observatory } }")

set_endpoint("default")
sparql_select("SELECT * WHERE { GRAPH ?g { ?s a ex:Observatory } }")
```

### Workflow 6 — Validate before commit

```
1. validate_turtle(candidate_payload, "urn:chloe:shacl")
2. Inspect sh:ValidationReport
3. Surface violations; iterate until sh:conforms true
4. push_turtle(payload, graph_iri)   # or sparql_update INSERT DATA
```

---

## Authentication reference

### Bearer token flow

All requests to HolonBridge REST require:

```
Authorization: Bearer <HB_BEARER_TOKEN>
```

Checked by `lib/auth.js`. On failure: HTTP 401. On success: request
forwarded to Fuseki (internal, unauthenticated).

### Token storage by context

| Context | Token | Location |
|---|---|---|
| claude.ai integration | `MCP_REMOTE_TOKEN` | Settings → Integrations → auth header |
| MCP remote server | `HB_BEARER_TOKEN` | `mcp-remote/.env` |
| curl / scripts | `HB_BEARER_TOKEN` | shell env `HOLONBRIDGE_BEARER` |
| Artifact fetch() | `HB_BEARER_TOKEN` | hardcoded in artifact (dev only) |
| DataBook CLI | `HB_BEARER_TOKEN` | `processors.toml` auth field |

### Rotating tokens

1. Generate new token(s): `openssl rand -hex 32`
2. Update root `.env` (`BEARER_TOKEN`) and/or `mcp-remote/.env`
3. Update claude.ai integration auth header if rotating `MCP_REMOTE_TOKEN`
4. Restart affected servers — no Fuseki restart required

---

## Troubleshooting

### Connection refused on :3031

HolonBridge REST is not running. Start it: `node server.js` from `holon-bridge/`.

### Connection refused on :3032

MCP remote is not running. Start it: `node holonbridge-mcp-remote.js`
from `holon-bridge/mcp-remote/`.

### Connection refused on :3030

Fuseki is not running. Start it: `fuseki-server --update --mem /ds`.

### 401 on /sse (claude.ai)

`MCP_REMOTE_TOKEN` in `mcp-remote/.env` does not match the token in the
claude.ai integration auth header.

### 401 on HolonBridge calls

`HB_BEARER_TOKEN` in `mcp-remote/.env` does not match `BEARER_TOKEN` in
root `.env`. Check for trailing whitespace in both.

### OPTIONS returns 401

CORS preflight is hitting the auth middleware. In `holonbridge-mcp-remote.js`,
`app.options('*', cors())` must appear before `app.use(authMiddleware)`.

### push_turtle silently overwrites data

Expected behaviour — GSP PUT replaces the named graph. Use `sparql_update`
INSERT DATA for additive operations on existing graphs.

### sparql_update returns 400

Common causes:
- Missing `PREFIX` declarations (required in every UPDATE statement)
- Using SELECT syntax in an UPDATE call
- Malformed IRI

### nl_query returns generic results

Works best when data has `rdfs:label` annotations and entity names in the
question match labels in the data. Prime with context:
`nl_query("In the publications graph, what articles are in draft?")`

### POST /message returns 404 No active session

SSE connection dropped (ngrok free tier idles after 30s of inactivity).
Reconnect from claude.ai, or upgrade ngrok for persistent tunnels.

### HolonBridge calls fail with ECONNREFUSED from MCP remote

`HOLONBRIDGE_URL` in `mcp-remote/.env` is pointing at `localhost`. The
MCP remote server cannot reach HolonBridge's local port. Set it to the
public ngrok URL: `https://kurtcagle.ngrok.io`.

---

## Relationship to other skills and specs

| Skill / Spec | Relationship |
|---|---|
| **sce** | Parent architecture. HolonBridge implements the HGA Server component. |
| **databook** | DataBook format is HolonBridge's primary data unit. `databook push` and `databook pull` are the CLI equivalents of `push_turtle` and `get_holon`. |
| `mcp-remote/README-mcp-remote.md` | Full MCP remote setup and troubleshooting guide in the repo. |
| HGA spec (w3c-cg/holon) | Reference architecture at `https://github.com/w3c-cg/holon`. |

---

## Version history

| Version | Key changes |
|---|---|
| v2.9.0 | Current. MCP remote SSE on :3032. Two-token model. Federated registry. |
| v2.0.0 | HolonBridge REST API, Jena 6.0 integration, ngrok exposure |
