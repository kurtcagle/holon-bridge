'use strict';

/**
 * registry/session-init.js
 *
 * HolonBridge network registry bootstrap.
 * Runs at server startup (or on-demand) to populate the local Jena
 * Fuseki instance with the federated bridge registry, then probes
 * reachability of all known bridges.
 *
 * Three phases — each independently callable:
 *
 *   Phase 1  loadRegistryCache()   — fetch DataBooks from GitHub → Jena
 *   Phase 2  resolveEndpoints()    — refresh stale endpoint records
 *   Phase 3  probeReachability()   — live health check (never cached)
 *
 * Named graph assignments:
 *   urn:holon:graph:registry:ontology       hb: class/property definitions
 *   urn:holon:graph:registry:content-types  hbc: taxonomy
 *   urn:holon:graph:registry:bridges        per-bridge capability descriptions
 *   urn:holon:graph:registry:endpoints      volatile endpoint records
 *
 * Config (from .env or passed explicitly):
 *   REGISTRY_GITHUB_OWNER   e.g. colossalhop
 *   REGISTRY_GITHUB_REPO    e.g. un-ggce-supply-chain
 *   REGISTRY_GITHUB_TOKEN   GitHub PAT (repo scope)
 *   REGISTRY_CACHE_MAX_AGE  milliseconds; default 86400000 (24h)
 *   FUSEKI_BASE             e.g. http://localhost:3030
 *   FUSEKI_DATASET          e.g. ds
 */

require('dotenv').config();

const { fetchRegistryDataBooks } = require('./github-fetch.js');
const {
  gspPut,
  graphAge,
  queryStaleEndpoints,
  queryBridgeEndpoints,
} = require('./sparql-helper.js');

// Named graph IRIs — canonical, not configurable
const GRAPHS = {
  ontology:     'urn:holon:graph:registry:ontology',
  contentTypes: 'urn:holon:graph:registry:content-types',
  bridges:      'urn:holon:graph:registry:bridges',
  endpoints:    'urn:holon:graph:registry:endpoints',
};

const HB = 'https://w3id.org/holonbridge/ontology/';

/**
 * Build config from environment with optional overrides.
 */
function buildConfig(overrides = {}) {
  return {
    github: {
      owner: overrides.owner || process.env.REGISTRY_GITHUB_OWNER || 'colossalhop',
      repo:  overrides.repo  || process.env.REGISTRY_GITHUB_REPO  || 'un-ggce-supply-chain',
      token: overrides.token || process.env.REGISTRY_GITHUB_TOKEN || process.env.GITHUB_PAT,
    },
    fuseki: {
      base:    overrides.fusekiBase    || process.env.FUSEKI_BASE    || 'http://localhost:3030',
      dataset: overrides.fusekiDataset || process.env.FUSEKI_DATASET || 'ds',
    },
    cacheMaxAgeMs: overrides.cacheMaxAgeMs
      || parseInt(process.env.REGISTRY_CACHE_MAX_AGE, 10)
      || 86_400_000,   // 24h default
  };
}

/**
 * Phase 1: Load registry DataBooks from GitHub into Jena.
 *
 * Checks the age of urn:holon:graph:registry:ontology against cacheMaxAgeMs.
 * If fresh, skips the fetch. If stale or absent, fetches all four DataBooks
 * and replaces the corresponding named graphs via GSP PUT.
 *
 * Returns: { skipped: boolean, graphsUpdated: string[] }
 */
async function loadRegistryCache(config) {
  const { github, fuseki, cacheMaxAgeMs } = config;

  const age = await graphAge(fuseki.base, fuseki.dataset, GRAPHS.ontology);

  if (age !== null && age < cacheMaxAgeMs) {
    const ageMin = Math.round(age / 60_000);
    console.log(`[registry] Cache fresh (${ageMin}m old) — skipping GitHub fetch`);
    return { skipped: true, graphsUpdated: [] };
  }

  if (!github.token) {
    console.warn('[registry] No GitHub token configured — cannot fetch registry DataBooks');
    return { skipped: true, graphsUpdated: [], error: 'No GitHub token' };
  }

  console.log('[registry] Fetching registry DataBooks from GitHub...');
  const turtle = await fetchRegistryDataBooks(github);

  // Push all four graphs — replace semantics (PUT)
  const updates = [
    { graph: GRAPHS.ontology,     turtle: turtle.ontology,     label: 'ontology' },
    { graph: GRAPHS.contentTypes, turtle: turtle.contentTypes, label: 'content-types' },
    { graph: GRAPHS.bridges,      turtle: turtle.bridges,      label: 'bridges' },
    { graph: GRAPHS.endpoints,    turtle: turtle.endpoints,    label: 'endpoints' },
  ];

  const graphsUpdated = [];
  for (const { graph, turtle: t, label } of updates) {
    if (!t || !t.trim()) {
      console.warn(`[registry] Empty Turtle for ${label} — skipping graph update`);
      continue;
    }
    await gspPut(fuseki.base, fuseki.dataset, graph, t);
    graphsUpdated.push(graph);
    console.log(`[registry] Updated ${label} graph`);
  }

  return { skipped: false, graphsUpdated };
}

/**
 * Phase 2: Resolve stale endpoint records.
 *
 * Queries the registry for endpoint records whose TTL has expired
 * (or which are missing entirely), then re-fetches the endpoints
 * DataBook from GitHub to refresh them.
 *
 * This is a targeted refresh — only the endpoints graph is updated,
 * not the full registry cache.
 *
 * Returns: { refreshed: boolean, staleCount: number }
 */
