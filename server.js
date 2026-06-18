/**
 * server.js -- HolonBridge v2.5.0
 *
 * HTTP bridge between an LLM client and a Jena 6.0 Fuseki triplestore.
 *
 * Endpoints
 * ---------
 *   POST /query          NL -> SPARQL -> interpreted answer
 *   POST /update         Turtle -> SHACL-validate -> push to named graph
 *   POST /sparql-update  Raw SPARQL UPDATE (no SHACL gate)
 *   POST /reload         Reload schema context + rediscover named graphs
 *   POST /dataset        Switch active dataset at runtime
 *   GET  /datasets       List all datasets on the Fuseki server
 *   GET  /description    Full capability manifest for LLM consumption
 *   GET  /health         Operational health check
 *
 * Dataset selection (lowest to highest precedence)
 * ------------------------------------------------
 *   1. JENA_DATASET env var          (dataset name only, e.g. "ds")
 *   2. -d / --dataset CLI flag       (dataset name only)
 *   3. POST /dataset at runtime      (overrides all of the above)
 *   4. JENA_ENDPOINT env var         (overrides SPARQL URL entirely -- legacy)
 *
 * Context directory layout
 * ------------------------
 *   context/
 *     {server}/          e.g. localhost-3030  or  kurtcagle.ngrok.io
 *       {dataset}/       e.g. ds  or  ggsc
 *         01-prefixes.databook.md
 *         02-classes.databook.md
 *         03-named-queries.databook.md
 *         ...
 *
 *   Files are merged alphabetically.  Any change to the active dataset's
 *   directory triggers an automatic reload via chokidar.
 */

import 'dotenv/config'
import express          from 'express'
import chokidar         from 'chokidar'
import { join }         from 'path'

import { loadDataBookFromDir }                                      from './lib/databook.js'
import { runQuery, formatBindings, discoverGraphs,
         checkShaclGraph, pushToGraph, SparqlError }               from './lib/sparql.js'
import { buildQuery, retryQuery, interpretResults }                 from './lib/llm.js'
import { buildResponseDataBook }                                    from './lib/format.js'
import { validateWithShacl }                                        from './lib/shacl.js'

// --- CLI arg parser -----------------------------------------------------------

function parseDatasetArg() {
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-d' || args[i] === '--dataset') && args[i + 1]) return args[i + 1]
    const m = args[i].match(/^--dataset=(.+)$/)
    if (m) return m[1]
  }
  return null
}

// --- Config -------------------------------------------------------------------

const PORT        = parseInt(process.env.PORT        ?? '3031', 10)
let   JENA_BASE   = process.env.JENA_BASE             ?? 'http://localhost:3030'
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES ?? '2', 10)
const MODEL       = process.env.CLAUDE_MODEL          ?? 'claude-sonnet-4-6'
const LOG_SPARQL  = process.env.LOG_SPARQL            === 'true'
const LOG_PROMPTS = process.env.LOG_PROMPTS           === 'true'

// --- Mutable dataset state ----------------------------------------------------
// module-level lets so POST /dataset can hot-swap them at runtime

let DATASET        = parseDatasetArg() ?? process.env.JENA_DATASET ?? 'ds'
let JENA_SPARQL    = process.env.JENA_ENDPOINT ?? `${JENA_BASE}/${DATASET}/sparql`
let JENA_UPDATE    = `${JENA_BASE}/${DATASET}/update`
let JENA_GSP       = `${JENA_BASE}/${DATASET}/data`
let SHACL_GRAPH    = process.env.SHACL_GRAPH ?? `urn:${DATASET}:shacl`
let SHACL_REQUIRED = process.env.SHACL_REQUIRED === 'true'

/** IRI of the named-queries graph for the active dataset. */
function namedQueriesGraphIri() { return `urn:${DATASET}:named-queries` }

// --- Context directory helpers ------------------------------------------------

/**
 * Sanitise a Jena base URL into a safe directory name.
 *   'http://localhost:3030'        -> 'localhost-3030'
 *   'https://kurtcagle.ngrok.io'   -> 'kurtcagle.ngrok.io'
 */
function serverDirName(base) {
  return base
    .replace(/^https?:\/\//, '')   // strip scheme
    .replace(/:/g, '-')            // colons -> dashes (port separator)
    .replace(/\/+$/, '')           // trailing slash
}

/** Full path to the context directory for the active server + dataset. */
function getContextDir() {
  return join('./context', serverDirName(JENA_BASE), DATASET)
}

// --- Startup state ------------------------------------------------------------

let schemaContext = ''
let databookIds   = []
let namedQueries  = []
let namedGraphs   = []
let activeWatcher = null   // chokidar FSWatcher for the active context dir

// --- Helpers ------------------------------------------------------------------

function rebuildEndpoints(dataset, base) {
  DATASET     = dataset
  if (base) JENA_BASE = base.replace(/\/+$/, '')   // strip trailing slash
  JENA_SPARQL = process.env.JENA_ENDPOINT ?? `${JENA_BASE}/${DATASET}/sparql`
  JENA_UPDATE = `${JENA_BASE}/${DATASET}/update`
  JENA_GSP    = `${JENA_BASE}/${DATASET}/data`
  SHACL_GRAPH = process.env.SHACL_GRAPH  ?? `urn:${DATASET}:shacl`
}

// --- Context loader -----------------------------------------------------------

function parseNamedQueries(db) {
  const raw = db.block('named-queries')
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.map(q => ({ ...q, source: 'filesystem' }))
    return []
  } catch (_) {
    return [{ id: 'query-templates', description: 'Query templates (raw text)', sparql: raw, source: 'filesystem' }]
  }
}

