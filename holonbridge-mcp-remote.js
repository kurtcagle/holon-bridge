/**
 * holonbridge-mcp-remote.js
 *
 * Remote (HTTP/SSE) transport wrapper for holonbridge-mcp.
 * Exposes MCP tools over the MCP remote protocol so that the
 * Claude web client (claude.ai) can connect to them as a custom connector.
 *
 * Architecture
 * ────────────
 *   claude.ai  ──HTTPS/SSE──►  holonbridge-mcp-remote (:3032, ngrok)
 *                                       │
 *                                  HTTP REST + Bearer
 *                                       │
 *                              HolonBridge REST (:3031)
 *                                       │
 *                                  Fuseki (:3030)
 *
 * Setup
 * ─────
 *   npm install @modelcontextprotocol/sdk express cors
 *
 * Environment (.env in the same directory as this file):
 *   HOLONBRIDGE_URL=http://localhost:3031
 *   HB_BEARER_TOKEN=<token for outbound HolonBridge REST calls>
 *   MCP_REMOTE_TOKEN=<token Claude sends as Bearer on /sse — must match the
 *                     credential entered in the Claude integration settings AND
 *                     the client_secret Claude sends to POST /token during the
 *                     OAuth flow; set all three to the same value for now>
 *   MCP_PORT=3032
 *   MCP_PUBLIC_URL=https://kurtcagle-mcp.ngrok.io  # your public ngrok/tunnel URL
 *   FUSEKI_GSP=http://localhost:3030/ds/data        # for push_turtle (direct GSP)
 *
 * Token relationship (TODO: split properly when per-user scoping is added):
 *   HB_BEARER_TOKEN      — protects HolonBridge from the MCP remote
 *   MCP_REMOTE_TOKEN     — protects the MCP remote from external clients
 *   OAuth client_secret  — Claude sends this during /token exchange; must equal
 *                          MCP_REMOTE_TOKEN for the Bearer check on /sse to pass
 *
 * Changelog
 * ─────────
 *   2026-06-26 v1.2  Fix POST /message 400: remove express.json() middleware;
 *                    pass req.body explicitly to handlePostMessage.
 *   2026-06-26 v1.1  Fix "Already connected" crash: create McpServer per
 *                    SSE connection instead of sharing one instance.
 *   2026-06-26 v1.2  Align all HolonBridge helper functions to v2.9.0 routes:
 *                    /sparql-select, /sparql-construct, /sparql-update,
 *                    GET /graphs, POST /query (NL). push_turtle uses direct
 *                    Fuseki GSP (HolonBridge v2.9.0 has no write route).
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';

// ── Configuration ─────────────────────────────────────────────────────────────

const {
  HOLONBRIDGE_URL = 'http://localhost:3031',
  HB_BEARER_TOKEN,
  MCP_REMOTE_TOKEN,
  MCP_PORT = '3032',
  FUSEKI_GSP = 'http://localhost:3030/ds/data',  // direct Fuseki GSP for push_turtle
} = process.env;

if (!HB_BEARER_TOKEN)  throw new Error('HB_BEARER_TOKEN is required in .env');
if (!MCP_REMOTE_TOKEN) throw new Error('MCP_REMOTE_TOKEN is required in .env');

// ── HolonBridge HTTP helpers (aligned to v2.9.0 routes) ──────────────────────

const hbHeaders = (extra = {}) => ({
  Authorization: `Bearer ${HB_BEARER_TOKEN}`,
  ...extra,
});

/**
 * SPARQL SELECT or ASK via POST /sparql-select  { sparql: "..." }
 * Returns HolonBridge's { vars, bindings, formattedResults, count } shape.
 *
 * SPARQL CONSTRUCT or DESCRIBE via POST /sparql-construct  { query: "..." }
 * Returns Turtle text.
 */
async function hbQuery(sparql, type = 'select') {
  if (type === 'construct') {
    const res = await fetch(`${HOLONBRIDGE_URL}/sparql-construct`, {
      method: 'POST',
      headers: hbHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ query: sparql }),
    });
    if (!res.ok) {
      const msg = await res.text();
      throw new Error(`HolonBridge /sparql-construct: HTTP ${res.status} — ${msg.slice(0, 200)}`);
    }
    return res.text();
  } else {
    const res = await fetch(`${HOLONBRIDGE_URL}/sparql-select`, {
      method: 'POST',
      headers: hbHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
      body: JSON.stringify({ sparql }),
    });
    if (!res.ok) {
      const msg = await res.text();
      throw new Error(`HolonBridge /sparql-select: HTTP ${res.status} — ${msg.slice(0, 200)}`);
    }
    return res.json();
  }
}

