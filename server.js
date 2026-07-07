/**
 * server.js -- HolonBridge v2.9.0
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

// -- Startup secret validation ------------------------------------------------
// Secrets must be set as OS environment variables, not in .env
// Non-sensitive config (ports, URLs, flags) may still use .env via dotenv
// Fail fast with a clear message rather than running in an insecure state

const REQUIRED_SECRETS = ['BEARER_TOKEN', 'ANTHROPIC_API_KEY']
const MISSING_SECRETS  = REQUIRED_SECRETS.filter(k => !process.env[k]?.trim())

if (MISSING_SECRETS.length > 0) {
  for (const k of MISSING_SECRETS) {
    console.error(`[Bridge] FATAL: Required secret '${k}' is not set in the environment.`)
  }
  console.error('[Bridge] Secrets must be set as OS environment variables, not in .env')
  console.error('[Bridge] Run: node scripts/setup-env.js  to configure interactively')
  process.exit(1)
}

import express          from 'express'
import chokidar         from 'chokidar'
import { join }         from 'path'
import { randomUUID }   from 'node:crypto'

// Patch console to prefix every log line with an ISO timestamp
;['log', 'warn', 'error'].forEach(method => {
  const orig = console[method].bind(console)
  console[method] = (...args) => orig(`[${new Date().toISOString()}]`, ...args)
})

import { loadDataBookFromDir }                                      from './lib/databook.js'
import { runQuery, formatBindings, discoverGraphs,
         checkShaclGraph, pushToGraph, SparqlError }               from './lib/sparql.js'
import { buildQuery, retryQuery, interpretResults }                 from './lib/llm.js'
import { buildResponseDataBook }                                    from './lib/format.js'
import { validateWithShacl }                                        from './lib/shacl.js'
import { validateHandler }                                          from './lib/validate.js'
import { getHolonHandler }                                          from './lib/holon.js'
import { loadSessionState, saveSessionState }                        from './lib/session-state.js'
import { initSession, loadRegistryCache,
         resolveEndpoints, probeReachability,
         GRAPHS as REGISTRY_GRAPHS }                                from './registry/session-init.js'
import registerOAuth                                                from './oauth.js'

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

// --- Persisted session state ---------------------------------------------------
//
// Read before anything else derives its config. Precedence (highest to
// lowest): CLI arg / explicit env var > persisted session state (last
// known values from before the most recent restart) > hardcoded default.
// See lib/session-state.js for why this exists and why it's a local file
// rather than a Fuseki graph.

const sessionState = loadSessionState()
if (Object.keys(sessionState).length > 0) {
  console.log(`[Bridge] Restored session state from disk (last updated ${sessionState.updatedAt ?? 'unknown'}): ` +
    `dataset=${sessionState.dataset ?? '(none)'}, jenaBase=${sessionState.jenaBase ?? '(none)'}, ` +
    `shaclRequired=${sessionState.shaclRequired ?? '(none)'}`)
}

// --- Config -------------------------------------------------------------------

const PORT        = parseInt(process.env.PORT        ?? '3031', 10)
let   JENA_BASE   = process.env.JENA_BASE             ?? sessionState.jenaBase ?? 'http://localhost:3030'
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES ?? '2', 10)
const MODEL       = process.env.CLAUDE_MODEL          ?? 'claude-sonnet-4-6'
const LOG_SPARQL  = process.env.LOG_SPARQL            === 'true'
const LOG_PROMPTS = process.env.LOG_PROMPTS           === 'true'

// --- Mutable dataset state ----------------------------------------------------
// module-level lets so POST /dataset can hot-swap them at runtime

let DATASET        = parseDatasetArg() ?? process.env.JENA_DATASET ?? sessionState.dataset ?? 'ds'
let JENA_SPARQL    = process.env.JENA_ENDPOINT ?? `${JENA_BASE}/${DATASET}/sparql`
let JENA_UPDATE    = `${JENA_BASE}/${DATASET}/update`
let JENA_GSP       = `${JENA_BASE}/${DATASET}/data`
let SHACL_GRAPH    = process.env.SHACL_GRAPH ?? `urn:${DATASET}:shacl`
let SHACL_REQUIRED = process.env.SHACL_REQUIRED !== undefined
  ? process.env.SHACL_REQUIRED === 'true'
  : (sessionState.shaclRequired ?? false)

/** IRI of the named-queries graph for the active dataset. */
function namedQueriesGraphIri() { return `urn:${DATASET}:named-queries` }
function namedRulesGraphIri()     { return `urn:${DATASET}:named-rules` }
function namedPipelinesGraphIri() { return `urn:${DATASET}:named-pipelines` }

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
let namedRules    = []   // non-canonical — pending WG IV alignment
let namedPipelines = []  // non-canonical — pending WG IV alignment
const messageStore = new Map() // in-memory message status; volatile on restart
let namedGraphs   = []
let activeWatcher = null   // chokidar FSWatcher for the active context dir

// --- Helpers ------------------------------------------------------------------

/**
 * Substitute {{paramName}} placeholders in a SPARQL string with caller-supplied
 * values. Substitution is raw string replacement — the query author is
 * responsible for placing placeholders in the correct SPARQL syntactic context
 * (inside quotes, angle brackets, etc.).
 *
 * Example named query SPARQL:
 *   FILTER(CONTAINS(LCASE(?jobTitle), LCASE("{{role}}")))
 *
 * Called with params: { role: "ontologist" } ->
 *   FILTER(CONTAINS(LCASE(?jobTitle), LCASE("ontologist")))
 *
 * IRI example:
 *   ?person foaf:gender <{{genderIRI}}> .
 * Called with params: { genderIRI: "http://xmlns.com/foaf/0.1/Female" }
 *
 * Returns { sparql, substituted, missing } where:
 *   sparql      -- the result string (may still have unresolved placeholders)
 *   substituted -- array of param names that were replaced
 *   missing     -- array of {{placeholders}} still present after substitution
 */
function substituteParams(sparql, params) {
  if (!params || typeof params !== 'object' || Object.keys(params).length === 0)
    return { sparql, substituted: [], missing: [] }

  let result = sparql
  const substituted = []

  for (const [key, value] of Object.entries(params)) {
    const placeholder = new RegExp(`\\{\\{${key}\\}\\}`, 'g')
    if (placeholder.test(result)) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value))
      substituted.push(key)
    }
  }

  // Detect any remaining unresolved placeholders
  const remaining = [...result.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[0])

  return { sparql: result, substituted, missing: remaining }
}

