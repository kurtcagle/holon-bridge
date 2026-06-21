/**
 * registry/session-init.js
 *
 * HolonBridge network registry bootstrap.
 * Three phases, each independently callable:
 *
 *   Phase 1  loadRegistryCache()   — GitHub DataBooks → Jena named graphs
 *   Phase 2  resolveEndpoints()    — refresh stale endpoint records
 *   Phase 3  probeReachability()   — live /health probe (never cached)
 *
 * Named graphs populated:
 *   urn:holon:graph:registry:ontology       hb: class/property definitions
 *   urn:holon:graph:registry:content-types  hbc: taxonomy
 *   urn:holon:graph:registry:bridges        per-bridge capability descriptions
 *   urn:holon:graph:registry:endpoints      volatile endpoint records
 *
 * Config read from process.env (already loaded by server.js via dotenv):
 *   REGISTRY_GITHUB_OWNER    e.g. colossalhop
 *   REGISTRY_GITHUB_REPO     e.g. un-ggce-supply-chain
 *   REGISTRY_GITHUB_TOKEN    GitHub PAT (repo read scope)
 *   REGISTRY_CACHE_MAX_AGE   ms; default 86400000 (24h)
 *   JENA_BASE                e.g. http://localhost:3030  (shared with server.js)
 *   JENA_DATASET             e.g. ds                    (shared with server.js)
 */

import { fetchRegistryDataBooks }                             from './github-fetch.js'
import { gspPut, graphAge, queryStaleEndpoints,
         queryBridgeEndpoints }                               from './sparql-helper.js'

// ---------------------------------------------------------------------------
// Named graph IRIs — canonical constants exported for use in server.js routes
// ---------------------------------------------------------------------------

export const GRAPHS = {
  ontology:     'urn:holon:graph:registry:ontology',
  contentTypes: 'urn:holon:graph:registry:content-types',
  bridges:      'urn:holon:graph:registry:bridges',
  endpoints:    'urn:holon:graph:registry:endpoints',
}

// ---------------------------------------------------------------------------
// Internal config builder
// ---------------------------------------------------------------------------

function buildConfig(overrides = {}) {
  return {
    github: {
      owner: overrides.owner || process.env.REGISTRY_GITHUB_OWNER || 'colossalhop',
      repo:  overrides.repo  || process.env.REGISTRY_GITHUB_REPO  || 'un-ggce-supply-chain',
      token: overrides.token || process.env.REGISTRY_GITHUB_TOKEN || process.env.GITHUB_PAT,
    },
    fuseki: {
      base:    overrides.fusekiBase    || process.env.JENA_BASE        || 'http://localhost:3030',
      dataset: overrides.fusekiDataset || process.env.JENA_DATASET     || 'ds',
    },
    cacheMaxAgeMs: overrides.cacheMaxAgeMs
      || parseInt(process.env.REGISTRY_CACHE_MAX_AGE ?? '86400000', 10),
  }
}

// ---------------------------------------------------------------------------
// Phase 1: Load registry DataBooks from GitHub into Jena
// ---------------------------------------------------------------------------

export async function loadRegistryCache(overrides = {}) {
  const { github, fuseki, cacheMaxAgeMs } = buildConfig(overrides)

  const age = await graphAge(fuseki.base, fuseki.dataset, GRAPHS.ontology)
  if (age !== null && age < cacheMaxAgeMs) {
    console.log(`[registry] Cache fresh (${Math.round(age / 60000)}m old) — skipping fetch`)
    return { skipped: true, graphsUpdated: [] }
  }

  if (!github.token) {
    console.warn('[registry] No GitHub token — cannot fetch registry DataBooks')
    return { skipped: true, graphsUpdated: [], error: 'No GitHub token' }
  }

  const turtle = await fetchRegistryDataBooks(github)

  const updates = [
    { graph: GRAPHS.ontology,     turtle: turtle.ontology,     label: 'ontology' },
    { graph: GRAPHS.contentTypes, turtle: turtle.contentTypes, label: 'content-types' },
    { graph: GRAPHS.bridges,      turtle: turtle.bridges,      label: 'bridges' },
    { graph: GRAPHS.endpoints,    turtle: turtle.endpoints,    label: 'endpoints' },
  ]

  const graphsUpdated = []
  for (const { graph, turtle: t, label } of updates) {
    if (!t?.trim()) { console.warn(`[registry] Empty Turtle for ${label} — skipping`); continue }
    await gspPut(fuseki.base, fuseki.dataset, graph, t)
    graphsUpdated.push(graph)
    console.log(`[registry] Updated ${label} graph`)
  }

  return { skipped: false, graphsUpdated }
}