/**
 * Load named queries from the RDF graph `urn:{DATASET}:named-queries`.
 * Each hb:NamedQuery must have dcterms:identifier and hb:sparql at minimum.
 * Returns [] gracefully if the graph is empty or Jena is unreachable.
 */
async function loadNamedQueriesFromGraph() {
  const graphIri = namedQueriesGraphIri()
  const sparql = `
PREFIX hb:      <https://w3id.org/holonbridge/>
PREFIX dcterms: <http://purl.org/dc/terms/>

SELECT ?id ?label ?description ?sparql ?targetGraph
WHERE {
  GRAPH <${graphIri}> {
    ?query a hb:NamedQuery ;
           dcterms:identifier ?id ;
           hb:sparql          ?sparql .
    OPTIONAL { ?query dcterms:title       ?label }
    OPTIONAL { ?query dcterms:description ?description }
    OPTIONAL { ?query hb:targetGraph      ?targetGraph }
  }
}
ORDER BY ?id`
  try {
    const { bindings } = await runQuery(JENA_SPARQL, sparql, LOG_SPARQL)
    const queries = bindings
      .map(r => ({
        id:          r.id?.value          ?? '',
        label:       r.label?.value       ?? r.id?.value ?? '',
        description: r.description?.value ?? '',
        sparql:      r.sparql?.value      ?? '',
        targetGraph: r.targetGraph?.value ?? null,
        source:      'rdf'
      }))
      .filter(q => q.id && q.sparql)
    console.log(`[Bridge] Loaded ${queries.length} named quer${queries.length === 1 ? 'y' : 'ies'} from <${graphIri}>`)
    return queries
  } catch (err) {
    console.warn(`[Bridge] No named queries from <${graphIri}>: ${err.message}`)
    return []
  }
}

async function loadContext() {
  const dir = getContextDir()
  const db  = await loadDataBookFromDir(dir)

  schemaContext = db.context(
    'prefix-registry',
    'class-index',
    'property-index',
    'nl-hints'
  )

  const templates = db.block('query-templates')
  if (templates) {
    schemaContext += `\n\nQUERY TEMPLATES (prefer these for matching question types):\n${templates}`
  }

  // Merge named queries: RDF graph is canonical; filesystem fills gaps for IDs not in RDF.
  const fsQueries  = parseNamedQueries(db)
  const rdfQueries = await loadNamedQueriesFromGraph()
  const rdfIds     = new Set(rdfQueries.map(q => q.id))
  namedQueries     = [...rdfQueries, ...fsQueries.filter(q => !rdfIds.has(q.id))]

  databookIds  = db.ids()
  console.log(`[Bridge] Context loaded from ${dir} -- ${schemaContext.length} chars, ${namedQueries.length} named queries (${rdfQueries.length} RDF, ${fsQueries.length} filesystem)`)

  namedGraphs = await discoverGraphs(JENA_SPARQL)
}

// --- Filesystem watcher -------------------------------------------------------

/**
 * Watch the active context directory for .databook.md changes and auto-reload.
 * Replaces any previous watcher (called on startup and on POST /dataset).
 */
function startWatcher() {
  if (activeWatcher) {
    activeWatcher.close()
    activeWatcher = null
  }

  const dir     = getContextDir()
  const pattern = join(dir, '**', '*.databook.md')

  activeWatcher = chokidar.watch(pattern, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }
  })

  activeWatcher.on('all', (event, filePath) => {
    console.log(`[Bridge] Context file ${event}: ${filePath} -- auto-reloading...`)
    loadContext().catch(err => console.error('[Bridge] Auto-reload failed:', err.message))
  })

  console.log(`[Bridge] Watching context dir: ${dir}`)
  return activeWatcher
}

// --- Query pipeline -----------------------------------------------------------

async function runPipeline(nlQuery) {
  let query            = ''
  let retries          = 0
  let vars             = []
  let bindings         = []
  let formattedResults = '(no results)'

  query = await buildQuery(nlQuery, schemaContext, namedGraphs, MODEL, LOG_PROMPTS)

  if (query === 'UNANSWERABLE') {
    return {
      answer: 'This question cannot be answered from the knowledge graph with the current schema.',
      sparql: null, bindings: [], vars: [], formattedResults: '(unanswerable)', retries: 0
    }
  }

  let lastError = null
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      ;({ vars, bindings } = await runQuery(JENA_SPARQL, query, LOG_SPARQL))
      lastError = null
      break
    } catch (err) {
      lastError = err
      retries++
      if (attempt < MAX_RETRIES) {
        console.warn(`[Bridge] Jena error (attempt ${attempt + 1}): ${err.jenaMessage?.slice(0, 200)}`)
        query = await retryQuery(nlQuery, query, err.jenaMessage ?? err.message,
                                 schemaContext, namedGraphs, MODEL, LOG_PROMPTS)
      }
    }
  }

  if (lastError) {
    return {
      answer: `Query execution failed after ${retries} attempt(s). The graph may not contain matching data.`,
      sparql: query, bindings: [], vars: [],
      formattedResults: `(query failed: ${lastError.jenaMessage ?? lastError.message})`,
      retries, error: lastError.jenaMessage ?? lastError.message
    }
  }

  formattedResults = formatBindings(vars, bindings)
  const answer     = await interpretResults(nlQuery, formattedResults, MODEL, LOG_PROMPTS)
  return { answer, sparql: query, bindings, vars, formattedResults, retries }
}