function rebuildEndpoints(dataset, base) {
  DATASET     = dataset
  if (base) JENA_BASE = base.replace(/\/+$/, '')   // strip trailing slash
  JENA_SPARQL = process.env.JENA_ENDPOINT ?? `${JENA_BASE}/${DATASET}/sparql`
  JENA_UPDATE = `${JENA_BASE}/${DATASET}/update`
  JENA_GSP    = `${JENA_BASE}/${DATASET}/data`
  SHACL_GRAPH = process.env.SHACL_GRAPH  ?? `urn:${DATASET}:shacl`
  // Write-through: persist immediately so a later restart (clean or not)
  // comes back up pointed at this dataset/base rather than silently
  // reverting to the hardcoded default. Called on both the happy path
  // (POST /dataset, POST /fuseki-url) and the rollback path (dataset
  // switch failure reverting to prevDataset/prevBase) -- both are the
  // currently-true active state and both deserve to survive a restart.
  saveSessionState({ dataset: DATASET, jenaBase: JENA_BASE })
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

SELECT ?id ?label ?description ?sparql ?targetGraph ?parameters
WHERE {
  GRAPH <${graphIri}> {
    ?query a hb:NamedQuery ;
           dcterms:identifier ?id ;
           hb:sparql          ?sparql .
    OPTIONAL { ?query dcterms:title       ?label }
    OPTIONAL { ?query dcterms:description ?description }
    OPTIONAL { ?query hb:targetGraph      ?targetGraph }
    OPTIONAL { ?query hb:parameters       ?parameters }
  }
}
ORDER BY ?id`
  try {
    const { bindings } = await runQuery(JENA_SPARQL, sparql, LOG_SPARQL)
    const queries = bindings
      .map(r => {
        let params = []
        if (r.parameters?.value) {
          try { params = JSON.parse(r.parameters.value) } catch (_) {}
        }
        return {
          id:          r.id?.value          ?? '',
          label:       r.label?.value       ?? r.id?.value ?? '',
          description: r.description?.value ?? '',
          sparql:      r.sparql?.value      ?? '',
          targetGraph: r.targetGraph?.value ?? null,
          params,
          source:      'rdf'
        }
      })
      .filter(q => q.id && q.sparql)
    console.log(`[Bridge] Loaded ${queries.length} named quer${queries.length === 1 ? 'y' : 'ies'} from <${graphIri}>`)
    return queries
  } catch (err) {
    console.warn(`[Bridge] No named queries from <${graphIri}>: ${err.message}`)
    return []
  }
}

/**
 * Load named rules from RDF graph `urn:{DATASET}:named-rules`.
 * Non-canonical implementation — pending WG IV alignment.
 */
async function loadNamedRulesFromGraph() {
  const graphIri = namedRulesGraphIri()
  const sparql = `
PREFIX hb:      <https://w3id.org/holonbridge/>
PREFIX dcterms: <http://purl.org/dc/terms/>
PREFIX sh:      <http://www.w3.org/ns/shacl#>

SELECT ?id ?label ?description ?sparql ?targetGraph ?sourceGraph
       ?writeMode ?ruleStatus ?parameters ?order
WHERE {
  GRAPH <${graphIri}> {
    ?rule a hb:NamedRule ;
          dcterms:identifier ?id ;
          hb:sparql          ?sparql .
    OPTIONAL { ?rule dcterms:title       ?label }
    OPTIONAL { ?rule dcterms:description ?description }
    OPTIONAL { ?rule hb:targetGraph      ?targetGraph }
    OPTIONAL { ?rule hb:sourceGraph      ?sourceGraph }
    OPTIONAL { ?rule hb:writeMode        ?writeMode }
    OPTIONAL { ?rule hb:ruleStatus       ?ruleStatus }
    OPTIONAL { ?rule hb:parameters       ?parameters }
    OPTIONAL { ?rule sh:order            ?order }
  }
}
ORDER BY ?order ?id`
  try {
    const { bindings } = await runQuery(JENA_SPARQL, sparql, LOG_SPARQL)
    const rules = bindings
      .map(r => {
        let params = []
        if (r.parameters?.value) {
          try { params = JSON.parse(r.parameters.value) } catch (_) {}
        }
        const writeMode   = (r.writeMode?.value   ?? '').split('#').pop() || 'Append'
        const ruleStatus  = (r.ruleStatus?.value  ?? '').split('#').pop() || 'Active'
        return {
          id:          r.id?.value          ?? '',
          label:       r.label?.value       ?? r.id?.value ?? '',
          description: r.description?.value ?? '',
          sparql:      r.sparql?.value      ?? '',
          targetGraph: r.targetGraph?.value ?? null,
          sourceGraph: r.sourceGraph?.value ?? null,
          writeMode,
          ruleStatus,
          firesOnSeverity: ['Info', 'Warning', 'Violation'], // default all; extend later
          params,
          order:       r.order?.value ? parseInt(r.order.value, 10) : 100
        }
      })
      .filter(r => r.id && r.sparql && r.targetGraph)
    console.log(`[Bridge] Loaded ${rules.length} named rule${rules.length === 1 ? '' : 's'} from <${graphIri}>`)
    return rules
  } catch (err) {
    console.warn(`[Bridge] No named rules from <${graphIri}>: ${err.message}`)
    return []
  }
}

/**
 * Load pipeline manifests from RDF graph `urn:{DATASET}:named-pipelines`.
 * Non-canonical — pending WG IV alignment.
 */
async function loadNamedPipelinesFromGraph() {
  const graphIri = namedPipelinesGraphIri()
  const sparql = `
PREFIX hb:      <https://w3id.org/holonbridge/>
PREFIX dcterms: <http://purl.org/dc/terms/>

SELECT ?id ?label ?description ?signalType ?holdingGraph ?shapesGraph
       ?promotionRule ?violationRule ?warningRule ?reportGraph ?contextGraph
       ?retainOnViolation ?defaultWarningPolicy
WHERE {
  GRAPH <${graphIri}> {
    ?pipeline a hb:Pipeline ;
              dcterms:identifier ?id .
    OPTIONAL { ?pipeline dcterms:title             ?label }
    OPTIONAL { ?pipeline dcterms:description       ?description }
    OPTIONAL { ?pipeline hb:signalType             ?signalType }
    OPTIONAL { ?pipeline hb:holdingGraph           ?holdingGraph }
    OPTIONAL { ?pipeline hb:shapesGraph            ?shapesGraph }
    OPTIONAL { ?pipeline hb:promotionRule          ?promotionRule }
    OPTIONAL { ?pipeline hb:violationRule          ?violationRule }
    OPTIONAL { ?pipeline hb:warningRule            ?warningRule }
    OPTIONAL { ?pipeline hb:reportGraph            ?reportGraph }
    OPTIONAL { ?pipeline hb:contextGraph           ?contextGraph }
    OPTIONAL { ?pipeline hb:retainOnViolation      ?retainOnViolation }
    OPTIONAL { ?pipeline hb:defaultWarningPolicy   ?defaultWarningPolicy }
  }
}
ORDER BY ?id`
  try {
    const { bindings } = await runQuery(JENA_SPARQL, sparql, LOG_SPARQL)
    const pipelines = bindings
      .map(r => ({
        id:                   r.id?.value                ?? '',
        label:                r.label?.value             ?? '',
        description:          r.description?.value       ?? '',
        signalType:           r.signalType?.value        ?? null,
        holdingGraph:         r.holdingGraph?.value      ?? null,
        shapesGraph:          r.shapesGraph?.value       ?? SHACL_GRAPH,
        promotionRule:        r.promotionRule?.value     ?? null,
        violationRule:        r.violationRule?.value     ?? null,
        warningRule:          r.warningRule?.value       ?? null,
        reportGraph:          r.reportGraph?.value       ?? `urn:${DATASET}:reports`,
        contextGraph:         r.contextGraph?.value      ?? null,
        retainOnViolation:    r.retainOnViolation?.value === 'true',
        defaultWarningPolicy: (r.defaultWarningPolicy?.value ?? '').split('#').pop() || 'Block'
      }))
      .filter(p => p.id)
    console.log(`[Bridge] Loaded ${pipelines.length} pipeline${pipelines.length === 1 ? '' : 's'} from <${graphIri}>`)
    return pipelines
  } catch (err) {
    console.warn(`[Bridge] No pipelines from <${graphIri}>: ${err.message}`)
    return []
  }
}

/**
 * Execute a named rule by rule object, with optional param substitution.
 * Returns { turtle, tripleCount } on success or throws.
 * Non-canonical — shared between /rule endpoint and runPipeline().
 */
async function executeNamedRule(rule, params = {}) {
  let sparqlToRun = rule.sparql

  // $this special binding
  if (params['$this']) {
    const v = params['$this']
    sparqlToRun = sparqlToRun.replace(/\$this\b/g,
      (v.startsWith('http') || v.startsWith('urn')) ? `<${v}>` : v)
    delete params['$this']
  }

  // Timestamp and other auto-bindings
  const now = new Date().toISOString()
  const autoParams = { '$timestamp': now, '$dataset': DATASET, ...params }
  const sub = substituteParams(sparqlToRun, autoParams)
  if (sub.missing.length > 0)
    throw new Error(`Unresolved placeholders in rule '${rule.id}': ${sub.missing.join(', ')}`)
  sparqlToRun = sub.sparql

  const writeMode   = rule.writeMode   ?? 'Append'
  const targetGraph = rule.targetGraph

  // Execute CONSTRUCT
  const controller = new AbortController()
  const timer      = setTimeout(() => controller.abort(), 60_000)
  let constructResp
  try {
    constructResp = await fetch(JENA_SPARQL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/sparql-query', 'Accept': 'text/turtle' },
      body:    sparqlToRun,
      signal:  controller.signal
    })
  } finally { clearTimeout(timer) }

  const turtle = await constructResp.text()
  if (!constructResp.ok)
    throw new Error(`CONSTRUCT failed (HTTP ${constructResp.status}): ${turtle.slice(0, 200)}`)

  const tripleCount = turtle.trim()
    ? turtle.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('@') && !l.startsWith('PREFIX')).length
    : 0

  // Write to target graph per writeMode
  const gspTarget = `${JENA_GSP}?graph=${encodeURIComponent(targetGraph)}`
  if (writeMode === 'Replace' || writeMode === 'Sync') {
    await fetch(JENA_UPDATE, {
      method:  'POST',
      headers: { 'Content-Type': 'application/sparql-update' },
      body:    `${writeMode === 'Sync' ? 'DROP SILENT' : 'CLEAR'} GRAPH <${targetGraph}>`
    })
  }
  if (turtle.trim()) {
    const gspResp = await fetch(gspTarget, {
      method:  'POST',
      headers: { 'Content-Type': 'text/turtle' },
      body:    turtle
    })
    if (!gspResp.ok) {
      const err = await gspResp.text()
      throw new Error(`GSP write failed: ${err.slice(0, 200)}`)
    }
  }
  return { turtle, tripleCount, writeMode, targetGraph }
}

/**
 * Run the inbound signal pipeline for a given messageId.
 * Reads envelope from messageStore, validates payload, routes by severity,
 * fires appropriate named rule, updates message status.
 * Non-canonical — pending WG IV alignment.
 */
async function runIngestPipeline(messageId) {
  const msg = messageStore.get(messageId)
  if (!msg) throw new Error(`Message '${messageId}' not found in store.`)

  const pipeline = namedPipelines.find(p => p.id === msg.pipelineId)
    ?? namedPipelines.find(p => p.signalType === msg.signalType)
  if (!pipeline) {
    msg.status = 'hb:Rejected'
    msg.note   = `No pipeline found for id '${msg.pipelineId}' or signalType '${msg.signalType}'.`
    return
  }

  const payloadGraph  = msg.payloadGraph
  const shapesGraph   = pipeline.shapesGraph ?? SHACL_GRAPH
  const reportGraph   = pipeline.reportGraph ?? `urn:${DATASET}:reports`
  const holdingGraph  = msg.holdingGraph

  try {
    // 1. Fetch payload graph as Turtle for validation
    const gspUrl = `${JENA_GSP}?graph=${encodeURIComponent(payloadGraph)}`
    const gspResp = await fetch(gspUrl, { headers: { 'Accept': 'text/turtle' } })
    if (!gspResp.ok) throw new Error(`Could not fetch payload graph <${payloadGraph}>`)
    const payloadTurtle = await gspResp.text()

    // 2. SHACL validate
    const validation = await validateWithShacl(JENA_BASE, DATASET, shapesGraph, payloadTurtle)
    const conforms    = validation?.conforms ?? true

    // 3. Determine max severity from report
    let maxSeverity = 'Info'
    if (!conforms && validation?.results?.length > 0) {
      const severities = validation.results.map(r => r.severity ?? 'Violation')
      maxSeverity = severities.includes('Violation') ? 'Violation'
                  : severities.includes('Warning')   ? 'Warning'
                  : 'Info'
    }

    // 4. Route by severity
    const ruleParams = {
      '$holdingGraph': holdingGraph,
      '$payloadGraph': payloadGraph,
      '$signalType':   msg.signalType,
      '$user':         msg.submittedBy ?? '',
      '$timestamp':    new Date().toISOString(),
      'uuid':          randomUUID()
    }

    if (maxSeverity === 'Violation') {
      msg.status = 'hb:Violated'
      const vRule = namedRules.find(r => r.id === pipeline.violationRule)
      if (vRule) {
        await executeNamedRule(vRule, { ...ruleParams,
          '$reportGraph': reportGraph,
          '$validationNote': (validation?.results?.[0]?.message ?? 'Violation')
        })
      }
      // Write ValidationReport stub to report graph
      const reportTurtle = `
PREFIX hb:  <https://w3id.org/holonbridge/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
<urn:${DATASET}:report:${messageId}>
  a hb:ValidationReport ;
  hb:messageId "${messageId}" ;
  hb:conforms false ;
  hb:severity hb:Violation ;
  hb:timestamp "${ruleParams['$timestamp']}"^^xsd:dateTime .`
      await fetch(`${JENA_GSP}?graph=${encodeURIComponent(reportGraph)}`, {
        method: 'POST', headers: { 'Content-Type': 'text/turtle' }, body: reportTurtle
      })
      msg.reportIri = `urn:${DATASET}:report:${messageId}`
      if (!pipeline.retainOnViolation)
        await fetch(JENA_UPDATE, { method: 'POST',
          headers: { 'Content-Type': 'application/sparql-update' },
          body: `DROP SILENT GRAPH <${holdingGraph}> ; DROP SILENT GRAPH <${payloadGraph}>`
        })

    } else if (maxSeverity === 'Warning') {
      msg.status = 'hb:Warned'
      const warningPolicy = pipeline.defaultWarningPolicy ?? 'Block'
      const wRule = namedRules.find(r => r.id === pipeline.warningRule)

      if (warningPolicy === 'Block') {
        // Treat as violation
        if (wRule) await executeNamedRule(wRule, { ...ruleParams, '$reportGraph': reportGraph })
        msg.status = 'hb:Rejected'
        msg.note   = 'Warning treated as violation per pipeline defaultWarningPolicy: Block'
        if (!pipeline.retainOnViolation)
          await fetch(JENA_UPDATE, { method: 'POST',
            headers: { 'Content-Type': 'application/sparql-update' },
            body: `DROP SILENT GRAPH <${holdingGraph}> ; DROP SILENT GRAPH <${payloadGraph}>`
          })
      } else {
        // AnnotateAndPromote — promote with warning annotation
        if (wRule) await executeNamedRule(wRule, ruleParams)
        const eventIri = `urn:${DATASET}:event:${ruleParams.uuid}`
        msg.status  = 'hb:Promoted'
        msg.eventIri = eventIri
        msg.note    = 'Promoted with warning annotation (AnnotateAndPromote policy)'
        await fetch(JENA_UPDATE, { method: 'POST',
          headers: { 'Content-Type': 'application/sparql-update' },
          body: `DROP SILENT GRAPH <${holdingGraph}> ; DROP SILENT GRAPH <${payloadGraph}>`
        })
      }

    } else {
      // Valid path — fire promotion rule
      msg.status = 'hb:Valid'
      const pRule = namedRules.find(r => r.id === pipeline.promotionRule)
      if (pRule) await executeNamedRule(pRule, ruleParams)
      const eventIri = `urn:${DATASET}:event:${ruleParams.uuid}`
      msg.status    = 'hb:Promoted'
      msg.eventIri  = eventIri
      await fetch(JENA_UPDATE, { method: 'POST',
        headers: { 'Content-Type': 'application/sparql-update' },
        body: `DROP SILENT GRAPH <${holdingGraph}> ; DROP SILENT GRAPH <${payloadGraph}>`
      })
    }

    msg.resolvedAt = new Date().toISOString()
    console.log(`[Bridge] Pipeline '${msg.pipelineId}' → message '${messageId}' → ${msg.status}`)

  } catch (err) {
    msg.status     = 'hb:Rejected'
    msg.note       = err.message
    msg.resolvedAt = new Date().toISOString()
    console.error(`[Bridge] Pipeline error for '${messageId}':`, err.message)
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

  // Load named rules
  namedRules = await loadNamedRulesFromGraph()

  // Load named pipelines
  namedPipelines = await loadNamedPipelinesFromGraph()

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
      const violations = validation.violations ?? []
      console.warn(`[Update] SHACL validation failed -- ${violations.length} violation(s)`)
      return { updated: false, error: 'SHACL validation failed -- no data written',
               conforms: false, results: violations, violations,
               rawReport: validation.rawReport ?? null,
               validation, graph: graphIri, mode }
    }
  }

  try {
    const result = await pushToGraph(JENA_GSP, graphIri, turtle, mode)
    console.log(`[Update] Push succeeded -- HTTP ${result.status}, graph=${graphIri ?? 'default'}, mode=${mode}`)
    return { updated: true, conforms: true, results: [], graph: graphIri, mode, validation, jenaStatus: result.status }
  } catch (err) {
    return { updated: false, error: `Jena GSP push failed: ${err.jenaMessage ?? err.message}`,
             conforms: true, results: [], validation, graph: graphIri, mode }
  }
}

// --- Express app --------------------------------------------------------------

const app = express()
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))   // required for OAuth form posts

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// -- OAuth2 shim (must be before requireAuth) ----------------------------------
//
// Provides /oauth/token and /.well-known/oauth-authorization-server so that
// claude.ai connectors (which expect OAuth Client ID + Secret) can exchange
// credentials for the BEARER_TOKEN used by requireAuth below.
//
// Required .env additions:
//   OAUTH_CLIENT_ID=holonbridge-claude
//   OAUTH_CLIENT_SECRET=<strong secret, different from BEARER_TOKEN>
//   PUBLIC_BASE_URL=https://kurtcagle-mcp.ngrok.io

registerOAuth(app)

// -- Auth middleware -----------------------------------------------------------
//
// All routes below this point require a valid Bearer token.
// Set BEARER_TOKEN in .env (generate with: openssl rand -hex 32).
//
// If BEARER_TOKEN is absent the bridge logs a warning and runs unauthenticated
// (acceptable on a loopback-only / dev machine, never in production).
//
// Exemptions: GET /health is always public (monitoring probes need no token).

const BEARER_TOKEN = process.env.BEARER_TOKEN?.trim()

if (!BEARER_TOKEN) {
  console.warn('[Bridge] WARNING: BEARER_TOKEN not set — all endpoints are unauthenticated. ' +
               'Set BEARER_TOKEN in .env and restart.')
}

function requireAuth(req, res, next) {
  // /health is always public — allow monitoring probes without a token
  if (req.path === '/health') return next()

  if (!BEARER_TOKEN) return next()   // dev mode: no token configured

  const header = req.headers['authorization'] ?? ''
  const token  = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (token !== BEARER_TOKEN)
    return res.status(401).json({ error: 'Unauthorized — bad or missing Bearer token' })
  next()
}

app.use(requireAuth)

// ── MCP remote transport compatibility middleware ─────────────────────────────
//
// The holonbridge-mcp-remote SSE layer uses different path/key conventions than
// the canonical HolonBridge REST routes. This middleware normalises both before
// requests reach route handlers. No route definitions need changing.
//
// Mappings applied:
//   POST /sparql/query   { query: "..." }    → POST /sparql-select  { sparql: "..." }
//   POST /nl_query       { question: "..." } → POST /query          { nl: "..." }
//   GET  /sparql/graphs                      → GET  /graphs
//
// Placement: after requireAuth (auth is already enforced by app.use above),
// after express.json() (req.body is available), before all route definitions.

app.use((req, res, next) => {
  // POST /sparql/query → /sparql-select
  // Normalise body key: MCP sends { query } but /sparql-select expects { sparql }
  if (req.method === 'POST' && req.path === '/sparql/query') {
    if (req.body && !req.body.sparql && req.body.query) {
      req.body.sparql = req.body.query
    }
    req.url = '/sparql-select'
    return next()
  }

  // POST /nl_query → /query
  // Normalise body key: MCP sends { question } but /query expects { nl }
  if (req.method === 'POST' && req.path === '/nl_query') {
    if (req.body && !req.body.nl && req.body.question) {
      req.body.nl = req.body.question
    }
    req.url = '/query'
    return next()
  }

  // GET /sparql/graphs → /graphs
  if (req.method === 'GET' && req.path === '/sparql/graphs') {
    req.url = '/graphs'
    return next()
  }

  next()
})

// ── end MCP compatibility middleware ──────────────────────────────────────────

// -- POST /query ---------------------------------------------------------------

app.post('/query', async (req, res) => {
  const { nl, queryId, params, format } = req.body ?? {}
  const asDataBook = format === 'databook'

  // -- Named query: execute stored SPARQL directly, bypass NL pipeline -----------
  if (queryId) {
    const nq = namedQueries.find(q => q.id === queryId)
    if (!nq) return res.status(404).json({ error: `Named query '${queryId}' not found.` })

    // Apply parameter substitution if params supplied
    let sparqlToRun = nq.sparql
    let substitution = { substituted: [], missing: [] }
    if (params && typeof params === 'object') {
      substitution = substituteParams(nq.sparql, params)
      sparqlToRun  = substitution.sparql
      if (substitution.missing.length > 0) {
        return res.status(400).json({
          error:   `Named query '${queryId}' has unresolved placeholders after substitution.`,
          missing: substitution.missing,
          params:  nq.params ?? []
        })
      }
    }

    console.log(`[Bridge] Named query '${queryId}' (source: ${nq.source ?? 'unknown'}, params: ${JSON.stringify(params ?? {})})`)
    try {
      const { vars, bindings }  = await runQuery(JENA_SPARQL, sparqlToRun, LOG_SPARQL)
      const formattedResults    = formatBindings(vars, bindings)
      const answer              = `Named query '${nq.label ?? queryId}' returned ${bindings.length} result(s).`
      const result              = { answer, sparql: sparqlToRun, bindings, vars, formattedResults, retries: 0, queryId,
                                    substitution: substitution.substituted.length > 0 ? substitution : undefined }
      if (asDataBook) {
        const doc = buildResponseDataBook({
          nlQuery: nq.description ?? queryId, sparql: sparqlToRun, bindings, vars,
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
      namedRules: namedRules.length,
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
    namedRules:     namedRules.length,
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
  // Fresh read, not the boot-time `sessionState` const below -- focus
  // changes continuously as GET /holon calls come in, so a boot-time
  // snapshot would go stale immediately. dataset/jenaBase/shaclRequired
  // deliberately keep using the boot-time snapshot below (they describe
  // "what this process booted with," not live state).
  const liveSessionState = loadSessionState()

  res.json({
    service: 'holon-bridge', version: '2.9.0',
    dataset: DATASET, contextDir: getContextDir(),
    jenaBase: JENA_BASE, sparqlEndpoint: JENA_SPARQL,
    gspEndpoint: JENA_GSP, shaclGraph: SHACL_GRAPH,
    shaclTriples, model: MODEL, maxRetries: MAX_RETRIES,
    operations: [
      { method: 'POST', path: '/query',          description: 'NL -> SPARQL -> interpreted answer. Or { queryId } to execute a stored named query. Or { queryId, params: { key: value } } for parameterised named queries — substitutes {{key}} placeholders in the stored SPARQL before execution.' },
      { method: 'POST', path: '/sparql-select',    description: 'Direct SPARQL SELECT or ASK — bypasses NL pipeline. Body: { "sparql": "..." }. Returns JSON bindings. Also accepts CONSTRUCT/DESCRIBE for backwards compatibility; prefer /sparql-construct for graph-producing queries.' },
      { method: 'POST', path: '/sparql-construct', description: 'Direct SPARQL CONSTRUCT or DESCRIBE — returns RDF. Body: { "query": "CONSTRUCT { ... } WHERE { ... }", "format"?: "turtle"|"trig" }. Accept header overrides format param. Default: text/turtle. Timeout: 30s.' },
      { method: 'POST', path: '/describe',         description: 'Deep graph description of a resource. Follows IRIs and blank nodes to depth 1–5 (default 5, hard cap). rdf:List chains traversed via property path. Reifier nodes collected in parallel. Optional one-level inbound traversal with string-label subordinate. Body: { iri, depth?, graph?, inbound?, reifiers?, format? }. graph=null means dataset-wide (uses DESCRIBE); graph=<IRI> is bounded (uses CONSTRUCT).' },
      { method: 'POST', path: '/update',         description: 'SHACL-gated Turtle push to a named graph.' },
      { method: 'POST', path: '/sparql-update',  description: 'Raw SPARQL UPDATE (INSERT/DELETE/etc) — no validation gate.' },
      { method: 'POST', path: '/reload',         description: 'Reload context directory + named queries (RDF + filesystem) + rediscover named graphs.' },
      { method: 'POST', path: '/dataset',        description: 'Switch active dataset at runtime. Accepts optional "fusekiUrl" to change Fuseki host in the same call. Restarts context watcher. Body: { "dataset": "name", "fusekiUrl"?: "http://..." }.' },
      { method: 'POST', path: '/fuseki-url',     description: 'Change the Fuseki base URL at runtime without restarting. Pings the new host; warns but does not roll back if unreachable. Body: { "url": "http://...", "dataset"?: "name" }.' },
      { method: 'POST', path: '/shacl-mode',     description: 'Toggle SHACL validation gate at runtime. Body: { "required": true|false }.' },
      { method: 'POST', path: '/named-query',    description: 'Register, update, or delete a named query. Body: { id, label?, description?, sparql, targetGraph?, params?: [{name, description?, default?}] } or { id, delete: true }. Use {{paramName}} placeholders in sparql; callers supply values via POST /query { queryId, params }.' },
      { method: 'POST', path: '/pipeline',      description: '[NON-CANONICAL] Register, update, or delete a pipeline manifest. Body: { id, signalType, holdingGraph, promotionRule, contextGraph, ... } or { id, delete: true }.' },
      { method: 'POST', path: '/ingest',        description: '[NON-CANONICAL] Submit a signal through a named pipeline. Pattern A: JSON body. Pattern B: text/turtle hb:Message. Returns 202 with messageId. Add sync:true for synchronous execution.' },
      { method: 'POST', path: '/pipeline-run',  description: '[NON-CANONICAL] Trigger pipeline on pre-populated holding graph (Pattern C). Body: { messageId }. Returns 202.' },
      { method: 'GET',  path: '/pipelines',     description: '[NON-CANONICAL] List all registered pipeline manifests.' },
      { method: 'GET',  path: '/message/:id',   description: '[NON-CANONICAL] Poll message status. Returns status, eventIri, reportIri, resolvedAt.' },
      { method: 'POST', path: '/rule',          description: '[NON-CANONICAL] Execute a named rule by ID. Runs CONSTRUCT and writes results to targetGraph per writeMode (Append/Replace/Sync). Body: { ruleId, params?, writeMode? }.' },
      { method: 'POST', path: '/graph-op',      description: 'Execute a SPARQL graph management operation. Body: { operation: clear|drop|create|copy|move|add, source?, target, silent? }.' },
      { method: 'GET',  path: '/datasets',       description: 'List all datasets available on the Fuseki server.' },
      { method: 'GET',  path: '/graphs',         description: 'Live query: list all named graphs in the active dataset with triple counts.' },
      { method: 'GET',  path: '/graph',          description: 'Fetch RDF content of a single named graph via GSP. Query params: iri=<encoded IRI>, format=turtle|trig.' },
      { method: 'GET',  path: '/named-queries',  description: 'List all registered named queries with source (rdf|filesystem).' },
      { method: 'GET',  path: '/holon/:iri',    description: 'Retrieve a holon as a projection DataBook (text/markdown). :iri is the full holon IRI, percent-encoded as a single path segment. Query param projection=immersive|cinematic|active_inference|exploded_view (default immersive). Targets the https://ontologist.io/ns/holon# / holon:isPartOf model actually populated in Fuseki -- see lib/holon.js header for the namespace-reconciliation note against lib/lifecycle.js.' },
      { method: 'GET',  path: '/holon',         description: 'Same as GET /holon/:iri but with no IRI -- resolves the holon to show via persisted focus for the active dataset, falling back to that dataset\'s holon:Home instance if no focus has been persisted yet. Every successful call on either route persists its resolved IRI as the new focus. See sessionState.currentFocus below and GET /holon\'s response metadata (resolvedVia: explicit|persisted-focus|holon-home) for observability into which path produced the answer.' },
      { method: 'GET',  path: '/description',    description: 'Capability manifest for LLM consumption (this endpoint).' },
      { method: 'GET',  path: '/health',         description: 'Liveness check.' }
    ],
    namedQueriesGraph: namedQueriesGraphIri(),
    namedRulesGraph:   namedRulesGraphIri(),
    namedPipelinesGraph: namedPipelinesGraphIri(),
    namedQueries, namedGraphs, databookBlocks: databookIds,
    namedRules: namedRules.length,
    namedPipelines: namedPipelines.length,
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
    sessionState: {
      restoredFromDisk: Object.keys(sessionState).length > 0,
      persistedDataset: sessionState.dataset ?? null,
      persistedJenaBase: sessionState.jenaBase ?? null,
      persistedShaclRequired: sessionState.shaclRequired ?? null,
      persistedUpdatedAt: sessionState.updatedAt ?? null,
      currentFocus: liveSessionState.focusByDataset?.[DATASET] ?? null,
      note: 'persistedDataset/persistedJenaBase/persistedShaclRequired are what this bridge booted with, ' +
            'read from .bridge-session-state.json. If they don\'t match the "dataset"/"jenaBase"/"shacl.required" ' +
            'fields above, this process has switched since boot -- that\'s normal. If restoredFromDisk is false ' +
            'and you expected persisted state (e.g. right after a restart), the state file is missing or was ' +
            'never written. currentFocus, unlike the persisted* fields above, is read fresh on every call, not ' +
            'cached from boot -- it is the IRI GET /holon (no :iri) will resolve to right now for this dataset, ' +
            'updated by every successful GET /holon call.'
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
    status: 'ok', service: 'holon-bridge', version: '2.9.0',
    dataset: DATASET, contextDir: getContextDir(),
    sparqlEndpoint: JENA_SPARQL, gspEndpoint: JENA_GSP,
    shaclGraph: SHACL_GRAPH, model: MODEL,
    databookBlocks: databookIds, namedGraphs,
    namedQueries: namedQueries.length,
    namedRules: namedRules.length,
    namedPipelines: namedPipelines.length,
    maxRetries: MAX_RETRIES
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
  saveSessionState({ shaclRequired: SHACL_REQUIRED })
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

  // Validate params if supplied (must be array of { name, description?, default? })
  let paramsJson = null
  if (req.body.params !== undefined) {
    if (!Array.isArray(req.body.params))
      return res.status(400).json({ error: '"params" must be an array of { name, description?, default? } objects.' })
    paramsJson = JSON.stringify(req.body.params)
  }

  const escape = s => s.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"')
  const HB      = 'https://w3id.org/holonbridge/'
  const DCTERMS = 'http://purl.org/dc/terms/'

  const optionals = [
    label       ? `    <${DCTERMS}title>       """${escape(label)}""" ;`       : null,
    description ? `    <${DCTERMS}description> """${escape(description)}""" ;` : null,
    targetGraph ? `    <${HB}targetGraph>      <${targetGraph}> ;`             : null,
    paramsJson  ? `    <${HB}parameters>       """${escape(paramsJson)}""" ;`  : null,
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
    queries:    namedQueries.map(({ id, label, description, targetGraph, params, source }) =>
                  ({ id, label, description, targetGraph, params: params ?? [], source }))
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
  // Strip comments and PREFIX declarations before detecting query type
  const strippedQ  = query
    .replace(/^\s*(#[^\n]*\n\s*)*/i, '')           // strip leading comments
    .replace(/PREFIX\s+\S*\s*<[^>]*>\s*/gi, '')    // strip PREFIX declarations
    .trim()
  const isConstruct = /^(CONSTRUCT|DESCRIBE)\b/i.test(strippedQ)

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

// -- POST /sparql-construct ----------------------------------------------------
//
// Execute a SPARQL CONSTRUCT or DESCRIBE query directly against Fuseki and
// return the result as RDF.  Unlike /sparql-select (which detects and handles
// CONSTRUCT internally while primarily serving SELECT/ASK), this endpoint is
// dedicated to graph-producing queries and supports explicit format negotiation.
//
// Request body: { "query": "CONSTRUCT { ... } WHERE { ... }", "format"?: "turtle"|"trig" }
// Accept header overrides the body "format" param when both are present.
//
// Response: text/turtle (default) or application/trig
// Errors:   400 if query is missing or not a CONSTRUCT/DESCRIBE
//           502 if Fuseki returns an error
//           504 if the query times out (30s)

app.post('/sparql-construct', async (req, res) => {
  const { query, format } = req.body ?? {}

  if (!query || typeof query !== 'string' || !query.trim())
    return res.status(400).json({ error: 'Request body must include a non-empty "query" string.' })

  // Determine output format: Accept header takes priority over body param
  const acceptHeader = req.headers['accept'] ?? ''
  let responseType
  if (acceptHeader.includes('application/trig')) {
    responseType = 'application/trig'
  } else if (format === 'trig') {
    responseType = 'application/trig'
  } else {
    responseType = 'text/turtle'   // default
  }

  // Validate query type — reject SELECT/ASK/UPDATE to give a helpful error
  const stripped = query.trim()
    .replace(/^\s*(#[^\n]*\n\s*)*/i, '')           // strip leading comments
    .replace(/PREFIX\s+\S*\s*<[^>]*>\s*/gi, '')    // strip PREFIX declarations
    .trim()

  if (!/^(CONSTRUCT|DESCRIBE)\b/i.test(stripped)) {
    return res.status(400).json({
      error: 'POST /sparql-construct accepts CONSTRUCT and DESCRIBE queries only. ' +
             'Use POST /sparql-select for SELECT and ASK, or POST /sparql-update for INSERT/DELETE.'
    })
  }

  console.log(`[Bridge] /sparql-construct (${query.length} chars, format=${responseType})`)
  if (LOG_SPARQL) console.log(query)

  try {
    const controller = new AbortController()
    const timer      = setTimeout(() => controller.abort(), 30_000)
    let response
    try {
      response = await fetch(JENA_SPARQL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/sparql-query', 'Accept': responseType },
        body:    query.trim(),
        signal:  controller.signal
      })
    } finally { clearTimeout(timer) }

    const body = await response.text()

    if (!response.ok)
      return res.status(502).json({
        error: `Fuseki CONSTRUCT returned HTTP ${response.status}: ${body.slice(0, 300)}`
      })

    console.log(`[Bridge] /sparql-construct OK -- ${body.length} chars, ${responseType}`)
    return res.type(responseType).send(body)

  } catch (err) {
    if (err.name === 'AbortError')
      return res.status(504).json({ error: 'CONSTRUCT query timed out (30s).' })
    console.error('[Bridge] /sparql-construct error:', err)
    return res.status(500).json({ error: 'Internal bridge error', message: err.message })
  }
})

// -- POST /describe ------------------------------------------------------------
//
// Deep graph description of a resource.  Follows IRIs and blank nodes to an
// arbitrary depth (max 5 hops), collecting triples at each hop via CONSTRUCT
// (graph-bounded) or DESCRIBE (dataset-wide).  rdf:List chains are traversed
// via property path regardless of depth.  Reifier nodes are collected in a
// parallel query at each hop.  Optional one-level inbound traversal captures
// subjects that point at the seed, plus their string-valued properties (labels,
// comments, etc.) to aid identification.
//
// Request body:
//   {
//     "iri":      "<seed IRI>"           -- required
//     "depth":    1–5                    -- default 5 (capped at 5)
//     "graph":    "<named graph IRI>"    -- default null (= dataset-wide)
//     "inbound":  true|false             -- default false
//     "reifiers": true|false             -- default true
//     "format":   "turtle"|"trig"        -- default "turtle"
//   }
//
// Accept header overrides the "format" body param when both are present.

app.post('/describe', async (req, res) => {
  const {
    iri,
    depth    = 5,
    graph    = null,
    inbound  = false,
    reifiers = true,
    format   = 'turtle'
  } = req.body ?? {}

  if (!iri || typeof iri !== 'string' || !iri.trim())
    return res.status(400).json({
      error: '"iri" is required — provide the seed IRI to describe.',
      example: { iri: 'urn:chloe:meeting:2026-06-26-causalspark-marion', depth: 3, graph: null }
    })

  const seedIri      = iri.trim()
  const maxDepth     = Math.min(Math.max(parseInt(depth, 10) || 5, 1), 5)
  const graphIri     = (graph && typeof graph === 'string' && graph.trim()) ? graph.trim() : null
  const acceptHeader = req.headers['accept'] ?? ''
  const responseType = (acceptHeader.includes('application/trig') || format === 'trig')
    ? 'application/trig' : 'text/turtle'

  console.log(`[Bridge] /describe <${seedIri}> depth=${maxDepth} graph=${graphIri ?? 'unbounded'} inbound=${inbound} reifiers=${reifiers}`)

  async function fc(sparql) {
    const controller = new AbortController()
    const timer      = setTimeout(() => controller.abort(), 30_000)
    let response
    try {
      response = await fetch(JENA_SPARQL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/sparql-query', 'Accept': 'text/turtle' },
        body:    sparql,
        signal:  controller.signal
      })
    } finally { clearTimeout(timer) }
    const body = await response.text()
    if (!response.ok)
      throw new Error(`Fuseki returned HTTP ${response.status}: ${body.slice(0, 200)}`)
    return body
  }

  try {
    const visited  = new Set([seedIri])
    let   frontier = [seedIri]
    const parts    = []

    for (let hop = 0; hop < maxDepth && frontier.length > 0; hop++) {
      const inList   = frontier.map(i => `<${i}>`).join(' ')
      const inFilter = frontier.map(i => `<${i}>`).join(', ')

      if (graphIri) {
        parts.push(await fc(`
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
CONSTRUCT { ?s ?p ?o }
WHERE {
  GRAPH <${graphIri}> {
    { ?s ?p ?o . FILTER(?s IN (${inFilter})) }
    UNION
    { ?anc ?ap ?bn . FILTER(?anc IN (${inFilter})) FILTER(isBlankNode(?bn))
      BIND(?bn AS ?s) ?s ?p ?o . }
    UNION
    { ?anc ?lp ?head . FILTER(?anc IN (${inFilter})) FILTER(isBlankNode(?head))
      ?head (rdf:rest)* ?node . BIND(?node AS ?s) ?s ?p ?o . }
  }
}`))
      } else {
        parts.push(await fc(`DESCRIBE ${inList}`))
      }

      if (reifiers) {
        const gc  = graphIri ? `GRAPH <${graphIri}> {` : ''
        const gcl = graphIri ? `}` : ''
        const rt  = await fc(`
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
CONSTRUCT { ?reifier ?rp ?ro }
WHERE {
  ${gc}
    ?reifier rdf:reifies << ?s ?p ?o >> .
    FILTER(?s IN (${inFilter}))
    ?reifier ?rp ?ro .
  ${gcl}
}`).catch(() => '')
        if (rt.trim()) parts.push(rt)
      }

      if (hop < maxDepth - 1) {
        const visitedFilter = [...visited].map(i => `<${i}>`).join(', ')
        const gc  = graphIri ? `GRAPH <${graphIri}> {` : ''
        const gcl = graphIri ? `}` : ''
        const { bindings } = await runQuery(JENA_SPARQL, `
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?o WHERE {
  ${gc}
    { ?s ?p ?o . FILTER(?s IN (${inFilter})) FILTER(isIRI(?o)) }
    UNION
    { ?anc ?ap ?bn . FILTER(?anc IN (${inFilter})) FILTER(isBlankNode(?bn))
      ?bn ?bp ?o . FILTER(isIRI(?o)) }
    UNION
    { ?anc ?lp ?head . FILTER(?anc IN (${inFilter})) FILTER(isBlankNode(?head))
      ?head (rdf:rest)* ?node . ?node rdf:first ?o . FILTER(isIRI(?o)) }
  ${gcl}
  FILTER(?o NOT IN (${visitedFilter}))
}`, LOG_SPARQL)
        const newIRIs = bindings.map(b => b.o?.value).filter(Boolean)
        for (const i of newIRIs) visited.add(i)
        frontier = newIRIs
        console.log(`[Bridge] /describe hop ${hop + 1}/${maxDepth} -- frontier: ${frontier.length} new IRI(s)`)
      } else {
        frontier = []
      }
    }

    if (inbound) {
      const gc  = graphIri ? `GRAPH <${graphIri}> {` : ''
      const gcl = graphIri ? `}` : ''
      const it  = await fc(`
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
CONSTRUCT { ?s ?p <${seedIri}> . ?s ?sp ?label . }
WHERE {
  ${gc}
    ?s ?p <${seedIri}> .
    OPTIONAL {
      ?s ?sp ?label .
      FILTER(isLiteral(?label) &&
        (datatype(?label) = xsd:string   ||
         datatype(?label) = rdf:langString ||
         lang(?label) != ""))
    }
  ${gcl}
}`).catch(() => '')
      if (it.trim()) parts.push(it)
    }

    const merged = parts.filter(p => p?.trim()).join('\n\n')
    console.log(`[Bridge] /describe complete -- ${parts.length} part(s), ${merged.length} chars`)
    return res.type(responseType).send(merged)

  } catch (err) {
    if (err.name === 'AbortError')
      return res.status(504).json({ error: '/describe timed out (30s per hop).' })
    console.error('[Bridge] /describe error:', err)
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

// -- POST /named-rule ----------------------------------------------------------
//
// [NON-CANONICAL] Register, update, enable/disable, or delete a named rule.
// Pending WG IV alignment before this API is considered stable.
//
// Register/update: { id, label?, description?, sparql, targetGraph,
//                    sourceGraph?, writeMode?, ruleStatus?, firesOnSeverity?,
//                    params?, order? }
// Delete:          { id, delete: true }
// Status change:   { id, status: "Active"|"Suspended"|"Deprecated" }

app.post('/named-rule', async (req, res) => {
  const { id, label, description, sparql, targetGraph, sourceGraph,
          writeMode, ruleStatus, status, params, order,
          delete: del } = req.body ?? {}

  if (!id || typeof id !== 'string' || !id.trim())
    return res.status(400).json({ error: '"id" is required.' })

  const graphIri  = namedRulesGraphIri()
  const ruleIri   = `${graphIri}:${id.trim()}`
  const HB        = 'https://w3id.org/holonbridge/'
  const DCTERMS   = 'http://purl.org/dc/terms/'
  const SH        = 'http://www.w3.org/ns/shacl#'

  // -- Delete ----------------------------------------------------------------
  if (del) {
    const deleteSparql = `
PREFIX hb:      <${HB}>
PREFIX dcterms: <${DCTERMS}>
WITH <${graphIri}>
DELETE { ?rule ?p ?o }
WHERE  { ?rule dcterms:identifier """${id}""" ; ?p ?o }`
    try {
      await fetch(JENA_UPDATE, { method:'POST',
        headers:{'Content-Type':'application/sparql-update'}, body: deleteSparql })
      namedRules = namedRules.filter(r => r.id !== id)
      console.log(`[Bridge] Named rule '${id}' deleted`)
      return res.json({ deleted: true, id })
    } catch (err) {
      return res.status(500).json({ error: `Delete failed: ${err.message}` })
    }
  }

  // -- Status change only ----------------------------------------------------
  if (status && !sparql) {
    const validStatuses = ['Active','Suspended','Deprecated']
    if (!validStatuses.includes(status))
      return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` })
    const updateSparql = `
PREFIX hb:      <${HB}>
PREFIX dcterms: <${DCTERMS}>
WITH <${graphIri}>
DELETE { ?rule hb:ruleStatus ?old }
INSERT { ?rule hb:ruleStatus hb:${status} }
WHERE  { ?rule dcterms:identifier """${id}""" . OPTIONAL { ?rule hb:ruleStatus ?old } }`
    try {
      await fetch(JENA_UPDATE, { method:'POST',
        headers:{'Content-Type':'application/sparql-update'}, body: updateSparql })
      const r = namedRules.find(r => r.id === id)
      if (r) r.ruleStatus = status
      console.log(`[Bridge] Named rule '${id}' status → ${status}`)
      return res.json({ updated: true, id, ruleStatus: status })
    } catch (err) {
      return res.status(500).json({ error: `Status update failed: ${err.message}` })
    }
  }

  // -- Register / update -----------------------------------------------------
  if (!sparql || typeof sparql !== 'string' || !sparql.trim())
    return res.status(400).json({ error: '"sparql" is required for registration.' })
  if (!targetGraph || typeof targetGraph !== 'string' || !targetGraph.trim())
    return res.status(400).json({ error: '"targetGraph" is required for registration.' })

  let paramsJson = null
  if (params !== undefined) {
    if (!Array.isArray(params))
      return res.status(400).json({ error: '"params" must be an array.' })
    paramsJson = JSON.stringify(params)
  }

  const escape   = s => s.replace(/\\/g,'\\\\').replace(/"""/g,'\\"\\"\\"')
  const wm       = writeMode  ?? 'Append'
  const rs       = ruleStatus ?? 'Active'
  const ord      = order      ?? 100
  const sevList  = (Array.isArray(req.body.firesOnSeverity) ? req.body.firesOnSeverity : ['Info','Warning','Violation'])
    .map(s => `<${SH}${s}>`).join(' , ')

  const optionals = [
    label       ? `    <${DCTERMS}title>       """${escape(label)}""" ;`       : null,
    description ? `    <${DCTERMS}description> """${escape(description)}""" ;` : null,
    sourceGraph ? `    <${HB}sourceGraph>      <${sourceGraph}> ;`             : null,
    paramsJson  ? `    <${HB}parameters>       """${escape(paramsJson)}""" ;`  : null,
  ].filter(Boolean).join('\n')

  const insertSparql = `
PREFIX hb:      <${HB}>
PREFIX dcterms: <${DCTERMS}>
PREFIX sh:      <${SH}>
PREFIX xsd:     <http://www.w3.org/2001/XMLSchema#>

WITH <${graphIri}>
DELETE { ?rule ?p ?o }
WHERE  { ?rule dcterms:identifier """${id}""" ; ?p ?o } ;

INSERT DATA {
  GRAPH <${graphIri}> {
    <${ruleIri}>
      a hb:NamedRule ;
      dcterms:identifier  """${escape(id)}""" ;
      hb:sparql           """${escape(sparql.trim())}""" ;
      hb:targetGraph      <${targetGraph.trim()}> ;
      hb:writeMode        hb:${wm} ;
      hb:ruleStatus       hb:${rs} ;
      sh:order            ${ord} ;
${optionals}
      hb:firesOnSeverity  ${sevList} .
  }
}`

  try {
    const resp = await fetch(JENA_UPDATE, { method:'POST',
      headers:{'Content-Type':'application/sparql-update'}, body: insertSparql })
    if (!resp.ok) {
      const txt = await resp.text()
      return res.status(502).json({ error: `Fuseki update failed: ${txt.slice(0,200)}` })
    }
    // Reload rules into memory
    namedRules = await loadNamedRulesFromGraph()
    console.log(`[Bridge] Named rule '${id}' registered (writeMode: ${wm}, status: ${rs})`)
    return res.json({ registered: true, id, targetGraph, writeMode: wm, ruleStatus: rs })
  } catch (err) {
    return res.status(500).json({ error: `Named rule registration failed: ${err.message}` })
  }
})

// -- GET /named-rules ----------------------------------------------------------
//
// List all registered named rules with status and metadata.

app.get('/named-rules', (_req, res) => {
  res.json({
    total:      namedRules.length,
    active:     namedRules.filter(r => r.ruleStatus === 'Active').length,
    suspended:  namedRules.filter(r => r.ruleStatus === 'Suspended').length,
    rulesGraph: namedRulesGraphIri(),
    rules:      namedRules.map(({ id, label, description, targetGraph, sourceGraph,
                                  writeMode, ruleStatus, firesOnSeverity, params, order }) =>
                  ({ id, label, description, targetGraph, sourceGraph,
                     writeMode, ruleStatus, firesOnSeverity, params: params ?? [], order }))
  })
})

// -- POST /rule ----------------------------------------------------------------
//
// [NON-CANONICAL] Execute a named rule by ID via the executeNamedRule helper.
//
// Request:  { ruleId, params?: { key: value }, writeMode?: "Append"|"Replace"|"Sync" }
// Response: { ruleId, targetGraph, writeMode, triplesWritten }

app.post('/rule', async (req, res) => {
  const { ruleId, params, writeMode: writeModeOverride } = req.body ?? {}

  if (!ruleId || typeof ruleId !== 'string')
    return res.status(400).json({ error: '"ruleId" is required.' })

  const rule = namedRules.find(r => r.id === ruleId)
  if (!rule)
    return res.status(404).json({ error: `Named rule '${ruleId}' not found.` })
  if (rule.ruleStatus === 'Suspended')
    return res.status(409).json({ error: `Named rule '${ruleId}' is suspended.` })
  if (rule.ruleStatus === 'Deprecated')
    return res.status(409).json({ error: `Named rule '${ruleId}' is deprecated.` })

  // Apply writeMode override
  const ruleToRun = writeModeOverride ? { ...rule, writeMode: writeModeOverride } : rule

  console.log(`[Bridge] /rule '${ruleId}' writeMode=${ruleToRun.writeMode} target=<${rule.targetGraph}>`)
  try {
    const result = await executeNamedRule(ruleToRun, params ? { ...params } : {})
    return res.json({
      ruleId,
      targetGraph:    rule.targetGraph,
      writeMode:      result.writeMode,
      triplesWritten: result.tripleCount,
      note:           'Non-canonical implementation — pending WG IV alignment'
    })
  } catch (err) {
    if (err.name === 'AbortError')
      return res.status(504).json({ error: 'CONSTRUCT timed out (60s).' })
    console.error(`[Bridge] /rule '${ruleId}' error:`, err)
    return res.status(500).json({ error: err.message })
  }
})

// -- POST /graph-op ------------------------------------------------------------
//
// Execute a SPARQL graph management operation (CLEAR, DROP, CREATE, COPY, MOVE, ADD).
// These underpin named rule write semantics and are also available to callers directly.
//
// Request:  { operation, source?, target, silent? }
// Response: { operation, source?, target, ok }

app.post('/graph-op', async (req, res) => {
  const { operation, source, target, silent = true } = req.body ?? {}

  const ops = ['clear','drop','create','copy','move','add']
  if (!operation || !ops.includes(operation.toLowerCase()))
    return res.status(400).json({ error: `"operation" must be one of: ${ops.join(', ')}` })

  const op    = operation.toLowerCase()
  const sil   = silent ? 'SILENT' : ''

  // Validate required params per operation
  if (['clear','drop','create'].includes(op) && !target)
    return res.status(400).json({ error: `"target" is required for ${op}` })
  if (['copy','move','add'].includes(op) && (!source || !target))
    return res.status(400).json({ error: `"source" and "target" are required for ${op}` })

  let sparqlOp
  switch (op) {
    case 'clear':  sparqlOp = `CLEAR  ${sil} GRAPH <${target}>`; break
    case 'drop':   sparqlOp = `DROP   ${sil} GRAPH <${target}>`; break
    case 'create': sparqlOp = `CREATE ${sil} GRAPH <${target}>`; break
    case 'copy':   sparqlOp = `COPY   ${sil} <${source}> TO <${target}>`; break
    case 'move':   sparqlOp = `MOVE   ${sil} <${source}> TO <${target}>`; break
    case 'add':    sparqlOp = `ADD    ${sil} <${source}> TO <${target}>`; break
  }

  console.log(`[Bridge] /graph-op: ${sparqlOp}`)

  try {
    const resp = await fetch(JENA_UPDATE, {
      method:  'POST',
      headers: { 'Content-Type': 'application/sparql-update' },
      body:    sparqlOp
    })
    if (!resp.ok) {
      const txt = await resp.text()
      return res.status(502).json({ error: `Fuseki graph-op failed: ${txt.slice(0,200)}` })
    }
    // Refresh named graphs list
    namedGraphs = await discoverGraphs(JENA_SPARQL)
    return res.json({ operation: op, source: source ?? null, target, ok: true, sparql: sparqlOp })
  } catch (err) {
    console.error('[Bridge] /graph-op error:', err)
    return res.status(500).json({ error: err.message })
  }
})

// -- POST /pipeline ------------------------------------------------------------
//
// [NON-CANONICAL] Register, update, or delete a pipeline manifest.
//
// Register: { id, label?, description?, signalType, holdingGraph, shapesGraph?,
//             promotionRule, violationRule?, warningRule?, reportGraph?,
//             contextGraph, retainOnViolation?, defaultWarningPolicy? }
// Delete:   { id, delete: true }

app.post('/pipeline', async (req, res) => {
  const { id, label, description, signalType, holdingGraph, shapesGraph,
          promotionRule, violationRule, warningRule, reportGraph, contextGraph,
          retainOnViolation, defaultWarningPolicy, delete: del } = req.body ?? {}

  if (!id || typeof id !== 'string' || !id.trim())
    return res.status(400).json({ error: '"id" is required.' })

  const graphIri    = namedPipelinesGraphIri()
  const pipelineIri = `${graphIri}:${id.trim()}`
  const HB          = 'https://w3id.org/holonbridge/'
  const DCTERMS     = 'http://purl.org/dc/terms/'
  const escape      = s => s.replace(/\\/g,'\\\\').replace(/"""/g,'\\"\\"\\"')

  if (del) {
    const deleteSparql = `
PREFIX dcterms: <${DCTERMS}>
WITH <${graphIri}>
DELETE { ?p ?pr ?o } WHERE { ?p dcterms:identifier """${id}""" ; ?pr ?o }`
    try {
      await fetch(JENA_UPDATE, { method:'POST',
        headers:{'Content-Type':'application/sparql-update'}, body: deleteSparql })
      namedPipelines = namedPipelines.filter(p => p.id !== id)
      return res.json({ deleted: true, id })
    } catch (err) {
      return res.status(500).json({ error: err.message })
    }
  }

  if (!signalType || !holdingGraph || !promotionRule || !contextGraph)
    return res.status(400).json({ error: '"signalType", "holdingGraph", "promotionRule", and "contextGraph" are required.' })

  const optionals = [
    label               ? `    <${DCTERMS}title>              """${escape(label)}""" ;`        : null,
    description         ? `    <${DCTERMS}description>        """${escape(description)}""" ;`  : null,
    shapesGraph         ? `    <${HB}shapesGraph>             <${shapesGraph}> ;`              : null,
    violationRule       ? `    <${HB}violationRule>           """${escape(violationRule)}""" ;`: null,
    warningRule         ? `    <${HB}warningRule>             """${escape(warningRule)}""" ;`  : null,
    reportGraph         ? `    <${HB}reportGraph>             <${reportGraph}> ;`              : null,
    retainOnViolation !== undefined
                        ? `    <${HB}retainOnViolation>       "${!!retainOnViolation}"^^<http://www.w3.org/2001/XMLSchema#boolean> ;` : null,
    defaultWarningPolicy? `    <${HB}defaultWarningPolicy>   <${HB}${defaultWarningPolicy}> ;`: null,
  ].filter(Boolean).join('\n')

  const insertSparql = `
PREFIX hb:      <${HB}>
PREFIX dcterms: <${DCTERMS}>

WITH <${graphIri}>
DELETE { ?p ?pr ?o } WHERE { ?p dcterms:identifier """${id}""" ; ?pr ?o } ;

INSERT DATA {
  GRAPH <${graphIri}> {
    <${pipelineIri}>
      a hb:Pipeline ;
      dcterms:identifier    """${escape(id)}""" ;
      hb:signalType         <${signalType}> ;
      hb:holdingGraph       <${holdingGraph}> ;
      hb:promotionRule      """${escape(promotionRule)}""" ;
      hb:contextGraph       <${contextGraph}> ;
${optionals}
      hb:defaultWarningPolicy hb:${defaultWarningPolicy ?? 'Block'} .
  }
}`

  try {
    const resp = await fetch(JENA_UPDATE, { method:'POST',
      headers:{'Content-Type':'application/sparql-update'}, body: insertSparql })
    if (!resp.ok) return res.status(502).json({ error: `Fuseki update failed` })
    namedPipelines = await loadNamedPipelinesFromGraph()
    console.log(`[Bridge] Pipeline '${id}' registered`)
    return res.json({ registered: true, id, signalType, contextGraph })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// -- GET /pipelines ------------------------------------------------------------

app.get('/pipelines', (_req, res) => {
  res.json({
    total:         namedPipelines.length,
    pipelinesGraph: namedPipelinesGraphIri(),
    pipelines:     namedPipelines.map(({ id, label, signalType, contextGraph,
                                         promotionRule, violationRule, warningRule,
                                         defaultWarningPolicy }) =>
                     ({ id, label, signalType, contextGraph,
                        promotionRule, violationRule, warningRule, defaultWarningPolicy }))
  })
})

// -- POST /ingest --------------------------------------------------------------
//
// [NON-CANONICAL] Submit a signal through a named pipeline.
// Pattern A: JSON body with payload string (bridge auto-wraps)
// Pattern B: text/turtle body with pre-wrapped hb:Message
// Returns 202 Accepted with messageId and statusUrl.
// Add "sync": true for synchronous execution (dev/test only).

app.post('/ingest', async (req, res) => {
  const contentType = req.headers['content-type'] ?? ''
  const isTurtle    = contentType.includes('text/turtle')

  let messageId, pipelineId, signalType, submittedBy, sourceSystem,
      correlationId, payloadTurtle, sync = false

  if (isTurtle) {
    // Pattern B — pre-wrapped hb:Message in Turtle
    const rawTurtle = req.body?.toString?.() ?? ''
    // Extract messageId from Turtle heuristically (look for hb:messageId)
    const midMatch  = rawTurtle.match(/hb:messageId\s+"([^"]+)"/)
    const pidMatch  = rawTurtle.match(/hb:pipelineId\s+"([^"]+)"/)
    const stMatch   = rawTurtle.match(/hb:signalType\s+<([^>]+)>/)
    messageId   = midMatch?.[1] ?? randomUUID()
    pipelineId  = pidMatch?.[1] ?? ''
    signalType  = stMatch?.[1]  ?? ''
    payloadTurtle = rawTurtle
  } else {
    // Pattern A — JSON body, bridge auto-wraps
    const body = req.body ?? {}
    messageId    = randomUUID()
    pipelineId   = body.pipelineId   ?? ''
    signalType   = body.signalType   ?? ''
    submittedBy  = body.submittedBy  ?? null
    sourceSystem = body.sourceSystem ?? null
    correlationId = body.correlationId ?? null
    payloadTurtle = body.payload     ?? ''
    sync         = body.sync === true
  }

  if (!pipelineId && !signalType)
    return res.status(400).json({ error: '"pipelineId" or "signalType" is required.' })
  if (!payloadTurtle.trim())
    return res.status(400).json({ error: '"payload" is required.' })

  const pipeline = namedPipelines.find(p => p.id === pipelineId)
               ?? namedPipelines.find(p => p.signalType === signalType)
  if (!pipeline)
    return res.status(404).json({ error: `No pipeline found for id '${pipelineId}' or signalType '${signalType}'.` })

  const holdingGraph  = pipeline.holdingGraph ?? `urn:${DATASET}:holding:${messageId}`
  const payloadGraph  = `${holdingGraph}:payload`
  const now           = new Date().toISOString()

  // Build envelope Turtle
  const envelopeTurtle = `
PREFIX hb:  <https://w3id.org/holonbridge/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
<urn:${DATASET}:message:${messageId}>
  a hb:Message ;
  hb:messageId     "${messageId}" ;
  hb:signalType    <${signalType || pipeline.signalType}> ;
  hb:pipelineId    "${pipelineId || pipeline.id}" ;
  hb:submittedAt   "${now}"^^xsd:dateTime ;
  hb:payloadGraph  <${payloadGraph}> ;
  hb:status        hb:Pending${submittedBy  ? ` ;\n  hb:submittedBy   <${submittedBy}>` : ''}${sourceSystem  ? ` ;\n  hb:sourceSystem  "${sourceSystem}"` : ''}${correlationId ? ` ;\n  hb:correlationId "${correlationId}"` : ''} .`

  // Store initial status
  messageStore.set(messageId, {
    messageId, pipelineId: pipeline.id, signalType: signalType || pipeline.signalType,
    submittedAt: now, submittedBy, holdingGraph, payloadGraph,
    status: 'hb:Pending', eventIri: null, reportIri: null, note: null, resolvedAt: null
  })

  // Push envelope to holding graph and payload to payload graph
  try {
    await fetch(`${JENA_GSP}?graph=${encodeURIComponent(holdingGraph)}`, {
      method: 'POST', headers: { 'Content-Type': 'text/turtle' }, body: envelopeTurtle
    })
    await fetch(`${JENA_GSP}?graph=${encodeURIComponent(payloadGraph)}`, {
      method: 'POST', headers: { 'Content-Type': 'text/turtle' }, body: payloadTurtle
    })
  } catch (err) {
    messageStore.delete(messageId)
    return res.status(502).json({ error: `Failed to push to holding graph: ${err.message}` })
  }

  console.log(`[Bridge] /ingest accepted messageId='${messageId}' pipeline='${pipeline.id}'`)

  if (sync) {
    await runIngestPipeline(messageId)
    const msg = messageStore.get(messageId)
    return res.json({ messageId, pipelineId: pipeline.id, ...msg })
  }

  // Async — fire and forget
  setImmediate(() => runIngestPipeline(messageId))

  return res.status(202).json({
    accepted:   true,
    messageId,
    pipelineId: pipeline.id,
    statusUrl:  `/message/${messageId}`
  })
})

