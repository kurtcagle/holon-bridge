/**
 * conn.js -- Per-request connection resolution
 *
 * One place that answers "which dataset is THIS request talking to, and what
 * are the endpoints and graph IRIs for it". Replaces the two half-answers that
 * exist today: the module-level DATASET/JENA_BASE/JENA_SPARQL/JENA_UPDATE/
 * JENA_GSP/SHACL_GRAPH globals in server.js, and the four req.* values the
 * v2.10.0 dataset-override middleware computes from X-Dataset-Override.
 *
 * -- Why this exists --
 *
 * The override middleware fixed a real cross-user bug: before it, "which
 * dataset am I querying" was a single process-wide value, so one caller's
 * POST /dataset (or an MCP client's switch_dataset) silently changed what
 * every other concurrently connected caller was reading. But it fixed that
 * only for the routes converted to read req.* -- server.js's own comment
 * names the ones that weren't: /describe, /named-query, /named-rule, /rule,
 * /graph-op, /pipeline*, /ingest, /registry*, /graph. Those still read the
 * globals unconditionally, so sending them X-Dataset-Override operates
 * against the wrong dataset without erroring.
 *
 * That is a correctness gap rather than untidiness, and it is the reason to
 * do this BEFORE the remaining route-module extractions on server.js's
 * roadmap rather than after. Extracting those routes as they stand copies the
 * gap into five files and forces a per-route judgement about which source of
 * truth to read -- a judgement that will be made inconsistently. Collapsing to
 * a single req.conn first makes each extraction mechanical.
 *
 * It also retires the getter-bag pattern. lib/routes/holon-lifecycle.js
 * currently needs getDataset/getJenaBase/getJenaSparql/getJenaGsp/
 * getDatasetHolonIri passed at mount time, purely to reach server.js's mutable
 * lets. That was a sound bridge for one extraction; repeated five more times it
 * becomes six lists of getters to keep in sync while the coupling stays exactly
 * where it was. Routes reading req.conn need no getters at all.
 *
 * -- Migration path --
 *
 * attachConn() sets req.conn AND keeps writing the four v2.10.0 fields
 * (req.sparqlEndpoint, req.gspEndpoint, req.updateEndpoint, req.shaclGraph)
 * plus req.datasetOverride, with identical values to what the old middleware
 * produced. Every already-converted route therefore keeps working untouched,
 * and routes can move to req.conn one at a time rather than in a big bang.
 * Delete the aliases once nothing reads them -- CONN_ALIASES below is the
 * list to grep for.
 *
 * -- KNOWN GAP: SHACL_GRAPH under override --
 *
 * The env var SHACL_GRAPH, when set, pins ONE shapes graph for every dataset,
 * including overridden ones -- so a request for dataset B validates against
 * dataset A's shapes. That behaviour is inherited verbatim from the v2.10.0
 * middleware and is preserved here deliberately: changing it silently would
 * alter validation outcomes for anyone relying on the pin. It is almost
 * certainly wrong for the override path and worth a separate decision.
 * Unset SHACL_GRAPH and every dataset gets its own urn:{dataset}:shacl.
 */

/**
 * The pre-req.conn field names, kept as aliases during migration.
 * Grep for these to find routes still reading the old shape.
 */
export const CONN_ALIASES = ['sparqlEndpoint', 'gspEndpoint', 'updateEndpoint', 'shaclGraph']

/**
 * Build a complete connection descriptor for a dataset.
 *
 * Every derived endpoint and conventional graph IRI is computed here, so that
 * the urn:{dataset}:* conventions live in exactly one place instead of being
 * re-spelled at each call site (server.js currently rebuilds them in
 * rebuildEndpoints(), namedQueriesGraphIri(), namedRulesGraphIri(),
 * namedPipelinesGraphIri(), the /sequence routes, runIngestPipeline(), and
 * the pipeline loader's reportGraph default).
 *
 * @param {object}  opts
 * @param {string}  opts.dataset            Dataset name
 * @param {string}  opts.jenaBase           Fuseki base URL (trailing slashes stripped)
 * @param {boolean} [opts.overridden]       True when this came from X-Dataset-Override
 * @param {string}  [opts.datasetHolonIri]  Lifecycle anchor; null falls back to rootHolonIri
 * @param {string}  [opts.sparqlEndpoint]   Explicit override (the legacy JENA_ENDPOINT env var)
 * @param {string}  [opts.shaclGraph]       Explicit override (the SHACL_GRAPH env var)
 * @returns {object} conn
 */