// --- Update pipeline ----------------------------------------------------------

async function runUpdate(turtle, graphIri, mode) {
  // -- SHACL gate (skipped when SHACL_REQUIRED=false) ------------------------
  let validation = { conforms: true, violations: [] }

  if (!SHACL_REQUIRED) {
    console.log('[Update] SHACL gate disabled (SHACL_REQUIRED=false) -- skipping validation')
  } else {
    let shaclCount
    try {
      shaclCount = await checkShaclGraph(JENA_SPARQL, SHACL_GRAPH)
    } catch (err) {
      return { updated: false, error: `Could not reach Jena to check SHACL graph: ${err.message}`,
               validation: { conforms: false, violations: [] } }
    }

    if (shaclCount === 0) {
      return { updated: false,
               error: `SHACL shapes graph <${SHACL_GRAPH}> is absent or empty -- update rejected. ` +
                      `Set SHACL_REQUIRED=false in .env to bypass, or load shapes first.`,
               validation: { conforms: false, violations: [] } }
    }

    console.log(`[Update] SHACL graph <${SHACL_GRAPH}> has ${shaclCount} triples -- proceeding`)

    try {
      validation = await validateWithShacl(JENA_BASE, DATASET, SHACL_GRAPH, turtle)
    } catch (err) {
      return { updated: false, error: `SHACL validation error: ${err.message}`,
               validation: { conforms: false, violations: [] } }
    }

    if (!validation.conforms) {
      console.warn(`[Update] SHACL validation failed -- ${validation.violations.length} violation(s)`)
      return { updated: false, error: 'SHACL validation failed -- no data written',
               validation, graph: graphIri, mode }
    }
  }

  try {
    const result = await pushToGraph(JENA_GSP, graphIri, turtle, mode)
    console.log(`[Update] Push succeeded -- HTTP ${result.status}, graph=${graphIri ?? 'default'}, mode=${mode}`)
    return { updated: true, graph: graphIri, mode, validation, jenaStatus: result.status }
  } catch (err) {
    return { updated: false, error: `Jena GSP push failed: ${err.jenaMessage ?? err.message}`,
             validation, graph: graphIri, mode }
  }
}

// --- Express app --------------------------------------------------------------

const app = express()
app.use(express.json({ limit: '10mb' }))

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// -- POST /query ---------------------------------------------------------------

app.post('/query', async (req, res) => {
  const { nl, queryId, format } = req.body ?? {}
  const asDataBook = format === 'databook'

  // -- Named query: execute stored SPARQL directly, bypass NL pipeline -----------
  if (queryId) {
    const nq = namedQueries.find(q => q.id === queryId)
    if (!nq) return res.status(404).json({ error: `Named query '${queryId}' not found.` })
    console.log(`[Bridge] Named query '${queryId}' (source: ${nq.source ?? 'unknown'})`)
    try {
      const { vars, bindings }  = await runQuery(JENA_SPARQL, nq.sparql, LOG_SPARQL)
      const formattedResults    = formatBindings(vars, bindings)
      const answer              = `Named query '${nq.label ?? queryId}' returned ${bindings.length} result(s).`
      const result              = { answer, sparql: nq.sparql, bindings, vars, formattedResults, retries: 0, queryId }
      if (asDataBook) {
        const doc = buildResponseDataBook({
          nlQuery: nq.description ?? queryId, sparql: nq.sparql, bindings, vars,
          formattedResults, answer, retries: 0, namedGraphs, model: MODEL,
          endpoint: JENA_SPARQL, error: null
        })
        return res.type('text/markdown')
          .set('Content-Disposition', `inline; filename="${queryId}.databook.md"`)
          .send(doc)
      }
      return res.json(result)
    } catch (err) {
      console.error(`[Bridge] Named query '${queryId}' failed:`, err)
      return res.status(500).json({ error: 'Named query execution failed', message: err.message })
    }
  }

  // -- NL pipeline ---------------------------------------------------------------
  let nlQuery
  if (nl && typeof nl === 'string' && nl.trim().length > 0) {
    nlQuery = nl.trim()
  } else {
    return res.status(400).json({ error: 'Request body must include a non-empty "nl" string or a valid "queryId".' })
  }

  console.log(`[Bridge] Query (format=${format ?? 'json'}): ${nlQuery}`)

  try {
    const result = await runPipeline(nlQuery)
    console.log(`[Bridge] Done -- retries: ${result.retries}, bindings: ${result.bindings.length}`)

    if (asDataBook) {
      const doc = buildResponseDataBook({
        nlQuery, sparql: result.sparql, bindings: result.bindings, vars: result.vars,
        formattedResults: result.formattedResults, answer: result.answer,
        retries: result.retries, namedGraphs, model: MODEL,
        endpoint: JENA_SPARQL, error: result.error
      })
      return res.type('text/markdown')
        .set('Content-Disposition', 'inline; filename="query-debug.databook.md"')
        .send(doc)
    }

    return res.json(result)
  } catch (err) {
    console.error('[Bridge] Unhandled pipeline error:', err)
    return res.status(500).json({ error: 'Internal bridge error', message: err.message })
  }
})

