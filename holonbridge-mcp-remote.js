/**
 * holonbridge-mcp-remote.js
 *
 * Remote (HTTP/SSE) transport wrapper for holonbridge-mcp.
 * Exposes the same 11 MCP tools over the MCP remote protocol so that the
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
 *   HOLONBRIDGE_URL=https://kurtcagle.ngrok.io   # or Ben's ngrok URL
 *   HB_BEARER_TOKEN=<HolonBridge bearer token>   # token for HolonBridge
 *   MCP_REMOTE_TOKEN=<separate secret>           # token for THIS server
 *   MCP_PORT=3032
 *
 * Start:
 *   node holonbridge-mcp-remote.js
 *
 * Then expose via ngrok:
 *   ngrok http --url=ben-ggsc.ngrok.io 3032
 *
 * Add to claude.ai:
 *   Settings → Integrations → Add custom integration
 *   URL: https://ben-ggsc.ngrok.io/sse
 *   Auth header: Authorization: Bearer <MCP_REMOTE_TOKEN>
 *
 * v1.0.1 — fix: create a fresh McpServer per SSE connection.
 *   The MCP SDK enforces one-transport-per-Protocol-instance. Reusing a
 *   single server across connections caused a fatal crash on reconnect:
 *     Error: Already connected to a transport. Call close() before
 *     connecting to a new transport, or use a separate Protocol instance
 *     per connection.
 *   Fix: registerTools() factory called inside the /sse handler so each
 *   client session gets its own McpServer. Profile/endpoint state remains
 *   module-level and is shared correctly across sessions.
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';

// ── Configuration ─────────────────────────────────────────────────────────────

const {
  HOLONBRIDGE_URL = 'http://localhost:3031',
  HB_BEARER_TOKEN,         // token for HolonBridge REST calls
  MCP_REMOTE_TOKEN,        // token clients must send to reach THIS server
  MCP_PORT = '3032',
} = process.env;

if (!HB_BEARER_TOKEN)  throw new Error('HB_BEARER_TOKEN is required in .env');
if (!MCP_REMOTE_TOKEN) throw new Error('MCP_REMOTE_TOKEN is required in .env');

// ── HolonBridge HTTP helpers ──────────────────────────────────────────────────

/** Build auth headers for every HolonBridge request. */
const hbHeaders = (extra = {}) => ({
  Authorization: `Bearer ${HB_BEARER_TOKEN}`,
  ...extra,
});

/** POST application/sparql-query to HolonBridge. */
async function hbQuery(sparql, type = 'select') {
  const endpoint = type === 'construct' ? '/sparql/construct' : '/sparql/query';
  const res = await fetch(`${HOLONBRIDGE_URL}${endpoint}`, {
    method: 'POST',
    headers: hbHeaders({
      'Content-Type': 'application/sparql-query',
      Accept: type === 'construct'
        ? 'text/turtle'
        : 'application/sparql-results+json',
    }),
    body: sparql,
  });
  if (!res.ok) throw new Error(`HolonBridge ${endpoint}: HTTP ${res.status}`);
  return type === 'construct' ? res.text() : res.json();
}

/** POST application/sparql-update to HolonBridge. */
async function hbUpdate(sparql) {
  const res = await fetch(`${HOLONBRIDGE_URL}/sparql/update`, {
    method: 'POST',
    headers: hbHeaders({ 'Content-Type': 'application/sparql-update' }),
    body: sparql,
  });
  if (!res.ok) throw new Error(`HolonBridge /sparql/update: HTTP ${res.status}`);
  return res.text();
}

/** PUT text/turtle to a named graph (GSP). */
async function hbPushTurtle(turtle, graphIri, shapesGraph) {
  const url = new URL(`${HOLONBRIDGE_URL}/graph`);
  url.searchParams.set('graph', graphIri);
  if (shapesGraph) url.searchParams.set('shapes', shapesGraph);

  const res = await fetch(url.toString(), {
    method: 'PUT',
    headers: hbHeaders({ 'Content-Type': 'text/turtle' }),
    body: turtle,
  });
  if (!res.ok) throw new Error(`HolonBridge /graph PUT: HTTP ${res.status} — ${await res.text()}`);
  return `Pushed to <${graphIri}> — HTTP ${res.status}`;
}