export function buildConn({
  dataset, jenaBase, overridden = false, datasetHolonIri = null,
  sparqlEndpoint = null, shaclGraph = null
}) {
  if (!dataset || typeof dataset !== 'string' || !dataset.trim())
    throw new Error('buildConn: dataset must be a non-empty string')
  if (!jenaBase || typeof jenaBase !== 'string' || !jenaBase.trim())
    throw new Error('buildConn: jenaBase must be a non-empty string')

  const ds   = dataset.trim()
  const base = jenaBase.trim().replace(/\/+$/, '')

  return {
    dataset:    ds,
    overridden,
    jenaBase:   base,

    // Endpoints. sparqlEndpoint accepts an explicit override because the
    // legacy JENA_ENDPOINT env var replaces the SPARQL URL wholesale rather
    // than being derived from base + dataset. Note it is NOT applied on the
    // override path in server.js's current middleware either -- an override
    // request builds from jenaBase regardless. Preserved as-is.
    sparqlEndpoint: sparqlEndpoint ?? `${base}/${ds}/sparql`,
    updateEndpoint: `${base}/${ds}/update`,
    gspEndpoint:    `${base}/${ds}/data`,

    shaclGraph: shaclGraph ?? `urn:${ds}:shacl`,

    // Lifecycle anchor. null here is meaningful, not missing: lib/lifecycle.js's
    // datasetAnchor() falls back to the urn:{dataset}:root convention itself, so
    // the default deliberately lives in one place rather than being duplicated.
    // rootHolonIri is exposed for callers that want to show the fallback (e.g.
    // GET /description) without reimplementing it.
    datasetHolonIri,
    rootHolonIri: `urn:${ds}:root`,

    // Conventional graph IRIs for this dataset.
    namedQueriesGraph:   `urn:${ds}:named-queries`,
    namedRulesGraph:     `urn:${ds}:named-rules`,
    namedPipelinesGraph: `urn:${ds}:named-pipelines`,
    reportGraph:         `urn:${ds}:reports`,

    // Sequence-counter convention defaults (see lib/sequence.js). Datasets set
    // up before this convention -- Bridgerton uses urn:data:holons and a
    // sportsleague:-namespaced counter IRI -- must still pass both explicitly.
    sequenceGraph:      `urn:${ds}:holons`,
    sequenceCounterIri: `urn:${ds}:sequence-counter`
  }
}

/**
 * Express middleware factory: attach req.conn for every request.
 *
 * Takes a getter rather than values because server.js's dataset config is
 * mutable at runtime (POST /dataset, POST /fuseki-url, POST /shacl-mode,
 * POST /dataset-holon-iri all reassign it). The getter is called per request,
 * so a switch takes effect immediately -- same reason
 * lib/routes/holon-lifecycle.js takes getters today. The difference is that
 * this is the LAST place that needs them.
 *
 * @param {() => {dataset: string, jenaBase: string, sparqlEndpoint?: string,
 *                shaclGraph?: string, datasetHolonIri?: string|null}} getGlobals
 * @returns {import('express').RequestHandler}
 */
export function attachConn(getGlobals) {
  return function connMiddleware(req, _res, next) {
    const g = getGlobals()

    const header   = req.headers['x-dataset-override']
    const override = (header && String(header).trim()) ? String(header).trim() : null

    req.conn = override
      ? buildConn({
          dataset:         override,
          jenaBase:        g.jenaBase,
          overridden:      true,
          datasetHolonIri: g.datasetHolonIri ?? null,
          // See the KNOWN GAP note at the top of this file.
          shaclGraph:      process.env.SHACL_GRAPH ?? null
        })
      : buildConn({
          dataset:         g.dataset,
          jenaBase:        g.jenaBase,
          overridden:      false,
          datasetHolonIri: g.datasetHolonIri ?? null,
          sparqlEndpoint:  g.sparqlEndpoint ?? null,
          shaclGraph:      g.shaclGraph ?? null
        })

    // -- Back-compat aliases, delete once nothing reads them ------------------
    req.datasetOverride = override
    for (const key of CONN_ALIASES) req[key] = req.conn[key]

    next()
  }
}

/**
 * Read the connection off a request, with a clear failure when the middleware
 * was never mounted. Prefer this over touching req.conn directly in route
 * modules -- an undefined req.conn otherwise surfaces as a
 * "cannot read property of undefined" several frames away from the cause.
 *
 * @param {import('express').Request} req
 * @returns {object} conn
 */
export function connOf(req) {
  if (!req?.conn)
    throw new Error('req.conn is not set -- attachConn() middleware is not mounted, or this route is mounted before it')
  return req.conn
}