// -- POST /update --------------------------------------------------------------

app.post('/update', async (req, res) => {
  const { turtle, graph, mode = 'append' } = req.body ?? {}

  if (!turtle || typeof turtle !== 'string' || turtle.trim().length === 0)
    return res.status(400).json({ error: 'Request body must include a non-empty "turtle" string.' })

  if (!['append', 'replace'].includes(mode))
    return res.status(400).json({ error: '"mode" must be "append" or "replace".' })

  const graphIri = (graph && typeof graph === 'string' && graph.trim().length > 0)
    ? graph.trim() : null

  console.log(`[Bridge] Update -- graph=${graphIri ?? 'default'}, mode=${mode}, ${turtle.length} chars`)

  try {
    const result = await runUpdate(turtle, graphIri, mode)
    if (!result.updated) {
      const status = result.validation?.conforms === false && result.validation?.violations?.length > 0 ? 422 : 409
      return res.status(status).json(result)
    }
    return res.json(result)
  } catch (err) {
    console.error('[Bridge] Unhandled update error:', err)
    return res.status(500).json({ error: 'Internal bridge error', message: err.message })
  }
})

// -- POST /sparql-update -------------------------------------------------------

app.post('/sparql-update', async (req, res) => {
  const { update } = req.body ?? {}

  if (!update || typeof update !== 'string' || update.trim().length === 0)
    return res.status(400).json({ error: 'Request body must include a non-empty "update" string.' })

  console.log(`[Bridge] SPARQL UPDATE (${update.length} chars)`)
  if (LOG_SPARQL) console.log(update)

  try {
    const controller = new AbortController()
    const timer      = setTimeout(() => controller.abort(), 30_000)
    let response
    try {
      response = await fetch(JENA_UPDATE, {
        method: 'POST', headers: { 'Content-Type': 'application/sparql-update' },
        body: update, signal: controller.signal
      })
    } finally { clearTimeout(timer) }

    const body = await response.text()
    if (!response.ok)
      return res.status(502).json({ updated: false,
        error: `Jena UPDATE returned HTTP ${response.status}: ${body.slice(0, 300)}` })

    console.log(`[Bridge] SPARQL UPDATE succeeded -- HTTP ${response.status}`)
    return res.json({ updated: true, status: response.status })
  } catch (err) {
    console.error('[Bridge] SPARQL UPDATE error:', err)
    return res.status(500).json({ updated: false, error: err.message })
  }
})

// -- POST /reload --------------------------------------------------------------

app.post('/reload', async (_req, res) => {
  console.log('[Bridge] /reload requested...')
  try {
    await loadContext()
    return res.json({
      reloaded: true, contextDir: getContextDir(),
      schemaChars: schemaContext.length,
      namedGraphs: namedGraphs.length,
      namedQueries: namedQueries.length,
      databookBlocks: databookIds
    })
  } catch (err) {
    console.error('[Bridge] Reload failed:', err.message)
    return res.status(500).json({ reloaded: false, error: err.message })
  }
})

// -- POST /dataset -------------------------------------------------------------
//
// Switch the active Fuseki dataset at runtime.
// Rebuilds all derived endpoint URLs, restarts the filesystem watcher on the
// new context directory, and reloads the schema context.
// Rolls back to the previous dataset if context load fails.

app.post('/dataset', async (req, res) => {
  const { dataset, fusekiUrl } = req.body ?? {}

  if (!dataset || typeof dataset !== 'string' || !dataset.trim())
    return res.status(400).json({ error: 'Request body must include a non-empty "dataset" string.' })

  if (fusekiUrl !== undefined) {
    try { new URL(fusekiUrl) } catch {
      return res.status(400).json({ error: '"fusekiUrl" is not a valid URL.' })
    }
  }

  const prevDataset = DATASET
  const prevBase    = JENA_BASE
  rebuildEndpoints(dataset.trim(), fusekiUrl)
  console.log(`[Bridge] Dataset switched: ${prevDataset} -> ${DATASET}`)
  if (fusekiUrl) console.log(`[Bridge] Fuseki base changed: ${prevBase} -> ${JENA_BASE}`)
  console.log(`[Bridge] Context dir: ${getContextDir()}`)

  try {
    await loadContext()
    startWatcher()   // restart watcher on new context directory
    return res.json({
      dataset:        DATASET,
      jenaBase:       JENA_BASE,
      contextDir:     getContextDir(),
      sparqlEndpoint: JENA_SPARQL,
      gspEndpoint:    JENA_GSP,
      shaclGraph:     SHACL_GRAPH,
      schemaChars:    schemaContext.length,
      namedGraphs:    namedGraphs.length,
      namedQueries:   namedQueries.length,
      databookBlocks: databookIds
    })
  } catch (err) {
    console.error(`[Bridge] Context load failed after dataset switch, rolling back to ${prevDataset}:`, err.message)
    rebuildEndpoints(prevDataset, prevBase)
    await loadContext().catch(() => {})
    startWatcher()
    return res.status(500).json({
      error:               `Failed to load context for dataset "${dataset.trim()}": ${err.message}`,
      rolledBackTo:        prevDataset,
      jenaBaseRolledBackTo: prevBase
    })
  }
})