/** GET a holon as a DataBook from HolonBridge. */
async function hbGetHolon(holonIri, projectionMode = 'immersive') {
  const url = new URL(`${HOLONBRIDGE_URL}/holon/${encodeURIComponent(holonIri)}`);
  url.searchParams.set('projection', projectionMode);
  const res = await fetch(url.toString(), {
    headers: hbHeaders({ Accept: 'text/markdown' }),
  });
  if (!res.ok) throw new Error(`HolonBridge /holon: HTTP ${res.status}`);
  return res.text();
}

/** POST Turtle to HolonBridge SHACL validation endpoint. */
async function hbValidate(turtle, shapesGraph) {
  const url = new URL(`${HOLONBRIDGE_URL}/validate`);
  url.searchParams.set('shapes', shapesGraph);
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: hbHeaders({ 'Content-Type': 'text/turtle' }),
    body: turtle,
  });
  if (!res.ok) throw new Error(`HolonBridge /validate: HTTP ${res.status}`);
  return res.text();   // sh:ValidationReport as Turtle
}

/** GET /nl_query from HolonBridge. */
async function hbNlQuery(question, graph) {
  const url = new URL(`${HOLONBRIDGE_URL}/nl_query`);
  url.searchParams.set('q', question);
  if (graph) url.searchParams.set('graph', graph);
  const res = await fetch(url.toString(), {
    headers: hbHeaders({ Accept: 'application/json' }),
  });
  if (!res.ok) throw new Error(`HolonBridge /nl_query: HTTP ${res.status}`);
  return res.json();
}

/** Shared list_graphs SPARQL. */
async function hbListGraphs(filter) {
  const results = await hbQuery(`
    SELECT ?g (COUNT(*) AS ?triples) WHERE {
      GRAPH ?g { ?s ?p ?o }
    } GROUP BY ?g ORDER BY ?g
  `);
  const graphs = results.results.bindings
    .map(b => ({ iri: b.g.value, triples: b.triples.value }))
    .filter(g => !filter || g.iri.includes(filter));
  return graphs;
}

// ── Profile state (module-level; shared across all sessions) ──────────────────

const profiles = {
  default: { url: HOLONBRIDGE_URL, label: 'default (from .env)' },
};
// Pre-load additional named profiles from env if present:
// PROFILE_GGSC_URL, PROFILE_GGSC_LABEL, etc.
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
// Called once per /sse connection. Each SSE client gets its own McpServer
// instance — the MCP SDK Protocol base class does not allow a single instance
// to be connected to more than one transport simultaneously.
//
// Tool handlers close over module-level state (profiles, activeProfile,
// hbQuery, etc.) so session isolation has no effect on shared functionality.