async function resolveEndpoints(config) {
  const { github, fuseki } = config;

  const stale = await queryStaleEndpoints(fuseki.base, fuseki.dataset, {
    registryGraph: GRAPHS.bridges,
    endpointGraph: GRAPHS.endpoints,
  });

  const staleCount = stale.filter(r => r.isStale).length;

  if (staleCount === 0) {
    console.log('[registry] All endpoint records within TTL');
    return { refreshed: false, staleCount: 0 };
  }

  console.log(`[registry] ${staleCount} stale endpoint record(s) — refreshing...`);

  if (!github.token) {
    console.warn('[registry] No GitHub token — cannot refresh endpoint records');
    return { refreshed: false, staleCount, error: 'No GitHub token' };
  }

  // Re-fetch just the endpoints DataBook
  const turtle = await fetchRegistryDataBooks(github);
  if (turtle.endpoints && turtle.endpoints.trim()) {
    await gspPut(fuseki.base, fuseki.dataset, GRAPHS.endpoints, turtle.endpoints);
    console.log('[registry] Endpoint records refreshed');
    return { refreshed: true, staleCount };
  }

  return { refreshed: false, staleCount, error: 'Empty endpoints Turtle' };
}

/**
 * Phase 3: Probe reachability of all registered bridges.
 *
 * Queries Jena for bridge endpoint URLs, probes each with a GET /health
 * (3-second timeout), and returns a result map.
 *
 * Results are NEVER cached — always live. The health map is returned
 * to the caller (server.js) for logging and optional metric recording.
 *
 * Returns: Map<bridgeIRI, { label, url, reachable, latencyMs, error? }>
 */
async function probeReachability(config) {
  const { fuseki } = config;

  const endpoints = await queryBridgeEndpoints(fuseki.base, fuseki.dataset, {
    registryGraph: GRAPHS.bridges,
    endpointGraph: GRAPHS.endpoints,
  });

  if (!endpoints.length) {
    console.log('[registry] No bridge endpoints found in registry');
    return new Map();
  }

  // For each bridge, prefer Tailscale host if available
  // (Tailscale client running locally → mesh-internal access)
  // Fall back to public endpointURL.
  const probeTargets = endpoints.map(b => ({
    bridgeIRI:    b.bridge?.value,
    label:        b.label?.value || b.bridge?.value,
    url:          b.tailscale?.value || b.url?.value,
    accessPolicy: b.accessPolicy?.value,
  })).filter(t => t.url);

  const results = await Promise.allSettled(
    probeTargets.map(async target => {
      const healthURL = `${target.url.replace(/\/$/, '')}/health`;
      const t0 = Date.now();

      const res = await fetch(healthURL, {
        signal: AbortSignal.timeout(3000),
        // Don't send auth for health checks — /health should be unprotected
      });

      return {
        ...target,
        reachable:  res.ok,
        latencyMs:  Date.now() - t0,
        statusCode: res.status,
      };
    })
  );

  const healthMap = new Map();
  results.forEach((r, i) => {
    const target = probeTargets[i];
    if (r.status === 'fulfilled') {
      healthMap.set(target.bridgeIRI, r.value);
    } else {
      healthMap.set(target.bridgeIRI, {
        ...target,
        reachable: false,
        latencyMs: null,
        error:     r.reason?.message || 'Unknown error',
      });
    }
  });

  // Log summary
  const reachable   = [...healthMap.values()].filter(v => v.reachable);
  const unreachable = [...healthMap.values()].filter(v => !v.reachable);

  if (reachable.length) {
    console.log(`[registry] Reachable (${reachable.length}):`);
    reachable.forEach(v =>
      console.log(`  ✓ ${v.label} — ${v.url} (${v.latencyMs}ms)`)
    );
  }
  if (unreachable.length) {
    console.log(`[registry] Unreachable (${unreachable.length}):`);
    unreachable.forEach(v =>
      console.log(`  ✗ ${v.label} — ${v.error || 'no response'}`)
    );
  }

  return healthMap;
}

/**
 * Full session init — runs all three phases in order.
 * Call from server.js at startup.
 *
 * Returns: {
 *   cache:       result of loadRegistryCache,
 *   endpoints:   result of resolveEndpoints,
 *   health:      Map from probeReachability,
 * }
 */
async function initSession(overrides = {}) {
  const config = buildConfig(overrides);
  console.log('[registry] Session init starting...');
  console.log(`[registry] Registry source: ${config.github.owner}/${config.github.repo}`);
  console.log(`[registry] Fuseki: ${config.fuseki.base}/${config.fuseki.dataset}`);

  let cache, endpoints, health;

  try {
    cache = await loadRegistryCache(config);
  } catch (err) {
    console.error('[registry] Phase 1 failed:', err.message);
    cache = { skipped: true, error: err.message };
  }

  try {
    endpoints = await resolveEndpoints(config);
  } catch (err) {
    console.error('[registry] Phase 2 failed:', err.message);
    endpoints = { refreshed: false, error: err.message };
  }

  try {
    health = await probeReachability(config);
  } catch (err) {
    console.error('[registry] Phase 3 failed:', err.message);
    health = new Map();
  }

  console.log('[registry] Session init complete');
  return { cache, endpoints, health };
}

module.exports = {
  initSession,
  loadRegistryCache,
  resolveEndpoints,
  probeReachability,
  buildConfig,
  GRAPHS,
};