// -- POST /pipeline-run --------------------------------------------------------
//
// [NON-CANONICAL] Trigger pipeline execution on a pre-populated holding graph.
// Pattern C: payload already pushed; call this to begin validation + routing.

app.post('/pipeline-run', async (req, res) => {
  const { messageId } = req.body ?? {}

  if (!messageId || typeof messageId !== 'string')
    return res.status(400).json({ error: '"messageId" is required.' })

  const msg = messageStore.get(messageId)
  if (!msg)
    return res.status(404).json({ error: `Message '${messageId}' not found. Use POST /ingest first.` })

  if (msg.status !== 'hb:Pending')
    return res.status(409).json({ error: `Message '${messageId}' is not Pending (status: ${msg.status}).` })

  console.log(`[Bridge] /pipeline-run triggered for '${messageId}'`)
  setImmediate(() => runIngestPipeline(messageId))

  return res.status(202).json({
    triggered:  true,
    messageId,
    pipelineId: msg.pipelineId,
    statusUrl:  `/message/${messageId}`
  })
})

// -- GET /message/:id ----------------------------------------------------------
//
// Poll the status of an in-flight or resolved message.

app.get('/message/:id', (req, res) => {
  const messageId = req.params.id
  const msg = messageStore.get(messageId)

  if (!msg)
    return res.status(404).json({
      error: `Message '${messageId}' not found. Status store is in-memory and resets on bridge restart.`
    })

  return res.json({
    messageId:   msg.messageId,
    pipelineId:  msg.pipelineId,
    signalType:  msg.signalType,
    status:      msg.status,
    submittedAt: msg.submittedAt,
    resolvedAt:  msg.resolvedAt ?? null,
    eventIri:    msg.eventIri  ?? null,
    reportIri:   msg.reportIri ?? null,
    note:        msg.note      ?? null
  })
})