// ---------------------------------------------------------------------------
// Phase 2: Resolve stale endpoint records
// ---------------------------------------------------------------------------

export async function resolveEndpoints(overrides = {}) {
  const { github, fuseki } = buildConfig(overrides)

  const stale = await queryStaleEndpoints(fuseki.base, fuseki.dataset, {
    registryGraph: GRAPHS.bridges,
    endpointGraph: GRAPHS.endpoints,
  })

  const staleCount = stale.filter(r => r.isStale).length
  if (staleCount === 0) {
    console.log('[registry] All endpoint records within TTL')
    return { refreshed: false, staleCount: 0 }
  }

  console.log(`[registry] ${staleCount} stale endpoint record(s) — refreshing...`)

  if (!github.token) {
    console.warn('[registry] No GitHub token — cannot refresh endpoints')
    return { refreshed: false, staleCount, error: 'No GitHub token' }
  }

  const turtle = await fetchRegistryDataBooks(github)
  if (turtle.endpoints?.trim()) {
    await gspPut(fuseki.base, fuseki.dataset, GRAPHS.endpoints, turtle.endpoints)
    console.log('[registry] Endpoint records refreshed')
    return { refreshed: true, staleCount }
  }

  return { refreshed: false, staleCount, error: 'Empty endpoints Turtle' }
}

// ---------------------------------------------------------------------------
// Phase 3: Live reachability probe (never cached)
// ---------------------------------------------------------------------------

export async function probeReachability(overrides = {}) {
  const { fuseki } = buildConfig(overrides)

  const endpoints = await queryBridgeEndpoints(fuseki.base, fuseki.dataset, {
    registryGraph: GRAPHS.bridges,
    endpointGraph: GRAPHS.endpoints,
  })

  if (!endpoints.length) {
    console.log('[registry] No bridge endpoints found in registry')
    return new Map()
  }

  // Prefer Tailscale hostname over public URL when present
  const targets = endpoints.map(b => ({
    bridgeIRI: b.bridge?.value,
    label:     b.label?.value || b.bridge?.value,
    url:       b.tailscale?.value || b.url?.value,
  })).filter(t => t.url)

  const settled = await Promise.allSettled(
    targets.map(async t => {
      const t0  = Date.now()
      const res = await fetch(`${t.url.replace(/\/$/, '')}/health`, {
        signal: AbortSignal.timeout(3000),
      })
      return { ...t, reachable: res.ok, latencyMs: Date.now() - t0, statusCode: res.status }
    })
  )

  const healthMap = new Map()
  settled.forEach((r, i) => {
    const t = targets[i]
    healthMap.set(
      t.bridgeIRI,
      r.status === 'fulfilled'
        ? r.value
        : { ...t, reachable: false, latencyMs: null, error: r.reason?.message }
    )
  })

  const ok  = [...healthMap.values()].filter(v => v.reachable)
  const bad = [...healthMap.values()].filter(v => !v.reachable)
  if (ok.length)  ok.forEach(v  => console.log(`[registry] ✓ ${v.label} (${v.latencyMs}ms)`))
  if (bad.length) bad.forEach(v => console.log(`[registry] ✗ ${v.label} — ${v.error || 'no response'}`))

  return healthMap
}

// ---------------------------------------------------------------------------
// Full session init — call from server.js at startup
// ---------------------------------------------------------------------------

export async function initSession(overrides = {}) {
  console.log('[registry] Session init starting...')
  const cfg = buildConfig(overrides)
  console.log(`[registry] Source: ${cfg.github.owner}/${cfg.github.repo}`)

  let cache, endpoints, health

  try       { cache     = await loadRegistryCache(overrides) }
  catch (e) { console.error('[registry] Phase 1:', e.message); cache = { skipped: true, error: e.message } }

  try       { endpoints = await resolveEndpoints(overrides) }
  catch (e) { console.error('[registry] Phase 2:', e.message); endpoints = { refreshed: false } }

  try       { health    = await probeReachability(overrides) }
  catch (e) { console.error('[registry] Phase 3:', e.message); health = new Map() }

  console.log('[registry] Session init complete')
  return { cache, endpoints, health }
}
