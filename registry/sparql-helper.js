'use strict';

/**
 * registry/sparql-helper.js
 *
 * Thin SPARQL/GSP helper used by session-init to read from and write
 * to the local Jena Fuseki instance. Wraps raw fetch() calls against
 * Fuseki's HTTP endpoints — no external dependencies beyond Node 18+.
 *
 * All graph operations target the local Fuseki directly (not through
 * HolonBridge) because the registry bootstrap runs before HolonBridge
 * has a fully initialised context.
 */

/**
 * Execute a SPARQL SELECT query against Fuseki.
 * Returns an array of binding objects: [{ var: { type, value }, ... }]
 */
async function sparqlSelect(fusekiBase, dataset, query) {
  const url = `${fusekiBase}/${dataset}/sparql`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/sparql-query',
      'Accept':       'application/sparql-results+json',
    },
    body: query,
  });

  if (!res.ok) {
    throw new Error(`SPARQL SELECT failed [${res.status}]: ${await res.text()}`);
  }

  const json = await res.json();
  return json.results.bindings;
}

/**
 * Execute a SPARQL UPDATE against Fuseki.
 */
async function sparqlUpdate(fusekiBase, dataset, update) {
  const url = `${fusekiBase}/${dataset}/update`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sparql-update' },
    body: update,
  });

  if (!res.ok) {
    throw new Error(`SPARQL UPDATE failed [${res.status}]: ${await res.text()}`);
  }
}

/**
 * Replace a named graph via Graph Store Protocol PUT.
 * Equivalent to CLEAR GRAPH + INSERT — idempotent on re-run.
 */
async function gspPut(fusekiBase, dataset, graphIRI, turtle) {
  const url = `${fusekiBase}/${dataset}?graph=${encodeURIComponent(graphIRI)}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/turtle' },
    body: turtle,
  });

  if (!res.ok) {
    throw new Error(`GSP PUT failed [${res.status}] ${graphIRI}: ${await res.text()}`);
  }
}

/**
 * Returns the age in milliseconds of a named graph,
 * based on the most recent dcterms:modified triple it contains.
 * Returns null if the graph doesn't exist or has no modified timestamp.
 */
async function graphAge(fusekiBase, dataset, graphIRI) {
  const query = `
    PREFIX dcterms: <http://purl.org/dc/terms/>
    SELECT ?modified WHERE {
      GRAPH <${graphIRI}> {
        ?s dcterms:modified ?modified .
      }
    }
    ORDER BY DESC(?modified)
    LIMIT 1
  `;

  try {
    const bindings = await sparqlSelect(fusekiBase, dataset, query);
    if (!bindings.length) return null;

    const modifiedStr = bindings[0].modified?.value;
    if (!modifiedStr) return null;

    const modifiedMs = new Date(modifiedStr).getTime();
    return Date.now() - modifiedMs;
  } catch {
    return null;   // graph absent or query error — treat as missing
  }
}

/**
 * Returns all bridge IRIs currently in the registry graph
 * along with their endpoint record IRIs and TTL status.
 *
 * Used by session-init to identify stale endpoint records.
 */
async function queryStaleEndpoints(fusekiBase, dataset, {
  registryGraph,
  endpointGraph,
}) {
  const HB = 'https://w3id.org/holonbridge/ontology/';

  const query = `
    PREFIX hb:      <${HB}>
    PREFIX dcterms: <http://purl.org/dc/terms/>

    SELECT ?bridge ?endpointRecord ?modified ?ttl WHERE {
      GRAPH <${registryGraph}> {
        ?bridge a hb:HolonBridge ;
                hb:resolvedBy ?endpointRecord .
      }
      OPTIONAL {
        GRAPH <${endpointGraph}> {
          ?endpointRecord dcterms:modified ?modified ;
                          hb:ttl           ?ttl .
        }
      }
    }
  `;

  const bindings = await sparqlSelect(fusekiBase, dataset, query);

  const now = Date.now();
  return bindings.map(b => {
    const bridgeIRI       = b.bridge?.value;
    const endpointIRI     = b.endpointRecord?.value;
    const modifiedStr     = b.modified?.value;
    const ttlStr          = b.ttl?.value;   // e.g. "PT24H", "P7D"

    let isStale = true;
    if (modifiedStr && ttlStr) {
      const modifiedMs = new Date(modifiedStr).getTime();
      const ttlMs      = parseDuration(ttlStr);
      isStale = now > modifiedMs + ttlMs;
    }

    return { bridgeIRI, endpointIRI, isStale };
  });
}

/**
 * Query the registry for all bridges and their current endpoint URLs.
 * Used by session-init for reachability probing.
 */
async function queryBridgeEndpoints(fusekiBase, dataset, {
  registryGraph,
  endpointGraph,
}) {
  const HB = 'https://w3id.org/holonbridge/ontology/';

  const query = `
    PREFIX hb:    <${HB}>
    PREFIX rdfs:  <http://www.w3.org/2000/01/rdf-schema#>

    SELECT ?bridge ?label ?url ?tailscale ?accessPolicy WHERE {
      GRAPH <${registryGraph}> {
        ?bridge a hb:HolonBridge ;
                hb:resolvedBy   ?rec ;
                hb:accessPolicy ?accessPolicy .
        OPTIONAL { ?bridge rdfs:label ?label }
      }
      GRAPH <${endpointGraph}> {
        ?rec hb:endpointURL ?url .
        OPTIONAL { ?rec hb:tailscaleHost ?tailscale }
      }
    }
  `;

  return sparqlSelect(fusekiBase, dataset, query);
}

/**
 * Parse ISO 8601 duration string to milliseconds.
 * Handles P7D, PT24H, P1Y, PT30M — covers the cases we actually use.
 * Not a full ISO 8601 implementation.
 */
function parseDuration(str) {
  const RE = /P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/;
  const m  = RE.exec(str);
  if (!m) return 0;

  const [, years = 0, months = 0, days = 0,
           hours = 0, minutes = 0, seconds = 0] = m.map(Number);

  return (
    years   * 365 * 24 * 60 * 60 * 1000 +
    months  *  30 * 24 * 60 * 60 * 1000 +
    days    *       24 * 60 * 60 * 1000 +
    hours   *            60 * 60 * 1000 +
    minutes *                 60 * 1000 +
    seconds *                      1000
  );
}

module.exports = {
  sparqlSelect,
  sparqlUpdate,
  gspPut,
  graphAge,
  queryStaleEndpoints,
  queryBridgeEndpoints,
  parseDuration,
};