// -- POST /fuseki-url ----------------------------------------------------------
//
// Change the Fuseki base URL (and optionally the dataset) at runtime.
// Useful for pointing HolonBridge at a different Fuseki instance without
// restarting the service (e.g. switching from localhost to a Tailscale peer).
//
// Request:  { "url": "http://100.106.176.165:3030" }
//   or:     { "url": "http://100.106.176.165:3030", "dataset": "ggsc" }
// Response: { "updated": true, "jenaBase": "...", "dataset": "...", ... }
//           { "updated": true, "warning": "...", ... }  -- if ping fails (non-fatal)

app.post('/fuseki-url', async (req, res) => {
  const { url, dataset } = req.body ?? {}

  if (!url || typeof url !== 'string' || !url.trim())
    return res.status(400).json({ error: 'Request body must include a non-empty "url" string.' })

  try { new URL(url) } catch {
    return res.status(400).json({ error: '"url" is not a valid URL.' })
  }

  const prevBase    = JENA_BASE
  const prevDataset = DATASET
  rebuildEndpoints(dataset?.trim() ?? DATASET, url.trim())
  console.log(`[Bridge] Fuseki base changed: ${prevBase} -> ${JENA_BASE}`)
  if (dataset) console.log(`[Bridge] Dataset changed: ${prevDataset} -> ${DATASET}`)

  // Ping the new Fuseki -- non-fatal; caller may be setting up a tunnel
  let warning = null
  try {
    const ping = await fetch(`${JENA_BASE}/$/ping`, { signal: AbortSignal.timeout(4_000) })
    if (!ping.ok) warning = `Fuseki ping returned HTTP ${ping.status} -- verify the host is running`
    else console.log(`[Bridge] Fuseki ping OK at ${JENA_BASE}`)
  } catch (err) {
    warning = `Fuseki not reachable at ${JENA_BASE}: ${err.message} -- endpoints updated but Jena may be offline`
    console.warn(`[Bridge] ${warning}`)
  }

  try {
    await loadContext()
    startWatcher()
  } catch (err) {
    console.warn(`[Bridge] Context load failed after Fuseki URL change: ${err.message} -- continuing with empty context`)
  }

  const payload = {
    updated:        true,
    jenaBase:       JENA_BASE,
    dataset:        DATASET,
    sparqlEndpoint: JENA_SPARQL,
    gspEndpoint:    JENA_GSP,
    shaclGraph:     SHACL_GRAPH,
    namedGraphs:    namedGraphs.length,
    namedQueries:   namedQueries.length,
  }
  if (warning) payload.warning = warning
  return res.json(payload)
})

// -- GET /datasets -------------------------------------------------------------

