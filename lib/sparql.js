/**
 * sparql.js -- Jena SPARQL / GSP client
 *
 * Covers SELECT, CONSTRUCT, Graph Store Protocol push, and SHACL-graph
 * presence checks.  All network calls share the same timeout/abort pattern.
 */

const SPARQL_TIMEOUT_MS = 15_000
const GSP_TIMEOUT_MS    = 30_000   // writes can be slower

const GRAPH_DISCOVERY_QUERY = `
SELECT DISTINCT ?g
WHERE { GRAPH ?g { } }
ORDER BY ?g
`.trim()

// --- Error class -------------------------------------------------------------

export class SparqlError extends Error {
  constructor(message, statusCode, jenaMessage) {
    super(message)
    this.name        = 'SparqlError'
    this.statusCode  = statusCode
    this.jenaMessage = jenaMessage   // raw error text from Jena
  }
}

// --- Internal helpers --------------------------------------------------------

function makeController(ms) {
  const controller = new AbortController()
  const timer      = setTimeout(() => controller.abort(), ms)
  return { controller, clear: () => clearTimeout(timer) }
}

async function jenaFetch(url, init, timeoutMs = SPARQL_TIMEOUT_MS) {
  const { controller, clear } = makeController(timeoutMs)
  let response
  try {
    response = await fetch(url, { ...init, signal: controller.signal })
  } catch (err) {
    clear()
    if (err.name === 'AbortError')
      throw new SparqlError('Jena request timed out', 408, `Timed out after ${timeoutMs}ms`)
    throw new SparqlError(`Jena connection error: ${err.message}`, 503, err.message)
  } finally {
    clear()
  }
  return response
}

function extractJenaMessage(text) {
  try {
    const j = JSON.parse(text)
    return j.message ?? j.error ?? text
  } catch (_) {
    return text
  }
}

// --- SELECT ------------------------------------------------------------------

/**
 * Run a SPARQL SELECT query.
 *
 * @param {string}  endpoint  Full SPARQL endpoint URL
 * @param {string}  query     SPARQL SELECT string
 * @param {boolean} log       Log query to console
 * @returns {Promise<{vars: string[], bindings: object[]}>}
 */
export async function runQuery(endpoint, query, log = false) {
  if (log) {
    console.log('[SPARQL] -----------------------------------------')
    console.log(query)
    console.log('[SPARQL] -----------------------------------------')
  }

  const response = await jenaFetch(endpoint, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept':        'application/sparql-results+json'
    },
    body: `query=${encodeURIComponent(query)}`
  })

  const text = await response.text()

  if (!response.ok) {
    throw new SparqlError(
      `Jena responded with HTTP ${response.status}`,
      response.status,
      extractJenaMessage(text)
    )
  }

  let json
  try   { json = JSON.parse(text) }
  catch (_) {
    throw new SparqlError('Jena response was not valid JSON', 500, text.slice(0, 500))
  }

  const vars     = json.results?.bindings !== undefined ? (json.head?.vars ?? []) : []
  const bindings = json.results?.bindings ?? []
  return { vars, bindings }
}

// --- CONSTRUCT ---------------------------------------------------------------

/**
 * Run a SPARQL CONSTRUCT query, returning the result as a Turtle string.
 *
 * @param {string}  endpoint  Full SPARQL endpoint URL
 * @param {string}  query     SPARQL CONSTRUCT string
 * @param {boolean} log       Log query to console
 * @returns {Promise<string>}  Turtle serialisation
 */
export async function runConstruct(endpoint, query, log = false) {
  if (log) {
    console.log('[SPARQL/CONSTRUCT] -------------------------------')
    console.log(query)
    console.log('[SPARQL/CONSTRUCT] -------------------------------')
  }

  const response = await jenaFetch(endpoint, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept':        'application/n-triples'
    },
    body: `query=${encodeURIComponent(query)}`
  })

  const text = await response.text()

  if (!response.ok) {
    throw new SparqlError(
      `Jena CONSTRUCT failed with HTTP ${response.status}`,
      response.status,
      extractJenaMessage(text)
    )
  }

  return text
}

// --- Graph Store Protocol ----------------------------------------------------