/**
 * SPARQL UPDATE via POST /sparql-update  { update: "..." }
 * Returns { updated: true, status: 200 }.
 */
async function hbUpdate(sparql) {
  const res = await fetch(`${HOLONBRIDGE_URL}/sparql-update`, {
    method: 'POST',
    headers: hbHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ update: sparql }),
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(`HolonBridge /sparql-update: HTTP ${res.status} — ${msg.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Push Turtle to a named graph via direct Fuseki GSP (PUT).
 *
 * HolonBridge v2.9.0 has no write route — GET /graph is read-only and there
 * is no PUT /graph.  The direct Fuseki GSP endpoint is used instead.
 * Set FUSEKI_GSP in .env (default: http://localhost:3030/ds/data).
 *
 * The optional shapes_graph argument triggers a validate-before-push call
 * via HolonBridge's POST /validate route.
 */
async function hbPushTurtle(turtle, graphIri, shapesGraph) {
  // Optional pre-push SHACL validation
  if (shapesGraph) {
    await hbValidate(turtle, shapesGraph);  // throws on violation
  }

  const url = `${FUSEKI_GSP}?graph=${encodeURIComponent(graphIri)}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/turtle' },
    body: turtle,
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(`Fuseki GSP PUT: HTTP ${res.status} — ${msg.slice(0, 200)}`);
  }
  return `Pushed to <${graphIri}> via Fuseki GSP — HTTP ${res.status}`;
}

/**
 * Get a holon as a DataBook via GET /holon/:iri.
 * (Route unchanged from previous version — verify if your build has it.)
 */
async function hbGetHolon(holonIri, projectionMode = 'immersive') {
  const url = new URL(`${HOLONBRIDGE_URL}/holon/${encodeURIComponent(holonIri)}`);
  url.searchParams.set('projection', projectionMode);
  const res = await fetch(url.toString(), {
    headers: hbHeaders({ Accept: 'text/markdown' }),
  });
  if (!res.ok) throw new Error(`HolonBridge /holon: HTTP ${res.status}`);
  return res.text();
}

/**
 * Validate Turtle via POST /validate?shapes=<shapesGraph> with raw Turtle body.
 * Returns sh:ValidationReport as Turtle.
 */
async function hbValidate(turtle, shapesGraph) {
  const url = new URL(`${HOLONBRIDGE_URL}/validate`);
  url.searchParams.set('shapes', shapesGraph);
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: hbHeaders({ 'Content-Type': 'text/turtle' }),
    body: turtle,
  });
  if (!res.ok) throw new Error(`HolonBridge /validate: HTTP ${res.status}`);
  return res.text();
}

/**
 * Natural language query via POST /query  { nl: "...", graph?: "..." }
 * HolonBridge translates to SPARQL and returns { answer, sparql, bindings, ... }.
 */
