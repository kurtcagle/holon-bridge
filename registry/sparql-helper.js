/**
 * registry/sparql-helper.js
 *
 * Thin SPARQL/GSP helper for registry operations against local Jena Fuseki.
 * Wraps raw fetch() — no external dependencies beyond Node 18+.
 *
 * All graph operations target Fuseki directly (not through HolonBridge)
 * because the registry bootstrap runs before HolonBridge has a fully
 * initialised context.
 */

/**
 * Execute a SPARQL SELECT query against Fuseki.
 * Returns an array of binding objects.
 */
export async function sparqlSelect(fusekiBase, dataset, query) {
  const url = `${fusekiBase}/${dataset}/sparql`
  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/sparql-query',
      'Accept':       'application/sparql-results+json',
    },
    body: query,
  })
  if (!res.ok)
    throw new Error(`SPARQL SELECT failed [${res.status}]: ${await res.text()}`)
  const json = await res.json()
  return json.results.bindings
}

/**
 * Execute a SPARQL UPDATE against Fuseki.
 */
export async function sparqlUpdate(fusekiBase, dataset, update) {
  const url = `${fusekiBase}/${dataset}/update`
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/sparql-update' },
    body:    update,
  })
  if (!res.ok)
    throw new Error(`SPARQL UPDATE failed [${res.status}]: ${await res.text()}`)
}

/**
 * Replace a named graph via Graph Store Protocol PUT.
 * Idempotent — safe to call on every pipeline run.
 */
export async function gspPut(fusekiBase, dataset, graphIRI, turtle) {
  const url = `${fusekiBase}/${dataset}?graph=${encodeURIComponent(graphIRI)}`
  const res = await fetch(url, {
    method:  'PUT',
    headers: { 'Content-Type': 'text/turtle' },
    body:    turtle,
  })
  if (!res.ok)
    throw new Error(`GSP PUT failed [${res.status}] ${graphIRI}: ${await res.text()}`)
}

/**
 * Returns the age in milliseconds of a named graph, based on the most
 * recent dcterms:modified triple it contains.
 * Returns null if the graph doesn't exist or has no modified timestamp.
 */
export async function graphAge(fusekiBase, dataset, graphIRI) {
  const query = `
    PREFIX dcterms: <http://purl.org/dc/terms/>
    SELECT ?modified WHERE {
      GRAPH <${graphIRI}> { ?s dcterms:modified ?modified . }
    }
    ORDER BY DESC(?modified) LIMIT 1`
  try {
    const bindings = await sparqlSelect(fusekiBase, dataset, query)
    if (!bindings.length) return null
    const modifiedStr = bindings[0].modified?.value
    if (!modifiedStr) return null
    return Date.now() - new Date(modifiedStr).getTime()
  } catch {
    return null   // graph absent — treat as missing
  }
}

/**
 * Returns all bridge IRIs whose endpoint records are absent or past TTL.
 * Used by resolveEndpoints() to decide what needs refreshing.
 */
export async function queryStaleEndpoints(fusekiBase, dataset, { registryGraph, endpointGraph }) {
  const HB = 'https://w3id.org/holonbridge/ontology/'
  const query = `
    PREFIX hb:      <${HB}>
    PREFIX dcterms: <http://purl.org/dc/terms/>
    SELECT ?bridge ?endpointRecord ?modified ?ttl WHERE {
      GRAPH <${registryGraph}> {
        ?bridge a hb:HolonBridge ; hb:resolvedBy ?endpointRecord .
      }
      OPTIONAL {
        GRAPH <${endpointGraph}> {
          ?endpointRecord dcterms:modified ?modified ; hb:ttl ?ttl .
        }
      }
    }`
  const bindings = await sparqlSelect(fusekiBase, dataset, query)
  const now = Date.now()
  return bindings.map(b => {
    const modifiedStr = b.modified?.value
    const ttlStr      = b.ttl?.value
    let isStale = true
    if (modifiedStr && ttlStr) {
      isStale = now > new Date(modifiedStr).getTime() + parseDuration(ttlStr)
    }
    return {
      bridgeIRI:   b.bridge?.value,
      endpointIRI: b.endpointRecord?.value,
      isStale,
    }
  })
}

/**
 * Query all bridges and their current endpoint URLs.
 * Used by probeReachability() to build the health-check target list.
 */
export async function queryBridgeEndpoints(fusekiBase, dataset, { registryGraph, endpointGraph }) {
  const HB = 'https://w3id.org/holonbridge/ontology/'
  const query = `
    PREFIX hb:   <${HB}>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    SELECT ?bridge ?label ?url ?tailscale ?accessPolicy WHERE {
      GRAPH <${registryGraph}> {
        ?bridge a hb:HolonBridge ; hb:resolvedBy ?rec ; hb:accessPolicy ?accessPolicy .
        OPTIONAL { ?bridge rdfs:label ?label }
      }
      GRAPH <${endpointGraph}> {
        ?rec hb:endpointURL ?url .
        OPTIONAL { ?rec hb:tailscaleHost ?tailscale }
      }
    }`
  return sparqlSelect(fusekiBase, dataset, query)
}

/**
 * Parse ISO 8601 duration string to milliseconds.
 * Handles the subset we actually use: P7D, PT24H, P1Y, PT30M.
 */
export function parseDuration(str) {
  const m = /P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/.exec(str)
  if (!m) return 0
  const [, Y=0, Mo=0, D=0, H=0, Mi=0, S=0] = m.map(Number)
  return Y*365*86400000 + Mo*30*86400000 + D*86400000 + H*3600000 + Mi*60000 + S*1000
}
