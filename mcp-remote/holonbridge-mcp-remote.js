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
 *   FUSEKI_GSP=http://localhost:3030/ds/data        # retained for health reporting
 *                                                   # no longer used by push_turtle
 *
 * Token relationship (TODO: split properly when per-user scoping is added):
 *   HB_BEARER_TOKEN      — protects HolonBridge from the MCP remote
 *   MCP_REMOTE_TOKEN     — protects the MCP remote from external clients
 *   OAuth client_secret  — Claude sends this during /token exchange; must equal
 *                          MCP_REMOTE_TOKEN for the Bearer check on /sse to pass
 *
 * NOTE on registry-backed profiles (see below): querying GET /registry uses
 * this bridge's own HB_BEARER_TOKEN, which is sufficient to read federation
 * metadata (which bridges exist, their URL, their health). It is NOT
 * sufficient to authenticate SPARQL/push calls against a *different* bridge
 * once switched via set_endpoint — that still depends on whatever auth the
 * target bridge (e.g. Ben's GGSC instance) itself requires. The interbridge
 * token model (shared vs. per-bridge credentials) is a separate open question
 * from registry discovery and is not resolved by this change.
 *
 * Changelog
 * ─────────
 *   2026-07-09 v1.11.0 Add propose_property_update tool, wrapping HolonBridge's
 *                      lifecycle verb proposeAgentPropertyUpdate (POST
 *                      /holon/:iri/property, lib/lifecycle.js). Before this,
 *                      none of lib/lifecycle.js's thirteen verbs were reachable
 *                      through this MCP remote at all -- only the pre-lifecycle
 *                      surface (query/update/push/validate/get_holon) was
 *                      exposed. This is the first lifecycle verb wired through,
 *                      chosen because it's the one with an actual near-term use
 *                      (Adventure Mode agent health/wealth changes going through
 *                      a real SHACL-gated propose/approve pair instead of raw
 *                      sparql_update with no enforcement at all). The other
 *                      twelve verbs remain unexposed here pending the same
 *                      treatment.
 *   2026-07-07 v1.10.3 FIX: hbPushTurtle()'s shapes_graph parameter was
 *                      non-blocking. It called hbValidate() and awaited the
 *                      result, but never inspected report.conforms — a
 *                      validation report with conforms:false is a normal
 *                      successful HTTP response, not a thrown error, so
 *                      nothing stopped the subsequent /update push. Before
 *                      v1.10.2 this was accidentally masked: hbValidate()
 *                      always threw (the v1.10.1 /validate contract bug),
 *                      so shapes_graph always blocked the push — for the
 *                      wrong reason (broken endpoint, not real violations).
 *                      Fixed in v1.10.2, the accidental gate disappeared:
 *                      confirmed live that a sol:Planet instance missing
 *                      every required property (mass, meanRadius,
 *                      orbitalPeriod, distanceFromSun, moonCount, orbits)
 *                      still pushed successfully with shapes_graph set.
 *                      Fix: hbPushTurtle() now checks report.conforms and
 *                      throws — listing focusNode/path/message per
 *                      violation — before the /update call, so a
 *                      non-conforming payload never reaches the target
 *                      graph. Conforming payloads and calls without
 *                      shapes_graph are unaffected.
 *   2026-07-07 v1.10.2 FIX: hbValidate() was calling /validate with the old
 *                      contract (raw Turtle body, Content-Type: text/turtle,
 *                      shapes graph as a `?shapes=` query param). The route
 *                      handler (lib/validate.js, v2.9.1+) was refactored to
 *                      require a JSON body of { dataGraph, shapesGraph } where
 *                      dataGraph is the IRI of an *already-loaded* named graph
 *                      — it fetches that graph via GSP and delegates to
 *                      validateWithShacl(). Since hbValidate() never sent
 *                      dataGraph, every call hit the route's own 400 guard
 *                      ('"dataGraph" is required...'), regardless of dataset,
 *                      shapes graph content, or payload — including trivial
 *                      two-triple payloads. This also broke push_turtle
 *                      whenever a shapes_graph was supplied, since
 *                      hbPushTurtle() calls hbValidate() first in that case.
 *                      Fix: hbValidate() now pushes the submitted Turtle to a
 *                      short-lived temp graph via the existing hbPushTurtle
 *                      path (mode='replace', no shapes_graph so no recursion),
 *                      calls /validate with the correct JSON contract against
 *                      that temp graph, then drops it (best-effort, does not
 *                      block the returned report on cleanup success).
 *   2026-07-01 v1.10.1 FIX: set_endpoint was cosmetic. Every hb* HTTP helper
 *                      (hbQuery, hbUpdate, hbPushTurtle, hbGetHolon,
 *                      hbValidate, hbNlQuery, hbListGraphs) plus the inline
 *                      list_datasets/switch_dataset fetches called the
 *                      module-level HOLONBRIDGE_URL constant directly,
 *                      ignoring activeProfile entirely — so switching
 *                      profiles never redirected any actual query, push, or
 *                      dataset call; only get_endpoint/list_endpoints ever
 *                      read activeProfile. Introduced activeBaseUrl(), the
 *                      single source of truth for "which bridge do we talk
 *                      to right now," and routed every HTTP call through it.
 *                      /health now reports activeBridge alongside the
 *                      configured default, so this class of bug is visible
 *                      without having to compare dataset listings by hand.
 *                      This bug predates and was not introduced by v1.10.0;
 *                      it was exposed by v1.10.0 making profile-switching
 *                      to a *meaningfully different* bridge possible for the
 *                      first time (previously all named profiles pointed at
 *                      variations of the same local setup).
 *   2026-07-01 v1.10.0 Registry-backed profile discovery. list_endpoints,
 *                      get_endpoint, and set_endpoint now merge static
 *                      .env PROFILE_<n>_URL entries with live results
 *                      from GET /registry on HolonBridge (federated bridge
 *                      registry, GitHub-backed, health-checked server-side).
 *                      Any bridge registered in the federation — e.g. Ben's
 *                      GGSC bridge — becomes switchable via set_endpoint
 *                      without manual config edits or a restart. Registry
 *                      results are cached 30s; set_endpoint forces a fresh
 *                      pull so newly-registered bridges are available
 *                      immediately. Falls back to static/cached profiles if
 *                      the registry call fails (non-fatal).
 *   2026-06-28 v1.9.0  Route push_turtle through HolonBridge REST (/update)
 *                      instead of calling Fuseki GSP directly. Benefits:
 *                      - mode defaults to 'append' (POST/merge) not 'replace' (PUT)
 *                      - Bearer auth flows through on every push
 *                      - mode exposed as MCP tool parameter; callers opt into 'replace'
 *                      - Removes dependency on jenaBase / direct Fuseki access
 *   2026-06-28 v1.8.0  Fix push_turtle writes to wrong dataset: FUSEKI_GSP was
 *                      hardcoded in .env and never updated when switch_dataset
 *                      was called. Now derives jenaBase from FUSEKI_GSP once at
 *                      startup; tracks activeFusekiDataset in module state;
 *                      switch_dataset syncs it on success; hbPushTurtle builds
 *                      the GSP URL dynamically as jenaBase/activeFusekiDataset/data.
 *                      Also synced mcp-remote/ with root canonical file.
 *   2026-06-26 v1.7.1  (previous — see git log)
 *   2026-06-26 v1.2    Fix POST /message 400: remove express.json() middleware;
 *                      pass req.body explicitly to handlePostMessage.
 *   2026-06-26 v1.1    Fix "Already connected" crash: create McpServer per
 *                      SSE connection instead of sharing one instance.
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';

// ── Configuration ─────────────────────────────────────────────────────────────────

const {
  HOLONBRIDGE_URL = 'http://localhost:3031',
  HB_BEARER_TOKEN,
  MCP_REMOTE_TOKEN,
  MCP_PORT = '3032',
  FUSEKI_GSP = 'http://localhost:3030/ds/data',  // retained for health reporting; no longer used by push_turtle
} = process.env;

if (!HB_BEARER_TOKEN)  throw new Error('HB_BEARER_TOKEN is required in .env');
if (!MCP_REMOTE_TOKEN) throw new Error('MCP_REMOTE_TOKEN is required in .env');

// ── GSP dataset tracking (health reporting only) ───────────────────────────────────────────
//
// jenaBase and activeFusekiDataset are derived from FUSEKI_GSP and updated
// by switch_dataset. They are surfaced in /health for observability.
// push_turtle now routes through HolonBridge REST (/update) and no longer
// constructs a direct GSP URL.

const jenaBase = FUSEKI_GSP.replace(/\/[^/]+\/data\/?$/, '');   // "http://localhost:3030"
let activeFusekiDataset = FUSEKI_GSP.match(/\/([^/]+)\/data\/?$/)?.[1] ?? 'ds';

// ── HolonBridge HTTP helpers (aligned to v2.9.0 routes) ────────────────────────────

const hbHeaders = (extra = {}) => ({
  Authorization: `Bearer ${HB_BEARER_TOKEN}`,
  ...extra,
});

async function hbQuery(sparql, type = 'select') {
  const base = activeBaseUrl();
  if (type === 'construct') {
    const res = await fetch(`${base}/sparql-construct`, {
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
    const res = await fetch(`${base}/sparql-select`, {
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

async function hbUpdate(sparql) {
  const res = await fetch(`${activeBaseUrl()}/sparql-update`, {
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

async function hbPushTurtle(turtle, graphIri, shapesGraph, mode = 'append') {
  if (shapesGraph) {
    const report = await hbValidate(turtle, shapesGraph);
    if (report.conforms === false) {
      const violationLines = (report.violations ?? []).map((v, i) => {
        const focus = v.focusNode ? ` on <${v.focusNode}>` : '';
        const path  = v.path ? ` at ${v.path}` : '';
        const msg   = v.message ? ` — ${v.message}` : '';
        return `  ${i + 1}.${focus}${path}${msg}`;
      });
      throw new Error(
        `SHACL validation failed against <${shapesGraph}> — push aborted. ` +
        `${report.violationCount ?? report.violations?.length ?? 0} violation(s):\n` +
        (violationLines.length ? violationLines.join('\n') : '  (see rawReport for details)')
      );
    }
  }
  const res = await fetch(`${activeBaseUrl()}/update`, {
    method: 'POST',
    headers: hbHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ turtle, graph: graphIri, mode }),
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(`HolonBridge /update: HTTP ${res.status} — ${msg.slice(0, 200)}`);
  }
  const result = await res.json();
  return `Pushed to <${graphIri}> via HolonBridge /update — HTTP ${res.status}, mode=${mode}`;
}

async function hbGetHolon(holonIri, projectionMode = 'immersive') {
  const url = new URL(`${activeBaseUrl()}/holon/${encodeURIComponent(holonIri)}`);
  url.searchParams.set('projection', projectionMode);
  const res = await fetch(url.toString(), {
    headers: hbHeaders({ Accept: 'text/markdown' }),
  });
  if (!res.ok) throw new Error(`HolonBridge /holon: HTTP ${res.status}`);
  return res.text();
}

/**
 * Propose->validate->apply a delta to a numeric agent property via
 * HolonBridge's proposeAgentPropertyUpdate lifecycle verb (POST
 * /holon/:iri/property, lib/lifecycle.js). Validated against the
 * property's governing SHACL shape BEFORE any write on the HolonBridge
 * side -- a rejection comes back as a non-2xx HTTP response (409 for
 * CommandRejected, 403 for UnauthorisedError), surfaced here as a thrown
 * Error carrying the response body so the violation detail isn't lost.
 */
async function hbProposePropertyUpdate(agentIri, property, delta, rationale, actorIri, capProperty, floor) {
  const url = `${activeBaseUrl()}/holon/${encodeURIComponent(agentIri)}/property`;
  const body = { property, delta, rationale, actor: { iri: actorIri } };
  if (capProperty !== undefined) body.capProperty = capProperty;
  if (floor !== undefined) body.floor = floor;
  const res = await fetch(url, {
    method: 'POST',
    headers: hbHeaders({ 'Content-Type': 'application/json', Accept: 'text/markdown' }),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HolonBridge /holon/.../property: HTTP ${res.status} — ${text.slice(0, 400)}`);
  }
  return text;
}

/**
 * Validate a Turtle payload against a SHACL shapes graph.
 *
 * The current /validate route (lib/validate.js, v2.9.1+) only validates a
 * named graph that already exists in the dataset — it takes JSON
 * { dataGraph, shapesGraph } and fetches dataGraph via GSP internally. It
 * does not accept raw Turtle in the request body.
 *
 * To preserve this tool's existing contract (accept raw Turtle directly,
 * the way validate_turtle and push_turtle's shapes_graph option both do),
 * we push the submitted Turtle into a short-lived temp graph first, run
 * /validate against that graph's IRI, then drop the temp graph. Mirrors the
 * temp-graph pattern lib/shacl.js already uses server-side against Fuseki
 * directly — this does the equivalent through the public REST surface.
 */
async function hbValidate(turtle, shapesGraph) {
  const tempGraph = `urn:holonbridge-mcp:validate-temp:${Date.now()}`;

  // Push without a shapesGraph so this doesn't recurse back into hbValidate.
  await hbPushTurtle(turtle, tempGraph, null, 'replace');

  let result;
  try {
    const res = await fetch(`${activeBaseUrl()}/validate`, {
      method: 'POST',
      headers: hbHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
      body: JSON.stringify({ dataGraph: tempGraph, shapesGraph }),
    });
    if (!res.ok) {
      const msg = await res.text();
      throw new Error(`HolonBridge /validate: HTTP ${res.status} — ${msg.slice(0, 200)}`);
    }
    result = await res.json();
  } finally {
    // Best-effort cleanup — don't let a failed DROP mask or block the
    // validation result itself.
    await hbUpdate(`DROP SILENT GRAPH <${tempGraph}>`).catch(() => {});
  }

  return result;
}

async function hbNlQuery(question, graph) {
  const body = { nl: question };
  if (graph) body.graph = graph;
  const res = await fetch(`${activeBaseUrl()}/query`, {
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

async function hbListGraphs(filter) {
  const res = await fetch(`${activeBaseUrl()}/graphs`, {
    headers: hbHeaders({ Accept: 'application/json' }),
  });
  if (!res.ok) throw new Error(`HolonBridge /graphs: HTTP ${res.status}`);
  const { graphs } = await res.json();
  return graphs
    .map(g => ({ iri: g.iri, triples: String(g.triples) }))
    .filter(g => !filter || g.iri.includes(filter));
}

// ── Static (.env) profile state ─────────────────────────────────────────────────

const profiles = {
  default: { url: HOLONBRIDGE_URL, label: 'default (from .env)', source: 'static' },
};
Object.keys(process.env)
  .filter(k => k.startsWith('PROFILE_') && k.endsWith('_URL'))
  .forEach(k => {
    const name = k.replace(/^PROFILE_/, '').replace(/_URL$/, '').toLowerCase();
    profiles[name] = {
      url: process.env[k],
      label: process.env[`PROFILE_${name.toUpperCase()}_LABEL`] || name,
      source: 'static',
    };
  });

let activeProfile = 'default';

// ── Registry-backed profiles ────────────────────────────────────────────────────
//
// In addition to the static .env profiles above, profiles are pulled live
// from HolonBridge's federated bridge registry (GET /registry), which is
// sourced from a GitHub-backed RDF registry graph and health-checked
// server-side (see registry/session-init.js and registry/server-integration.md
// in this repo). This lets any bridge registered in the federation — e.g.
// Ben Wortley's GGSC bridge — become switchable via set_endpoint without
// manual profile edits or a restart, and stays current as the registry grows
// past two nodes.
//
// Cached for REGISTRY_CACHE_MAX_AGE_MS to avoid hitting /registry on every
// tool call; set_endpoint forces a fresh pull so a bridge registered moments
// ago is immediately available. On fetch failure, falls back to the last
// good cache (or empty, pre-first-fetch) rather than throwing — registry
// unavailability should never break the static profiles.

const REGISTRY_CACHE_MAX_AGE_MS = 30_000;
let registryCache = { fetchedAt: 0, profiles: {} };

function slugFromIri(iri) {
  // "https://w3id.org/holonbridge/registry/ben-ggsc" -> "ben-ggsc"
  return iri.split('/').filter(Boolean).pop();
}

async function fetchRegistryProfiles({ force = false } = {}) {
  const age = Date.now() - registryCache.fetchedAt;
  if (!force && registryCache.fetchedAt && age < REGISTRY_CACHE_MAX_AGE_MS) {
    return registryCache.profiles;
  }
  try {
    const res = await fetch(`${HOLONBRIDGE_URL}/registry`, {
      headers: hbHeaders({ Accept: 'application/json' }),
    });
    if (!res.ok) {
      console.warn(`[registry] GET /registry: HTTP ${res.status} — keeping previous cache`);
      return registryCache.profiles;
    }
    const { bridges = [] } = await res.json();
    const fresh = {};
    for (const b of bridges) {
      if (!b.iri || !b.url) continue;
      const slug = slugFromIri(b.iri);
      fresh[slug] = {
        url: b.url,
        label: b.label || slug,
        reachable: b.health?.reachable ?? b.reachable ?? null,
        latencyMs: b.health?.latencyMs ?? b.latencyMs ?? null,
        source: 'registry',
      };
    }
    registryCache = { fetchedAt: Date.now(), profiles: fresh };
    return fresh;
  } catch (err) {
    console.warn('[registry] fetch failed (non-fatal, using previous cache):', err.message);
    return registryCache.profiles;
  }
}

async function getMergedProfiles({ force = false } = {}) {
  const registryProfiles = await fetchRegistryProfiles({ force });
  // Static profiles are the fallback layer; registry entries win on name
  // collision since they carry live health data. Distinct slugs (e.g.
  // "default" vs. "kurtcagle-primary") simply appear as separate entries.
  return { ...profiles, ...registryProfiles };
}

// ── Active base URL resolution ──────────────────────────────────────────────────
//
// PRIOR BUG (present through v1.10.0): every hb* HTTP helper below called the
// module-level HOLONBRIDGE_URL constant directly, ignoring activeProfile
// entirely. set_endpoint updated activeProfile, which only get_endpoint and
// list_endpoints ever read — so switching profiles never actually redirected
// any query, push, or dataset call. This function is the single source of
// truth for "which bridge do we talk to right now," and every HTTP call
// below must go through it rather than referencing HOLONBRIDGE_URL directly.
//
// Synchronous by design: it reads whatever is already in `profiles` (static)
// and `registryCache.profiles` (last-fetched registry snapshot) without
// triggering a network call on every single query. set_endpoint forces a
// fresh registry pull *before* updating activeProfile, so by the time any
// subsequent call runs, the cache reflects the profile that was just chosen.

function activeBaseUrl() {
  const merged = { ...profiles, ...registryCache.profiles };
  return merged[activeProfile]?.url ?? HOLONBRIDGE_URL;
}

// ── MCP server factory ──────────────────────────────────────────────────────────────
//
// A fresh McpServer is created per /sse connection to avoid the SDK's
// single-transport restriction ("Already connected to a transport").

function createMcpServer() {
  const srv = new McpServer({
    name: 'holonbridge-mcp-remote',
    version: '1.11.0',
  });

  srv.tool(
    'list_endpoints',
    'List all known HolonBridge profiles — static .env profiles plus live results ' +
    'from the federated bridge registry (GET /registry), including reachability.',
    {},
    async () => {
      const merged = await getMergedProfiles();
      const lines = Object.entries(merged).map(([name, p]) => {
        const marker  = name === activeProfile ? '* ' : '  ';
        const health  = p.reachable === true ? ' ✓ reachable'
                       : p.reachable === false ? ' ✗ unreachable'
                       : '';
        const latency = p.latencyMs != null ? ` (${p.latencyMs}ms)` : '';
        const src     = p.source === 'registry' ? ' [registry]' : ' [static]';
        return `${marker}${name}: ${p.url} (${p.label})${health}${latency}${src}`;
      });
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  srv.tool('get_endpoint', 'Show the currently active HolonBridge profile.', {}, async () => {
    const merged = await getMergedProfiles();
    const p = merged[activeProfile];
    return {
      content: [{
        type: 'text',
        text: `Active profile: ${activeProfile} → ${p?.url ?? 'unknown (profile no longer present)'}`,
      }],
    };
  });

  srv.tool(
    'set_endpoint',
    'Switch the active HolonBridge profile by name — static config or any bridge ' +
    'currently in the live federation registry.',
    { name: z.string().describe('Profile name from list_endpoints') },
    async ({ name }) => {
      // Force a fresh registry pull so a bridge registered moments ago is
      // switchable immediately, without waiting out the cache window.
      const merged = await getMergedProfiles({ force: true });
      if (!merged[name]) {
        return {
          content: [{
            type: 'text',
            text: `Unknown profile "${name}". Available: ${Object.keys(merged).join(', ')}`,
          }],
        };
      }
      activeProfile = name;
      return { content: [{ type: 'text', text: `Switched to profile "${name}" → ${merged[name].url}` }] };
    }
  );

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
    { query: z.string().describe('SPARQL CONSTRUCT or DESCRIBE query string') },
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

  srv.tool(
    'push_turtle',
    'Push Turtle content into a named graph via HolonBridge REST (/update). ' +
    'Defaults to append mode (POST/merge into existing graph). ' +
    'Use mode="replace" to overwrite the entire named graph. ' +
    'Optionally validates against a SHACL shapes graph before pushing.',
    {
      turtle:       z.string().describe('Valid Turtle 1.1/1.2 payload'),
      graph_iri:    z.string().describe('Target named graph IRI'),
      shapes_graph: z.string().optional().describe('SHACL shapes graph IRI for pre-push validation'),
      mode:         z.enum(['append', 'replace']).optional()
                     .describe('Write mode: append (default — merges) or replace (overwrites the entire graph)'),
    },
    async ({ turtle, graph_iri, shapes_graph, mode = 'append' }) => {
      const result = await hbPushTurtle(turtle, graph_iri, shapes_graph, mode);
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
    'propose_property_update',
    'Propose, validate, and (if valid) apply a delta to a numeric agent property -- ' +
    'e.g. https://schema.org/healthPoints or https://schema.org/currentWealth -- via ' +
    "HolonBridge's proposeAgentPropertyUpdate lifecycle verb (POST /holon/:iri/property). " +
    "Validated against the property's governing SHACL shape (e.g. AgentHealthShape, " +
    'AgentWealthShape) BEFORE anything is written -- a rejected proposal throws with no ' +
    'trace left in either the holons or events graph. On success, writes a ' +
    'holon:ModelUpdateRequest + holon:ModelUpdateApprove event pair plus the new value ' +
    'on the agent. Pass cap_property (e.g. maxHealthPoints) to cap the result at another ' +
    "property's current value, mirroring the existing healthPoints capping behaviour.",
    {
      agent_iri:    z.string().describe('IRI of the agent whose property is changing'),
      property:     z.string().describe('Full IRI of the numeric property, e.g. https://schema.org/currentWealth'),
      delta:        z.number().describe('Signed amount to add (negative to subtract/spend)'),
      rationale:    z.string().describe('Short human-readable reason for this change'),
      actor_iri:    z.string().describe('IRI of the actor performing this change (holon:agent / prov:wasGeneratedBy)'),
      cap_property: z.string().optional().describe('Optional IRI of a property to cap the result at, e.g. https://schema.org/maxHealthPoints'),
      floor:        z.number().optional().describe('Optional floor for the result (default 0)'),
    },
    async ({ agent_iri, property, delta, rationale, actor_iri, cap_property, floor }) => {
      const result = await hbProposePropertyUpdate(agent_iri, property, delta, rationale, actor_iri, cap_property, floor);
      return { content: [{ type: 'text', text: result }] };
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

  srv.tool(
    'validate_turtle',
    'Validate a Turtle payload against a SHACL shapes graph.',
    {
      turtle:       z.string().describe('Turtle payload to validate'),
      shapes_graph: z.string().describe('IRI of the SHACL shapes graph in Fuseki'),
    },
    async ({ turtle, shapes_graph }) => {
      const report = await hbValidate(turtle, shapes_graph);
      return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
    }
  );

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

  srv.tool(
    'list_datasets',
    'List all Fuseki datasets available on this HolonBridge instance (GET /datasets).',
    {},
    async () => {
      const res = await fetch(`${activeBaseUrl()}/datasets`, {
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
    'Session-scoped; does not persist across HolonBridge restarts. ' +
    'Operates against whichever bridge is currently active (see set_endpoint).',
    { dataset: z.string().describe('Fuseki dataset name (e.g. "chloe", "ds", "storme")') },
    async ({ dataset }) => {
      const res = await fetch(`${activeBaseUrl()}/dataset`, {
        method: 'POST',
        headers: hbHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ dataset }),
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(`HolonBridge /dataset: HTTP ${res.status} — ${msg.slice(0, 200)}`);
      }
      const result = await res.json();
      activeFusekiDataset = dataset;
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  return srv;
}

// ── Express app ───────────────────────────────────────────────────────────────────

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

// ── Minimal OAuth 2.0 + PKCE implementation ──────────────────────────────────────────

const MCP_PUBLIC_URL = process.env.MCP_PUBLIC_URL || 'https://kurtcagle-mcp.ngrok.io';

const authCodes = new Map();
const registeredClients = new Map();

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

app.post('/register', express.json(), (req, res) => {
  console.log('[OAuth] POST /register body:', JSON.stringify(req.body));
  const client_id     = randomUUID();
  const client_secret = randomUUID();
  registeredClients.set(client_id, { ...(req.body ?? {}), client_id, client_secret });
  res.status(201).json({
    client_id,
    client_secret,
    client_id_issued_at:      Math.floor(Date.now() / 1000),
    client_secret_expires_at: 0,
    ...(req.body ?? {}),
  });
});

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

app.post('/token', express.urlencoded({ extended: false }), express.json(), (req, res) => {
  console.log('[OAuth] POST /token body:', JSON.stringify(req.body));
  const { grant_type, code } = req.body ?? {};

  if (grant_type === 'authorization_code') {
    if (!code || !authCodes.has(code)) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Unknown or expired code.' });
    }
    authCodes.delete(code);
    return res.json({ access_token: MCP_REMOTE_TOKEN, token_type: 'Bearer', expires_in: 86400 });
  }

  if (grant_type === 'client_credentials') {
    return res.json({ access_token: MCP_REMOTE_TOKEN, token_type: 'Bearer', expires_in: 86400 });
  }

  return res.status(400).json({ error: 'unsupported_grant_type' });
});

app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ── Bearer auth middleware (applied to all remaining routes) ────────────────────────────

app.use((req, res, next) => {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ') || auth.slice(7) !== MCP_REMOTE_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized — bad or missing MCP_REMOTE_TOKEN' });
  }
  next();
});

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

app.get('/health', async (_req, res) => {
  const merged = await getMergedProfiles();
  res.json({
    status: 'ok',
    server: 'holonbridge-mcp-remote',
    version: '1.11.0',
    holonbridge: HOLONBRIDGE_URL,
    activeBridge: activeBaseUrl(),
    jenaBase,
    fusekiGspDataset: activeFusekiDataset,
    fusekiGspEndpoint: `${jenaBase}/${activeFusekiDataset}/data`,
    profiles: Object.keys(merged),
    activeProfile,
    activeSessions: sessions.size,
  });
});

app.listen(parseInt(MCP_PORT), () => {
  console.log(`holonbridge-mcp-remote v1.11.0 listening on :${MCP_PORT}`);
  console.log(`  HolonBridge target  : ${HOLONBRIDGE_URL}`);
  console.log(`  Jena base           : ${jenaBase}`);
  console.log(`  Active GSP dataset  : ${activeFusekiDataset}`);
  console.log(`  Static profiles     : ${Object.keys(profiles).join(', ')}`);
  console.log(`  Registry-backed     : fetched on demand from ${HOLONBRIDGE_URL}/registry (cached ${REGISTRY_CACHE_MAX_AGE_MS / 1000}s)`);
  console.log(`  SSE endpoint        : http://localhost:${MCP_PORT}/sse`);
  console.log(`  Health              : http://localhost:${MCP_PORT}/health`);
});