async function hbNlQuery(question, graph) {
  const body = { nl: question };
  if (graph) body.graph = graph;
  const res = await fetch(`${HOLONBRIDGE_URL}/query`, {
    method: 'POST',
    headers: hbHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(`HolonBridge /query: HTTP ${res.status} — ${msg.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * List named graphs via GET /graphs.
 * Returns { dataset, graphs: [{iri, triples}], total }.
 */
async function hbListGraphs(filter) {
  const res = await fetch(`${HOLONBRIDGE_URL}/graphs`, {
    headers: hbHeaders({ Accept: 'application/json' }),
  });
  if (!res.ok) throw new Error(`HolonBridge /graphs: HTTP ${res.status}`);
  const { graphs } = await res.json();
  return graphs
    .map(g => ({ iri: g.iri, triples: String(g.triples) }))
    .filter(g => !filter || g.iri.includes(filter));
}

// ── Profile state ─────────────────────────────────────────────────────────────

const profiles = {
  default: { url: HOLONBRIDGE_URL, label: 'default (from .env)' },
};
Object.keys(process.env)
  .filter(k => k.startsWith('PROFILE_') && k.endsWith('_URL'))
  .forEach(k => {
    const name = k.replace(/^PROFILE_/, '').replace(/_URL$/, '').toLowerCase();
    profiles[name] = {
      url: process.env[k],
      label: process.env[`PROFILE_${name.toUpperCase()}_LABEL`] || name,
    };
  });

let activeProfile = 'default';

// ── MCP server factory ────────────────────────────────────────────────────────
//
// A fresh McpServer is created per /sse connection to avoid the SDK's
// single-transport restriction ("Already connected to a transport").

function createMcpServer() {
  const srv = new McpServer({
    name: 'holonbridge-mcp-remote',
    version: '1.7.1',
  });

  // ── Endpoint management ─────────────────────────────────────────────────────

  srv.tool('list_endpoints', 'List all named HolonBridge profiles.', {}, async () => {
    const lines = Object.entries(profiles).map(
      ([name, p]) => `${name === activeProfile ? '* ' : '  '}${name}: ${p.url} (${p.label})`
    );
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });

  srv.tool('get_endpoint', 'Show the currently active HolonBridge profile.', {}, async () => {
    const p = profiles[activeProfile];
    return { content: [{ type: 'text', text: `Active profile: ${activeProfile} → ${p.url}` }] };
  });

  srv.tool(
    'set_endpoint',
    'Switch the active HolonBridge profile by name.',
    { name: z.string().describe('Profile name from list_endpoints') },
    async ({ name }) => {
      if (!profiles[name]) {
        return { content: [{ type: 'text', text: `Unknown profile "${name}". Available: ${Object.keys(profiles).join(', ')}` }] };
      }
      activeProfile = name;
      return { content: [{ type: 'text', text: `Switched to profile "${name}" → ${profiles[name].url}` }] };
    }
  );

  // ── SPARQL tools ─────────────────────────────────────────────────────────────

  srv.tool(
    'sparql_select',
    'Execute a SPARQL SELECT or ASK query. Returns JSON bindings.',
    {
      query: z.string().describe('SPARQL SELECT or ASK query string'),
      graph: z.string().optional().describe('Restrict to this named graph IRI'),
    },
    async ({ query, graph }) => {
      const q = graph
        ? `SELECT * WHERE { GRAPH <${graph}> { ${query.replace(/^SELECT.*?WHERE\s*\{/is, '')}` // naive wrap
        : query;
      const results = await hbQuery(q, 'select');
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );

  srv.tool(
    'sparql_construct',
    'Execute a SPARQL CONSTRUCT or DESCRIBE query. Returns Turtle.',
    {
      query: z.string().describe('SPARQL CONSTRUCT or DESCRIBE query string'),
    },
    async ({ query }) => {
      const turtle = await hbQuery(query, 'construct');
      return { content: [{ type: 'text', text: turtle }] };
    }
  );

  srv.tool(
    'sparql_update',
    'Execute a SPARQL UPDATE (INSERT DATA, DELETE DATA, CLEAR, etc.).',
    { update: z.string().describe('SPARQL UPDATE statement') },
    async ({ update }) => {
      const result = await hbUpdate(update);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  // ── Graph management ──────────────────────────────────────────────────────────

  srv.tool(
    'push_turtle',
    'Push Turtle content into a named graph in Fuseki (direct GSP PUT). ' +
    'Optionally validates against a SHACL shapes graph before pushing.',
    {
      turtle:       z.string().describe('Valid Turtle 1.1/1.2 payload'),
      graph_iri:    z.string().describe('Target named graph IRI'),
      shapes_graph: z.string().optional().describe('SHACL shapes graph IRI for pre-push validation'),
    },
    async ({ turtle, graph_iri, shapes_graph }) => {
      const result = await hbPushTurtle(turtle, graph_iri, shapes_graph);
      return { content: [{ type: 'text', text: result }] };
    }
  );

  srv.tool(
    'get_holon',
    'Retrieve a holon from Fuseki and return it as a DataBook.',
    {
      holon_iri:       z.string().describe('IRI of the target holon'),
      projection_mode: z.enum(['immersive', 'cinematic', 'active_inference', 'exploded_view'])
                        .optional()
                        .describe('Projection mode (default: immersive)'),
    },
    async ({ holon_iri, projection_mode }) => {
      const databook = await hbGetHolon(holon_iri, projection_mode);
      return { content: [{ type: 'text', text: databook }] };
    }
  );

  srv.tool(
    'list_graphs',
    'List all named graphs in the Fuseki dataset with triple counts.',
    { filter: z.string().optional().describe('Substring filter on graph IRI') },
    async ({ filter }) => {
      const graphs = await hbListGraphs(filter);
      const lines = graphs.map(g => `<${g.iri}>  (${g.triples} triples)`);
      return {
        content: [{
          type: 'text',
          text: lines.length ? lines.join('\n') : 'No graphs found.',
        }],
      };
    }
  );

  // ── SHACL validation ──────────────────────────────────────────────────────────

  srv.tool(
    'validate_turtle',
    'Validate a Turtle payload against a SHACL shapes graph.',
    {
      turtle:       z.string().describe('Turtle payload to validate'),
      shapes_graph: z.string().describe('IRI of the SHACL shapes graph in Fuseki'),
    },
    async ({ turtle, shapes_graph }) => {
      const report = await hbValidate(turtle, shapes_graph);
      return { content: [{ type: 'text', text: report }] };
    }
  );

  // ── Natural language query ────────────────────────────────────────────────────

  srv.tool(
    'nl_query',
    'Query the triplestore using natural language. HolonBridge translates to SPARQL.',
    {
      question: z.string().describe('Natural language question about the graph data'),
      graph:    z.string().optional().describe('Restrict to this named graph IRI'),
    },
    async ({ question, graph }) => {
      const result = await hbNlQuery(question, graph);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── Dataset management ───────────────────────────────────────────────────────

  srv.tool(
    'list_datasets',
    'List all Fuseki datasets available on this HolonBridge instance (GET /datasets).',
    {},
    async () => {
      const res = await fetch(`${HOLONBRIDGE_URL}/datasets`, {
        headers: hbHeaders({ Accept: 'application/json' }),
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(`HolonBridge /datasets: HTTP ${res.status} — ${msg.slice(0, 200)}`);
      }
      const result = await res.json();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  srv.tool(
    'switch_dataset',
    'Switch the active Fuseki dataset on HolonBridge (POST /dataset). ' +
    'Session-scoped; does not persist across HolonBridge restarts.',
    { dataset: z.string().describe('Fuseki dataset name (e.g. "chloe", "ds", "storme")') },
    async ({ dataset }) => {
      const res = await fetch(`${HOLONBRIDGE_URL}/dataset`, {
        method: 'POST',
        headers: hbHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ dataset }),
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(`HolonBridge /dataset: HTTP ${res.status} — ${msg.slice(0, 200)}`);
      }
      const result = await res.json();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  return srv;
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();

app.use(cors({
  origin: ['https://claude.ai', 'https://api.claude.ai'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'Accept'],
  credentials: false,
}));
app.options('*', cors());

// express.json() intentionally omitted — /message uses the raw request stream
// via SSEServerTransport.handlePostMessage; parsing the body here would consume
// the stream before the transport can read it, causing 400 errors.

// ── Minimal OAuth 2.0 + PKCE implementation ──────────────────────────────────
//
// Claude's MCP client (2025+) implements the MCP Authorization spec using
// authorization_code + PKCE flow, with dynamic client registration.
// This is NOT real OAuth — it's a static token dispenser that speaks OAuth's
// vocabulary.  MCP_REMOTE_TOKEN is the issued access_token.

const MCP_PUBLIC_URL = process.env.MCP_PUBLIC_URL || 'https://kurtcagle-mcp.ngrok.io';

const authCodes = new Map();         // code → { redirect_uri, state, client_id }
const registeredClients = new Map(); // client_id → client metadata

app.get('/.well-known/oauth-protected-resource', (req, res) => {
  console.log('[OAuth] GET /.well-known/oauth-protected-resource');
  res.json({
    resource:                 MCP_PUBLIC_URL,
    authorization_servers:    [MCP_PUBLIC_URL],
    bearer_methods_supported: ['header'],
  });
});

app.get('/.well-known/oauth-protected-resource/sse', (req, res) => {
  console.log('[OAuth] GET /.well-known/oauth-protected-resource/sse');
  res.json({
    resource:                 MCP_PUBLIC_URL,
    authorization_servers:    [MCP_PUBLIC_URL],
    bearer_methods_supported: ['header'],
  });
});

app.get('/.well-known/oauth-authorization-server', (req, res) => {
  console.log('[OAuth] GET /.well-known/oauth-authorization-server');
  res.json({
    issuer:                                MCP_PUBLIC_URL,
    authorization_endpoint:                `${MCP_PUBLIC_URL}/authorize`,
    token_endpoint:                        `${MCP_PUBLIC_URL}/token`,
    registration_endpoint:                 `${MCP_PUBLIC_URL}/register`,
    grant_types_supported:                 ['authorization_code', 'client_credentials'],
    response_types_supported:              ['code'],
    code_challenge_methods_supported:      ['S256', 'plain'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
  });
});

// Dynamic client registration (RFC 7591)
app.post('/register', express.json(), (req, res) => {
  console.log('[OAuth] POST /register body:', JSON.stringify(req.body));
  const client_id     = randomUUID();
  const client_secret = randomUUID();
  registeredClients.set(client_id, { ...(req.body ?? {}), client_id, client_secret });
  console.log(`[OAuth] Registered client_id=${client_id}`);
  res.status(201).json({
    client_id,
    client_secret,
    client_id_issued_at:      Math.floor(Date.now() / 1000),
    client_secret_expires_at: 0,
    ...(req.body ?? {}),
  });
});

// Authorization endpoint — issues a one-time code and redirects back.
app.get('/authorize', (req, res) => {
  console.log('[OAuth] GET /authorize query:', JSON.stringify(req.query));
  const { redirect_uri, state, client_id } = req.query;
  if (!redirect_uri) {
    return res.status(400).json({ error: 'redirect_uri is required' });
  }
  const code = randomUUID();
  authCodes.set(code, { redirect_uri, state, client_id });
  setTimeout(() => authCodes.delete(code), 5 * 60 * 1000);

  const url = new URL(redirect_uri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  console.log(`[OAuth] Redirecting with code to ${redirect_uri}`);
  return res.redirect(url.toString());
});

// Token endpoint — exchanges code for MCP_REMOTE_TOKEN.
app.post('/token', express.urlencoded({ extended: false }), express.json(), (req, res) => {
  console.log('[OAuth] POST /token body:', JSON.stringify(req.body));
  const { grant_type, code } = req.body ?? {};

  if (grant_type === 'authorization_code') {
    if (!code || !authCodes.has(code)) {
      console.log('[OAuth] /token invalid_grant, code:', code);
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Unknown or expired code.' });
    }
    authCodes.delete(code);
    console.log('[OAuth] /token issued access_token (authorization_code)');
    return res.json({ access_token: MCP_REMOTE_TOKEN, token_type: 'Bearer', expires_in: 86400 });
  }

  if (grant_type === 'client_credentials') {
    console.log('[OAuth] /token issued access_token (client_credentials)');
    return res.json({ access_token: MCP_REMOTE_TOKEN, token_type: 'Bearer', expires_in: 86400 });
  }

  console.log('[OAuth] /token unsupported_grant_type:', grant_type);
  return res.status(400).json({ error: 'unsupported_grant_type' });
});

app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ── Bearer auth middleware (applied to all remaining routes) ──────────────────

app.use((req, res, next) => {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ') || auth.slice(7) !== MCP_REMOTE_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized — bad or missing MCP_REMOTE_TOKEN' });
  }
  next();
});

// sessionId → { server: McpServer, transport: SSEServerTransport }
const sessions = new Map();

app.get('/sse', async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');

  const transport = new SSEServerTransport('/message', res);
  const srv = createMcpServer();

  sessions.set(transport.sessionId, { server: srv, transport });

  res.on('close', () => {
    sessions.delete(transport.sessionId);
    srv.close().catch(() => {});
  });

  await srv.connect(transport);
});

app.post('/message', async (req, res) => {
  const sessionId = req.query.sessionId;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: `No active session: ${sessionId}` });
  }

  await session.transport.handlePostMessage(req, res, req.body);
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    server: 'holonbridge-mcp-remote',
    version: '1.7.1',
    holonbridge: HOLONBRIDGE_URL,
    fusekiGsp: FUSEKI_GSP,
    profiles: Object.keys(profiles),
    activeProfile,
    activeSessions: sessions.size,
  });
});

app.listen(parseInt(MCP_PORT), () => {
  console.log(`holonbridge-mcp-remote v1.7.1 listening on :${MCP_PORT}`);
  console.log(`  HolonBridge target : ${HOLONBRIDGE_URL}`);
  console.log(`  Fuseki GSP         : ${FUSEKI_GSP}`);
  console.log(`  Profiles           : ${Object.keys(profiles).join(', ')}`);
  console.log(`  SSE endpoint       : http://localhost:${MCP_PORT}/sse`);
  console.log(`  Health             : http://localhost:${MCP_PORT}/health`);
});