app.get('/datasets', async (_req, res) => {
  const adminUrl = `${JENA_BASE}/$/datasets`
  try {
    const controller = new AbortController()
    const timer      = setTimeout(() => controller.abort(), 10_000)
    let response
    try {
      response = await fetch(adminUrl, { headers: { 'Accept': 'application/json' }, signal: controller.signal })
    } finally { clearTimeout(timer) }

    if (!response.ok) {
      const body = await response.text()
      return res.status(502).json({ error: `Fuseki admin API returned HTTP ${response.status}: ${body.slice(0, 200)}` })
    }

    const json     = await response.json()
    const datasets = (json.datasets ?? []).map(ds => ({
      name:   (ds['ds.name'] ?? ds.name ?? '(unknown)').replace(/^\//, ''),
      type:   ds['ds.type'] ?? ds.type ?? 'unknown',
      active: (ds['ds.name'] ?? ds.name ?? '').replace(/^\//, '') === DATASET
    }))

    return res.json({ datasets, active: DATASET })
  } catch (err) {
    if (err.name === 'AbortError')
      return res.status(504).json({ error: 'Fuseki admin API timed out.' })
    return res.status(503).json({ error: `Could not reach Fuseki admin API at ${adminUrl}: ${err.message}` })
  }
})

// -- GET /description ----------------------------------------------------------

app.get('/description', async (_req, res) => {
  let shaclTriples = null
  try { shaclTriples = await checkShaclGraph(JENA_SPARQL, SHACL_GRAPH) } catch (_) {}

  res.json({
    service: 'holon-bridge', version: '2.5.0',
    dataset: DATASET, contextDir: getContextDir(),
    jenaBase: JENA_BASE, sparqlEndpoint: JENA_SPARQL,
    gspEndpoint: JENA_GSP, shaclGraph: SHACL_GRAPH,
    shaclTriples, model: MODEL, maxRetries: MAX_RETRIES,
    operations: [
      { method: 'POST', path: '/query',          description: 'NL -> SPARQL -> interpreted answer. Or { queryId } to execute a stored named query directly.' },
      { method: 'POST', path: '/sparql-select',  description: 'Direct SPARQL SELECT/ASK/CONSTRUCT/DESCRIBE — bypasses NL pipeline entirely. Body: { "sparql": "..." }. Returns bindings for SELECT/ASK, Turtle for CONSTRUCT/DESCRIBE.' },
      { method: 'POST', path: '/update',         description: 'SHACL-gated Turtle push to a named graph.' },
      { method: 'POST', path: '/sparql-update',  description: 'Raw SPARQL UPDATE (INSERT/DELETE/etc) — no validation gate.' },
      { method: 'POST', path: '/reload',         description: 'Reload context directory + named queries (RDF + filesystem) + rediscover named graphs.' },
      { method: 'POST', path: '/dataset',        description: 'Switch active dataset at runtime. Accepts optional "fusekiUrl" to change Fuseki host in the same call. Restarts context watcher. Body: { "dataset": "name", "fusekiUrl"?: "http://..." }.' },
      { method: 'POST', path: '/fuseki-url',     description: 'Change the Fuseki base URL at runtime without restarting. Pings the new host; warns but does not roll back if unreachable. Body: { "url": "http://...", "dataset"?: "name" }.' },
      { method: 'POST', path: '/shacl-mode',     description: 'Toggle SHACL validation gate at runtime. Body: { "required": true|false }.' },
      { method: 'POST', path: '/named-query',    description: 'Register, update, or delete a named query in the RDF graph urn:{dataset}:named-queries. Body: { id, label?, description?, sparql, targetGraph? } or { id, delete: true }.' },
      { method: 'GET',  path: '/datasets',       description: 'List all datasets available on the Fuseki server.' },
      { method: 'GET',  path: '/graphs',         description: 'Live query: list all named graphs in the active dataset with triple counts.' },
      { method: 'GET',  path: '/graph',          description: 'Fetch RDF content of a single named graph via GSP. Query params: iri=<encoded IRI>, format=turtle|trig.' },
      { method: 'GET',  path: '/named-queries',  description: 'List all registered named queries with source (rdf|filesystem).' },
      { method: 'GET',  path: '/description',    description: 'Capability manifest for LLM consumption (this endpoint).' },
      { method: 'GET',  path: '/health',         description: 'Liveness check.' }
    ],
    namedQueriesGraph: namedQueriesGraphIri(),
    namedQueries, namedGraphs, databookBlocks: databookIds,
    shacl: {
      graph: SHACL_GRAPH, tripleCount: shaclTriples,
      required: SHACL_REQUIRED,
      note: !SHACL_REQUIRED
        ? 'SHACL gate disabled (SHACL_REQUIRED=false) -- /update pushes without validation. Enable via POST /shacl-mode.'
        : shaclTriples === 0
          ? 'WARNING: SHACL shapes graph is empty -- /update will be rejected until shapes are loaded. Disable gate via POST /shacl-mode.'
          : shaclTriples === null
            ? 'SHACL triple count unavailable (Jena unreachable at description time).'
            : `${shaclTriples} shape triples loaded -- /update is armed.`
    },
    agentHints: [
      'Call GET /description at session start to orient yourself.',
      'Call GET /datasets to see available datasets, then POST /dataset to switch.',
      'Context is automatically reloaded when files change in the active context directory.',
      `Active context directory: context/${serverDirName(JENA_BASE)}/${DATASET}/`,
      `The SHACL shapes graph IRI is <${SHACL_GRAPH}>.`
    ]
  })
})

// -- GET /health ---------------------------------------------------------------

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok', service: 'holon-bridge', version: '2.5.0',
    dataset: DATASET, contextDir: getContextDir(),
    sparqlEndpoint: JENA_SPARQL, gspEndpoint: JENA_GSP,
    shaclGraph: SHACL_GRAPH, model: MODEL,
    databookBlocks: databookIds, namedGraphs, maxRetries: MAX_RETRIES
  })
})

// -- POST /shacl-mode ---------------------------------------------------------
//
// Toggle SHACL validation gate at runtime without restarting the bridge.
//
// Request:  { "required": true|false }
// Response: { "shaclRequired": boolean, "shaclGraph": "...", "message": "..." }

app.post('/shacl-mode', (req, res) => {
  const { required } = req.body ?? {}
  if (typeof required !== 'boolean')
    return res.status(400).json({ error: '"required" must be a boolean.' })

  SHACL_REQUIRED = required
  const msg = SHACL_REQUIRED
    ? `SHACL gate enabled -- /update requires shapes in <${SHACL_GRAPH}>.`
    : `SHACL gate disabled -- /update will push without validation.`
  console.log(`[Bridge] /shacl-mode: ${msg}`)
  return res.json({ shaclRequired: SHACL_REQUIRED, shaclGraph: SHACL_GRAPH, message: msg })
})

// -- POST /named-query ---------------------------------------------------------
//
// Register, update, or delete a named query in the RDF named-queries graph.
//
// Register/update: { "id": "...", "label": "...", "description": "...", "sparql": "...", "targetGraph": "..." }
// Delete:          { "id": "...", "delete": true }