/**
 * Push Turtle content to a named (or default) graph via Jena GSP.
 *
 * @param {string} gspEndpoint   Base GSP URL, e.g. http://localhost:3030/ggsc/data
 * @param {string|null} graphIri Named graph IRI, or null for the default graph
 * @param {string} turtle        Turtle content to push
 * @param {'append'|'replace'} mode
 *   'append'  -> HTTP POST  (merges into existing graph)
 *   'replace' -> HTTP PUT   (replaces the graph entirely)
 * @returns {Promise<{status: number, body: string}>}
 */
export async function pushToGraph(gspEndpoint, graphIri, turtle, mode = 'append') {
  const url    = graphIri
    ? `${gspEndpoint}?graph=${encodeURIComponent(graphIri)}`
    : `${gspEndpoint}?default`
  const method = mode === 'replace' ? 'PUT' : 'POST'

  console.log(`[GSP] ${method} -> ${url}  (${turtle.length} chars, mode=${mode})`)

  const response = await jenaFetch(
    url,
    {
      method,
      headers: { 'Content-Type': 'text/turtle' },
      body:    turtle
    },
    GSP_TIMEOUT_MS
  )

  const body = await response.text()

  if (!response.ok) {
    throw new SparqlError(
      `Jena GSP responded with HTTP ${response.status}`,
      response.status,
      extractJenaMessage(body)
    )
  }

  return { status: response.status, body }
}

// --- SHACL graph check -------------------------------------------------------

/**
 * Count triples in the designated SHACL named graph.
 * Returns the count (?0).  Throws SparqlError if Jena is unreachable.
 *
 * Used by the /update pipeline to gate on a non-empty shapes graph.
 *
 * @param {string} sparqlEndpoint   Full SPARQL endpoint URL
 * @param {string} shaclGraphIri    Named graph IRI that holds the SHACL shapes
 * @returns {Promise<number>}
 */
export async function checkShaclGraph(sparqlEndpoint, shaclGraphIri) {
  const query = `SELECT (COUNT(*) AS ?c) WHERE { GRAPH <${shaclGraphIri}> { ?s ?p ?o } }`
  const { bindings } = await runQuery(sparqlEndpoint, query)
  return parseInt(bindings[0]?.c?.value ?? '0', 10)
}

// --- Utilities ----------------------------------------------------------------

/**
 * Pre-format SPARQL JSON bindings into a readable labelled list.
 * Strips IRI angle brackets, drops datatype annotations, collapses blank nodes.
 *
 * @param {string[]}  vars
 * @param {object[]}  bindings
 * @returns {string}
 */
export function formatBindings(vars, bindings) {
  if (bindings.length === 0) return '(no results returned)'

  const lines = []
  bindings.forEach((row, i) => {
    lines.push(`Result ${i + 1}:`)
    for (const v of vars) {
      const cell = row[v]
      if (!cell) continue
      lines.push(`  ${v}: ${formatCell(cell)}`)
    }
  })
  lines.push(`\n(${bindings.length} result${bindings.length !== 1 ? 's' : ''} total)`)
  return lines.join('\n')
}

function formatCell({ type, value, 'xml:lang': lang }) {
  if (type === 'uri')   return value.split(/[/#]/).pop() || value
  if (type === 'bnode') return `_:${value}`
  if (lang)             return `${value} (${lang})`
  return value
}

/**
 * Discover all named graphs in the Jena dataset.
 * Called once at startup; returns an array of IRI strings.
 * Returns [] (with a warning) if Jena is unreachable.
 *
 * @param {string} endpoint  SPARQL endpoint URL
 * @returns {Promise<string[]>}
 */
export async function discoverGraphs(endpoint) {
  try {
    const { bindings } = await runQuery(endpoint, GRAPH_DISCOVERY_QUERY)
    const graphs = bindings.map(b => b.g?.value).filter(Boolean)
    console.log(`[SPARQL] Discovered ${graphs.length} named graph(s):`)
    graphs.forEach(g => console.log(`  <${g}>`))
    return graphs
  } catch (err) {
    console.warn(`[SPARQL] Graph discovery failed -- queries will target default graph: ${err.message}`)
    return []
  }
}
