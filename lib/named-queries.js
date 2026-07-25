/**
 * named-queries.js -- Named-query registry loading and parameter binding
 *
 * The bridge now understands TWO named-query vocabularies that describe the
 * same kind of thing, and this module is the single place that difference is
 * reconciled.
 *
 * -- Why there are two --
 *
 *   hb:     https://w3id.org/holonbridge/         -- this bridge's own scheme,
 *           the original. dcterms:identifier for the id, hb:sparql for the
 *           body, hb:parameters as a JSON blob.
 *
 *   hquery: https://w3id.org/holon/named-query/   -- the HGA Named Query
 *           Specification v1.0. The id is the IRI's own local name, the body is
 *           hquery:sparql, and each parameter is a first-class hquery:Parameter
 *           node with a name, datatype, description and required flag.
 *
 * hquery: is the later and richer of the two -- parameters are modelled rather
 * than serialised into a string -- and it is what the Bridgerton registry uses.
 * Loading only hb: meant that registry appeared empty to the bridge even though
 * it holds six working queries. Rather than migrate one to the other, this loads
 * both and tags each result with the vocabulary it came from, because the two
 * differ in a way that survives loading: how a parameter reaches the query.
 *
 * -- The substantive difference: parameter binding --
 *
 * An hb: query carries {{placeholders}} and expects raw string substitution
 * (see lib/params.js, and the trust-boundary note there). An hquery: query
 * carries ordinary SPARQL variables -- ?person, ?season -- and expects them to
 * be BOUND. Feeding hquery: parameters through {{...}} substitution silently
 * does nothing: no placeholder matches, the query runs unparameterised, and the
 * caller gets every row instead of the one they asked for. A wrong answer with
 * no error, which is the worst shape a bug can take.
 *
 * So binding dispatches on vocabulary. For hquery: this appends a VALUES clause,
 * which is legal at the very end of a query -- SPARQL 1.1's grammar puts
 * ValuesClause after the whole SelectQuery, past any ORDER BY or LIMIT:
 *
 *     Query ::= Prologue ( SelectQuery | ConstructQuery | ... ) ValuesClause
 *
 * That matters because it means binding needs no parsing of the query body. The
 * alternative -- finding the WHERE block and injecting a VALUES inside it -- is
 * the kind of textual surgery on someone else's SPARQL that goes wrong quietly.
 * Appending is a pure suffix operation and cannot corrupt a well-formed query.
 *
 * Unsupplied parameters are simply not bound, which is exactly the "omit for
 * all" behaviour HGA queries already rely on -- an unbound variable matches
 * everything.
 */

const HQUERY = 'https://w3id.org/holon/named-query/'

// --- Loading ------------------------------------------------------------------

/**
 * Load named queries from a registry graph, reading both vocabularies.
 *
 * @param {object} opts
 * @param {string} opts.sparqlEndpoint  Query endpoint for the dataset
 * @param {string} opts.graphIri        Registry graph, e.g. urn:{dataset}:named-queries
 * @param {function} opts.runQuery      lib/sparql.js's runQuery, injected to keep
 *                                      this module free of transport concerns
 * @param {boolean} [opts.logSparql]
 * @returns {Promise<object[]>} [{ id, label, description, sparql, targetGraph,
 *                                 params, queryType, vocabulary, source }]
 */