app.post('/named-query', async (req, res) => {
  const { id, label, description, sparql, targetGraph, delete: del } = req.body ?? {}

  if (!id || typeof id !== 'string' || !id.trim())
    return res.status(400).json({ error: '"id" is required.' })

  const graphIri  = namedQueriesGraphIri()
  const queryNode = `<https://w3id.org/holonbridge/query/${encodeURIComponent(id.trim())}>`

  // -- Delete -------------------------------------------------------------------
  if (del) {
    const update = `DELETE WHERE { GRAPH <${graphIri}> { ${queryNode} ?p ?o } }`
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)
      let response
      try {
        response = await fetch(JENA_UPDATE, {
          method: 'POST', headers: { 'Content-Type': 'application/sparql-update' },
          body: update, signal: controller.signal
        })
      } finally { clearTimeout(timer) }
      if (!response.ok) throw new Error(`Jena UPDATE ${response.status}`)
      await loadContext()   // refresh in-memory registry
      console.log(`[Bridge] Named query '${id}' deleted from <${graphIri}>`)
      return res.json({ deleted: true, id, graph: graphIri })
    } catch (err) {
      return res.status(500).json({ deleted: false, error: err.message })
    }
  }

  // -- Register / update --------------------------------------------------------
  if (!sparql || typeof sparql !== 'string' || !sparql.trim())
    return res.status(400).json({ error: '"sparql" is required for registration.' })

  const escape = s => s.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"')
  const HB      = 'https://w3id.org/holonbridge/'
  const DCTERMS = 'http://purl.org/dc/terms/'

  const optionals = [
    label       ? `    <${DCTERMS}title>       """${escape(label)}""" ;`       : null,
    description ? `    <${DCTERMS}description> """${escape(description)}""" ;` : null,
    targetGraph ? `    <${HB}targetGraph>      <${targetGraph}> ;`             : null,
  ].filter(Boolean).join('\n')

  const turtleData = `${queryNode} a <${HB}NamedQuery> ;
    <${DCTERMS}identifier> """${escape(id.trim())}""" ;
${optionals}
    <${HB}sparql>          """${escape(sparql.trim())}""" .`

  // Use full URIs throughout — no PREFIX allowed inside INSERT DATA blocks
  const update = `DELETE WHERE { GRAPH <${graphIri}> { ${queryNode} ?p ?o } } ;
INSERT DATA { GRAPH <${graphIri}> { ${turtleData} } }`

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    let response
    try {
      response = await fetch(JENA_UPDATE, {
        method: 'POST', headers: { 'Content-Type': 'application/sparql-update' },
        body: update, signal: controller.signal
      })
    } finally { clearTimeout(timer) }
    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Jena UPDATE ${response.status}: ${body.slice(0, 200)}`)
    }
    await loadContext()   // refresh in-memory registry
    console.log(`[Bridge] Named query '${id}' registered in <${graphIri}>`)
    return res.json({ registered: true, id, graph: graphIri, source: 'rdf' })
  } catch (err) {
    console.error('[Bridge] /named-query error:', err)
    return res.status(500).json({ registered: false, error: err.message })
  }
})

// -- GET /named-queries --------------------------------------------------------

app.get('/named-queries', (_req, res) => {
  const rdf = namedQueries.filter(q => q.source === 'rdf')
  const fs  = namedQueries.filter(q => q.source === 'filesystem')
  return res.json({
    graph:      namedQueriesGraphIri(),
    total:      namedQueries.length,
    rdf:        rdf.length,
    filesystem: fs.length,
    queries:    namedQueries.map(({ id, label, description, targetGraph, source }) =>
                  ({ id, label, description, targetGraph, source }))
  })
})

// -- POST /sparql-select -------------------------------------------------------
//
// Execute a raw SPARQL SELECT, ASK, DESCRIBE, or CONSTRUCT query directly
// against Fuseki, bypassing the NL pipeline and LLM entirely.
// Designed for programmatic/agent callers that know exactly what they want.
//
// SELECT/ASK: { "sparql": "SELECT ...", "format"?: "json"|"databook" }
//   -> { vars, bindings, formattedResults, count }
//
// CONSTRUCT/DESCRIBE: { "sparql": "CONSTRUCT ..." }
//   -> text/turtle response body

app.post('/sparql-select', async (req, res) => {
  const { sparql, format } = req.body ?? {}

  if (!sparql || typeof sparql !== 'string' || !sparql.trim())
    return res.status(400).json({ error: 'Request body must include a non-empty "sparql" string.' })

  const query      = sparql.trim()
  const asDataBook = format === 'databook'
  const upperQ     = query.replace(/^\s*(#[^\n]*\n\s*)*/i, '').toUpperCase()
  const isConstruct = /^\s*(CONSTRUCT|DESCRIBE)/i.test(upperQ)

  console.log(`[Bridge] /sparql-select (${query.length} chars, ${isConstruct ? 'CONSTRUCT/DESCRIBE' : 'SELECT/ASK'})`)
  if (LOG_SPARQL) console.log(query)

  try {
    if (isConstruct) {
      // CONSTRUCT / DESCRIBE -- return Turtle directly
      const controller = new AbortController()
      const timer      = setTimeout(() => controller.abort(), 30_000)
      let response
      try {
        response = await fetch(JENA_SPARQL, {
          method:  'POST',
          headers: { 'Content-Type': 'application/sparql-query', 'Accept': 'text/turtle' },
          body:    query,
          signal:  controller.signal
        })
      } finally { clearTimeout(timer) }

      const turtle = await response.text()
      if (!response.ok)
        return res.status(502).json({ error: `Fuseki returned HTTP ${response.status}: ${turtle.slice(0, 300)}` })
      return res.type('text/turtle').send(turtle)
    }

    // SELECT / ASK
    const { vars, bindings } = await runQuery(JENA_SPARQL, query, LOG_SPARQL)
    const formattedResults   = formatBindings(vars, bindings)

    if (asDataBook) {
      const doc = buildResponseDataBook({
        nlQuery: '(direct SPARQL query)', sparql: query, bindings, vars,
        formattedResults,
        answer:  `Direct query returned ${bindings.length} result(s).`,
        retries: 0, namedGraphs, model: MODEL, endpoint: JENA_SPARQL, error: null
      })
      return res.type('text/markdown')
        .set('Content-Disposition', 'inline; filename="sparql-select.databook.md"')
        .send(doc)
    }

    return res.json({ vars, bindings, formattedResults, count: bindings.length })
  } catch (err) {
    if (err instanceof SparqlError)
      return res.status(400).json({
        error:   'SPARQL execution error',
        message: err.jenaMessage ?? err.message,
        sparql:  query
      })
    console.error('[Bridge] /sparql-select error:', err)
    return res.status(500).json({ error: 'Internal bridge error', message: err.message })
  }
})

// -- GET /graphs ---------------------------------------------------------------
//
// Live query: list all named graphs in the active dataset with triple counts.
// Unlike the cached list in /health, this always reflects current Fuseki state.
//
// Response: { dataset, graphs: [{ iri, triples }], total }

app.get('/graphs', async (_req, res) => {
  const sparql = `