function createMcpServer() {
  const server = new McpServer({
    name: 'holonbridge-mcp-remote',
    version: '1.0.1',
  });

  // ── P1: Endpoint management ─────────────────────────────────────────────────

  server.tool('list_endpoints', 'List all named HolonBridge profiles.', {}, async () => {
    const lines = Object.entries(profiles).map(
      ([name, p]) => `${name === activeProfile ? '* ' : '  '}${name}: ${p.url} (${p.label})`
    );
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });

  server.tool('get_endpoint', 'Show the currently active HolonBridge profile.', {}, async () => {
    const p = profiles[activeProfile];
    return {
      content: [{ type: 'text', text: `Active profile: ${activeProfile} → ${p.url}` }],
    };
  });

  server.tool(
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

  // ── P1: SPARQL tools ────────────────────────────────────────────────────────

  server.tool(
    'sparql_select',
    'Execute a SPARQL SELECT query. Returns JSON bindings.',
    {
      query: z.string().describe('SPARQL SELECT query string'),
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

  server.tool(
    'sparql_construct',
    'Execute a SPARQL CONSTRUCT query. Returns Turtle.',
    {
      query: z.string().describe('SPARQL CONSTRUCT query string'),
      graph: z.string().optional().describe('Restrict to this named graph IRI'),
    },
    async ({ query }) => {
      const turtle = await hbQuery(query, 'construct');
      return { content: [{ type: 'text', text: turtle }] };
    }
  );

  server.tool(
    'sparql_update',
    'Execute a SPARQL UPDATE (INSERT DATA, DELETE DATA, CLEAR, etc.).',
    { update: z.string().describe('SPARQL UPDATE statement') },
    async ({ update }) => {
      const result = await hbUpdate(update);
      return { content: [{ type: 'text', text: result || 'Update applied.' }] };
    }
  );

  // ── P1: Graph management ────────────────────────────────────────────────────

  server.tool(
    'push_turtle',
    'Push Turtle content into a named graph in Fuseki via HolonBridge.',
    {
      turtle:      z.string().describe('Valid Turtle 1.1/1.2 payload'),
      graph_iri:   z.string().describe('Target named graph IRI'),
      shapes_graph: z.string().optional().describe('SHACL shapes graph IRI for pre-push validation'),
    },
    async ({ turtle, graph_iri, shapes_graph }) => {
      const result = await hbPushTurtle(turtle, graph_iri, shapes_graph);
      return { content: [{ type: 'text', text: result }] };
    }
  );

  server.tool(
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

  server.tool(
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

  // ── P2: SHACL validation ────────────────────────────────────────────────────

  server.tool(
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

  // ── P3: Natural language query ──────────────────────────────────────────────

  server.tool(
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

  return server;
}

// ── Express app with SSE transport ───────────────────────────────────────────

const app = express();

// CORS — allow claude.ai to connect to this MCP remote endpoint.
app.use(cors({
  origin: ['https://claude.ai', 'https://api.claude.ai'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'Accept'],
  credentials: false,
}));
app.options('*', cors());

app.use(express.json());

/**
 * Auth middleware — every request must carry the MCP_REMOTE_TOKEN.
 * This is SEPARATE from the HolonBridge bearer token; it protects the
 * MCP endpoint itself so random internet traffic cannot invoke the tools.
 */
app.use((req, res, next) => {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ') || auth.slice(7) !== MCP_REMOTE_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized — bad or missing MCP_REMOTE_TOKEN' });
  }
  next();
});

/**
 * SSE endpoint — claude.ai connects here to establish the MCP session.
 * A fresh McpServer is created per connection (see createMcpServer() above).
 * Sessions are tracked by session ID so the POST /message handler can route
 * correctly.
 */
const sessions = new Map();  // sessionId → SSEServerTransport

app.get('/sse', async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');  // disable nginx buffering if behind a proxy

  const transport = new SSEServerTransport('/message', res);
  sessions.set(transport.sessionId, transport);

  res.on('close', () => {
    sessions.delete(transport.sessionId);
  });

  // Fresh McpServer instance per connection — fixes "Already connected" crash.
  const server = createMcpServer();
  await server.connect(transport);
});

/**
 * POST /message — client sends MCP messages here.
 * The session ID (provided by the client as a query param) routes the
 * message to the correct SSEServerTransport.
 */
app.post('/message', async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = sessions.get(sessionId);

  if (!transport) {
    return res.status(404).json({ error: `No active session: ${sessionId}` });
  }

  await transport.handlePostMessage(req, res);
});

/** Health probe — useful for ngrok and uptime monitoring. */
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    server: 'holonbridge-mcp-remote',
    version: '1.0.1',
    holonbridge: HOLONBRIDGE_URL,
    profiles: Object.keys(profiles),
    activeProfile,
  });
});

app.listen(parseInt(MCP_PORT), () => {
  console.log(`holonbridge-mcp-remote listening on :${MCP_PORT}`);
  console.log(`  HolonBridge target : ${HOLONBRIDGE_URL}`);
  console.log(`  Profiles           : ${Object.keys(profiles).join(', ')}`);
  console.log(`  SSE endpoint       : http://localhost:${MCP_PORT}/sse`);
  console.log(`  Health             : http://localhost:${MCP_PORT}/health`);
});