// -- GET /registry -------------------------------------------------------------
//
// List all registered HolonBridge instances with live reachability status.
// Probes each bridge's /health endpoint on every call — never cached.

app.get('/registry', async (_req, res) => {
  try {
    const health  = await probeReachability()
    const entries = [...health.entries()].map(([iri, v]) => ({
      iri,
      label:     v.label,
      url:       v.url,
      reachable: v.reachable,
      latencyMs: v.latencyMs ?? null,
      error:     v.error     ?? null,
    }))
    res.json({ bridges: entries, graphs: REGISTRY_GRAPHS })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// -- POST /registry/refresh ----------------------------------------------------
//
// Force a full registry cache refresh from GitHub, bypassing the TTL check.

app.post('/registry/refresh', async (_req, res) => {
  try {
    const cache     = await loadRegistryCache({ cacheMaxAgeMs: 0 })
    const endpoints = await resolveEndpoints()
    res.json({
      refreshed:          true,
      graphsUpdated:      cache.graphsUpdated,
      endpointsRefreshed: endpoints.refreshed,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// -- POST /validate -----------------------------------------------------------
// Validate a named data graph against a named shapes graph in the dataset.
// Body: { dataGraph: "<IRI>", shapesGraph?: "<IRI>" }

app.post('/validate', async (req, res) => {
  await validateHandler(req, res, { JENA_BASE, DATASET, SHACL_GRAPH })
})

// -- GET /holon and GET /holon/:iri ----------------------------------------------
//
// Retrieve a holon as a projection DataBook (text/markdown). See
// lib/holon.js for full documentation, including the namespace-
// reconciliation note against lib/lifecycle.js's newer holon model and
// the default-focus resolution mechanism below.
//
// GET /holon/:iri -- :iri is the full holon IRI, percent-encoded by the
// caller as a single path segment (Express decodes route params
// automatically).
//
// GET /holon (no :iri) -- resolves the holon to show via persisted focus
// for the active dataset, falling back to that dataset's holon:Home
// instance. Both routes accept the same query param:
// projection=immersive|cinematic|active_inference|exploded_view
// (default: immersive). Every successful call on either route persists
// its resolved IRI as the new focus for DATASET.

app.get('/holon', async (req, res) => {
  await getHolonHandler(req, res, { JENA_SPARQL, DATASET })
})

app.get('/holon/:iri', async (req, res) => {
  await getHolonHandler(req, res, { JENA_SPARQL, DATASET })
})

// -- 404 fallback --------------------------------------------------------------

app.use((_req, res) => {
  res.status(404).json({
    error: 'Not found.',
    available: [
      'POST /query', 'POST /update', 'POST /sparql-update', 'POST /sparql-select', 'POST /sparql-construct', 'POST /describe',
      'POST /reload', 'POST /dataset', 'POST /fuseki-url', 'POST /shacl-mode',
      'POST /named-query', 'POST /named-rule', 'POST /rule', 'POST /graph-op',
      'POST /pipeline', 'POST /ingest', 'POST /pipeline-run',
      'GET  /datasets', 'GET  /graphs', 'GET  /graph',
      'GET  /named-queries', 'GET  /named-rules', 'GET  /pipelines',
      'GET  /message/:id', 'GET  /description', 'GET  /health',
        'POST /validate',
        'GET  /holon', 'GET  /holon/:iri',
        'GET  /registry', 'POST /registry/refresh'
    ]
  })
})

// --- Start --------------------------------------------------------------------

loadContext()
  .then(() => {
    startWatcher()
    app.listen(PORT, () => {
      console.log(`[Bridge] HolonBridge v2.9.0 running on port ${PORT}`)
      console.log(`[Bridge] Dataset:        ${DATASET}`)
      console.log(`[Bridge] Context dir:    ${getContextDir()}`)
      console.log(`[Bridge] SPARQL:         ${JENA_SPARQL}`)
      console.log(`[Bridge] GSP:            ${JENA_GSP}`)
      console.log(`[Bridge] SHACL graph:    ${SHACL_GRAPH}`)
      console.log(`[Bridge] Model:          ${MODEL}  Max retries: ${MAX_RETRIES}`)
    })

    // Registry bootstrap — async, does not block server startup
    initSession().then(({ health }) => {
      const up = [...health.values()].filter(v => v.reachable).length
      console.log(`[registry] ${up}/${health.size} bridge(s) reachable`)
    }).catch(err => {
      console.warn('[registry] Session init error (non-fatal):', err.message)
    })
  })
  .catch(err => {
    console.error('[Bridge] Failed to load schema context:', err.message)
    process.exit(1)
  })