SELECT ?g (COUNT(*) AS ?triples)
WHERE { GRAPH ?g { ?s ?p ?o } }
GROUP BY ?g
ORDER BY ?g`

  try {
    const { bindings } = await runQuery(JENA_SPARQL, sparql, LOG_SPARQL)
    const graphs = bindings.map(b => ({
      iri:     b.g?.value      ?? '(unknown)',
      triples: parseInt(b.triples?.value ?? '0', 10)
    }))
    return res.json({ dataset: DATASET, graphs, total: graphs.length })
  } catch (err) {
    console.error('[Bridge] /graphs error:', err)
    return res.status(500).json({ error: `Could not query named graphs: ${err.message}` })
  }
})

// -- GET /graph ----------------------------------------------------------------
//
// Fetch the full RDF content of a single named graph via GSP.
// Returns Turtle by default; append ?format=trig for TriG.
//
// Query params:
//   iri    (required) -- the graph IRI, URL-encoded
//   format (optional) -- "turtle" (default) or "trig"
//
// Example: GET /graph?iri=https%3A%2F%2Fw3id.org%2Fggsc%2Fchloe%2Fpersons

app.get('/graph', async (req, res) => {
  const { iri, format = 'turtle' } = req.query

  if (!iri || typeof iri !== 'string' || !iri.trim())
    return res.status(400).json({ error: 'Query parameter "iri" is required.' })

  const acceptType = format === 'trig' ? 'application/trig' : 'text/turtle'
  const gspUrl     = `${JENA_GSP}?graph=${encodeURIComponent(iri.trim())}`

  console.log(`[Bridge] GSP fetch: <${iri}>`)
  try {
    const controller = new AbortController()
    const timer      = setTimeout(() => controller.abort(), 30_000)
    let response
    try {
      response = await fetch(gspUrl, {
        headers: { 'Accept': acceptType },
        signal:  controller.signal
      })
    } finally { clearTimeout(timer) }

    const body = await response.text()
    if (response.status === 404)
      return res.status(404).json({ error: `Named graph <${iri}> not found in dataset '${DATASET}'.` })
    if (!response.ok)
      return res.status(502).json({ error: `Fuseki GSP returned HTTP ${response.status}: ${body.slice(0, 300)}` })

    return res.type(acceptType).send(body)
  } catch (err) {
    if (err.name === 'AbortError')
      return res.status(504).json({ error: 'Fuseki GSP request timed out.' })
    console.error('[Bridge] /graph error:', err)
    return res.status(500).json({ error: `GSP fetch failed: ${err.message}` })
  }
})

// -- 404 fallback --------------------------------------------------------------

app.use((_req, res) => {
  res.status(404).json({
    error: 'Not found.',
    available: [
      'POST /query', 'POST /update', 'POST /sparql-update', 'POST /sparql-select',
      'POST /reload', 'POST /dataset', 'POST /fuseki-url', 'POST /shacl-mode', 'POST /named-query',
      'GET  /datasets', 'GET  /graphs', 'GET  /graph', 'GET  /named-queries',
      'GET  /description', 'GET  /health'
    ]
  })
})

// --- Start --------------------------------------------------------------------

loadContext()
  .then(() => {
    startWatcher()
    app.listen(PORT, () => {
      console.log(`[Bridge] HolonBridge v2.5.0 running on port ${PORT}`)
      console.log(`[Bridge] Dataset:        ${DATASET}`)
      console.log(`[Bridge] Context dir:    ${getContextDir()}`)
      console.log(`[Bridge] SPARQL:         ${JENA_SPARQL}`)
      console.log(`[Bridge] GSP:            ${JENA_GSP}`)
      console.log(`[Bridge] SHACL graph:    ${SHACL_GRAPH}`)
      console.log(`[Bridge] Model:          ${MODEL}  Max retries: ${MAX_RETRIES}`)
    })
  })
  .catch(err => {
    console.error('[Bridge] Failed to load schema context:', err.message)
    process.exit(1)
  })