export async function loadNamedQueries({ sparqlEndpoint, graphIri, runQuery, logSparql = false }) {
  const hbQueries     = await loadHb({ sparqlEndpoint, graphIri, runQuery, logSparql })
  const hqueryQueries = await loadHquery({ sparqlEndpoint, graphIri, runQuery, logSparql })

  // hb: wins a collision only because it is the older scheme and more likely to
  // be what an existing caller means by that id. Logged rather than silent --
  // two registrations under one id is a registry problem, not a load problem.
  const byId = new Map()
  for (const q of [...hqueryQueries, ...hbQueries]) {
    if (byId.has(q.id))
      console.warn(`[named-queries] id '${q.id}' registered in both vocabularies -- keeping the ${q.vocabulary}: one`)
    byId.set(q.id, q)
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

async function loadHb({ sparqlEndpoint, graphIri, runQuery, logSparql }) {
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
    const { bindings } = await runQuery(sparqlEndpoint, sparql, logSparql)
    return bindings.map(r => {
      let params = []
      if (r.parameters?.value) {
        try { params = JSON.parse(r.parameters.value) } catch (_) { /* malformed blob -- treat as none */ }
      }
      return {
        id:          r.id?.value          ?? '',
        label:       r.label?.value       ?? r.id?.value ?? '',
        description: r.description?.value ?? '',
        sparql:      r.sparql?.value      ?? '',
        targetGraph: r.targetGraph?.value ?? null,
        params,
        queryType:   'SELECT',
        vocabulary:  'hb',
        source:      'rdf'
      }
    }).filter(q => q.id && q.sparql)
  } catch (err) {
    console.warn(`[named-queries] hb: load from <${graphIri}> failed: ${err.message}`)
    return []
  }
}

async function loadHquery({ sparqlEndpoint, graphIri, runQuery, logSparql }) {
  const sparql = `
PREFIX hquery: <${HQUERY}>
PREFIX holon:  <https://w3id.org/holon/>
PREFIX rdfs:   <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?query ?label ?description ?sparql ?queryType
WHERE {
  GRAPH <${graphIri}> {
    ?query a hquery:NamedQuery ;
           hquery:sparql ?sparql .
    OPTIONAL { ?query rdfs:label        ?label }
    OPTIONAL { ?query holon:description ?description }
    OPTIONAL { ?query hquery:queryType  ?queryType }
  }
}
ORDER BY ?query`

  // Parameters are first-class nodes here, not a JSON blob, so they need their
  // own pass and a join. Worth it: this is what lets binding know a parameter's
  // datatype without guessing from the supplied value.
  const paramSparql = `
PREFIX hquery: <${HQUERY}>
SELECT ?query ?name ?datatype ?description ?required
WHERE {
  GRAPH <${graphIri}> {
    ?query a hquery:NamedQuery ;
           hquery:parameter ?p .
    ?p hquery:parameterName ?name .
    OPTIONAL { ?p hquery:parameterDatatype    ?datatype }
    OPTIONAL { ?p hquery:parameterDescription ?description }
    OPTIONAL { ?p hquery:required             ?required }
  }
}`

  try {
    const { bindings } = await runQuery(sparqlEndpoint, sparql, logSparql)
    if (bindings.length === 0) return []

    const paramsByQuery = new Map()
    try {
      const { bindings: pb } = await runQuery(sparqlEndpoint, paramSparql, logSparql)
      for (const r of pb) {
        const q = r.query?.value
        if (!q) continue
        if (!paramsByQuery.has(q)) paramsByQuery.set(q, [])
        paramsByQuery.get(q).push({
          name:        r.name?.value ?? '',
          datatype:    r.datatype?.value ?? null,
          description: r.description?.value ?? '',
          required:    r.required?.value === 'true'
        })
      }
    } catch (err) {
      // Queries without their parameter metadata are still runnable unbound, so
      // degrade rather than dropping the whole registry.
      console.warn(`[named-queries] hquery: parameter load failed: ${err.message}`)
    }

    return bindings.map(r => {
      const iri = r.query?.value ?? ''
      return {
        id:          localName(iri),
        iri,
        label:       r.label?.value       ?? localName(iri),
        description: r.description?.value ?? '',
        sparql:      r.sparql?.value      ?? '',
        targetGraph: null,
        params:      paramsByQuery.get(iri) ?? [],
        queryType:   (r.queryType?.value ?? 'SELECT').toUpperCase(),
        vocabulary:  'hquery',
        source:      'rdf'
      }
    }).filter(q => q.id && q.sparql)
  } catch (err) {
    console.warn(`[named-queries] hquery: load from <${graphIri}> failed: ${err.message}`)
    return []
  }
}

/** Local name of an IRI -- the id for an hquery: query, which has no explicit one. */
function localName(iri) {
  const cut = Math.max(iri.lastIndexOf('/'), iri.lastIndexOf('#'))
  return cut >= 0 ? iri.slice(cut + 1) : iri
}

// --- Parameter binding --------------------------------------------------------

/**
 * Apply caller-supplied parameters to a loaded named query.
 *
 * Dispatches on vocabulary -- see the module docstring for why that matters.
 *
 * @param {object} namedQuery  As returned by loadNamedQueries()
 * @param {Record<string, unknown>} params
 * @param {function} substituteParams  lib/params.js's substituteParams, injected
 * @returns {{ sparql: string, bound: string[], missing: string[], strategy: string }}
 *   missing -- for hb:, placeholders left unresolved; for hquery:, declared
 *   REQUIRED parameters the caller did not supply. Both are caller errors.
 */
export function applyQueryParams(namedQuery, params, substituteParams) {
  const supplied = (params && typeof params === 'object') ? params : {}

  if (namedQuery.vocabulary !== 'hquery') {
    const r = substituteParams(namedQuery.sparql, supplied)
    return { sparql: r.sparql, bound: r.substituted, missing: r.missing, strategy: 'placeholder' }
  }

  const declared = new Map((namedQuery.params ?? []).map(p => [p.name, p]))

  const missing = (namedQuery.params ?? [])
    .filter(p => p.required && !(p.name in supplied))
    .map(p => p.name)

  const rows  = []
  const bound = []
  for (const [name, value] of Object.entries(supplied)) {
    if (value === null || value === undefined) continue
    // Only bind declared parameters. An undeclared VALUES variable would not
    // error, it would just quietly constrain nothing -- better to reject the
    // typo than to run a query the caller did not mean.
    if (!declared.has(name)) continue
    rows.push(`?${name} { ${toSparqlTerm(value, declared.get(name).datatype)} }`)
    bound.push(name)
  }

  // Appended, not injected -- ValuesClause is the final production of a SPARQL
  // query, so this is safe after any ORDER BY / LIMIT the query body carries.
  const sparql = rows.length === 0
    ? namedQuery.sparql
    : `${namedQuery.sparql.trimEnd()}\nVALUES ${rows.join('\nVALUES ')}`

  return { sparql, bound, missing, strategy: 'values' }
}

/**
 * Serialise a JS value as a SPARQL term, using the parameter's declared datatype
 * where there is one. Declared datatype beats inference: "2026-09-05" is a string
 * until the registry says it is an xsd:date, and guessing from shape would make
 * a query's behaviour depend on the value a caller happened to pass.
 */
export function toSparqlTerm(value, datatype) {
  const dt = (datatype ?? '').trim()
  const s  = String(value)

  if (dt === 'IRI' || dt === 'iri' || /^https?:\/\//.test(dt)) {
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s))
      throw new Error(`Parameter declared as IRI but '${s}' is not one`)
    return `<${s.replace(/[<>"{}|\\^`]/g, '')}>`
  }

  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'

  const escaped = s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
                   .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')

  if (!dt) return `"${escaped}"`

  const expanded = dt.startsWith('xsd:')
    ? `http://www.w3.org/2001/XMLSchema#${dt.slice(4)}`
    : dt
  return `"${escaped}"^^<${expanded}>`
}
