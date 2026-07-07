/**
 * holon.js -- GET /holon/:iri  ("get_holon": retrieve a holon as a DataBook)
 *
 * Implements the get_holon capability that holonbridge-mcp's hbGetHolon()
 * has always called (GET /holon/<encoded-iri>?projection=<mode>, expecting
 * text/markdown back) but which server.js never actually implemented --
 * confirmed absent from the route table and from the server's own 404
 * fallback route list. Every call from the MCP tool 404'd.
 *
 * NAMESPACE NOTE -- read before extending this file
 * ---------------------------------------------------
 * This implementation targets the namespace and data shape actually
 * populated in Fuseki today: https://ontologist.io/ns/holon# (prefix
 * holon:), flat containment via holon:isPartOf, holon and domain-payload
 * triples co-resident in a single named graph (e.g. urn:data:holons,
 * urn:chloe:..., etc). Verified against ds, chloe, ggsc, and data.
 *
 * lib/lifecycle.js implements a *different*, newer holon model under
 * https://w3id.org/holon/ -- holon:parentHolon (not isPartOf), a
 * three-graph-per-holon layout derived from the holon's own IRI
 * (graphsFor() -> {iri}/schema, {iri}/scene, {iri}/events), RoleBinding
 * ACL, portal-potential lazy realisation, and tombstone deletion. Its own
 * header comment calls this "intentionally ahead of ... ontologist.io ...,
 * pending reconciliation" -- the two models are known to coexist and are
 * not yet unified. No holon currently in Fuseki uses the w3id.org/holon
 * namespace or the schema/scene/events graph triad, so lifecycle.js's
 * listHolonContents() -- verb #8, the closest existing analog to
 * get_holon -- returns nothing useful against real data right now.
 *
 * This route is a pragmatic implementation against the model that's
 * actually populated, not a decision that the older namespace has "won"
 * the reconciliation.
 *
 * SCHEMA-DRIVEN ROLE DISCOVERY -- the traversal is predicate-agnostic
 * ---------------------------------------------------------------------
 * This module hardcodes exactly two predicate names: holon:isPartOf
 * (the canonical containment role) and holon:isConnectedTo (the
 * canonical connection/adjacency role, minted alongside isPartOf as its
 * sibling). It knows no domain-specific predicate names at all -- not
 * geo:administrativePartOf, not geo:borders, not geo:crosses, not
 * whatever the next domain schema invents.
 *
 * A schema participates in the holon infrastructure purely by declaring
 * its own property as rdfs:subPropertyOf one of the two role predicates,
 * e.g.:
 *   geo:administrativePartOf rdfs:subPropertyOf holon:isPartOf .
 *   geo:borders              rdfs:subPropertyOf holon:isConnectedTo .
 *
 * discoverRoleProperties() below finds every property playing a given
 * role via the rdfs:subPropertyOf* property path -- a pure graph
 * traversal over asserted triples, evaluated directly against the data,
 * requiring no RDFS/OWL reasoner and no entailment regime enabled on the
 * Fuseki dataset. This is what makes the design actually work on a plain
 * SPARQL store rather than being semantically-true-but-functionally-
 * inert documentation: earlier in this dataset's history,
 * geo:administrativePartOf was declared as an rdfs:subPropertyOf
 * holon:isPartOf but this module still queried the literal predicate
 * holon:isPartOf only, so the declaration had no effect on what an
 * agent's projection actually showed. This rewrite is the fix.
 *
 * The holon:isPartOf/holon:isConnectedTo distinction itself mirrors the
 * CelestialBodyKind/CompositionFacet meta-class pattern used elsewhere
 * in this dataset's ontology (urn:data:ontology) for disambiguating
 * primary taxonomy from cross-cutting classification on classes -- same
 * idea, one level down, applied to properties instead of classes.
 */

import { runQuery } from './sparql.js'

export const HOLON_ONTOLOGIST_NS = 'https://ontologist.io/ns/holon#'
export const CONTAINMENT_ROLE = `${HOLON_ONTOLOGIST_NS}isPartOf`
export const CONNECTION_ROLE  = `${HOLON_ONTOLOGIST_NS}isConnectedTo`

const PROJECTION_MODES = ['immersive', 'cinematic', 'active_inference', 'exploded_view']

// --- Helpers -------------------------------------------------------------------

function mdEscape(s) {
  return String(s).replace(/"/g, '\\"')
}

function localName(iri) {
  if (!iri) return iri
  const parts = String(iri).split(/[/#]/)
  return parts[parts.length - 1] || iri
}

/** Build a SPARQL `IN (<a>, <b>, ...)` value list from an IRI array. */
function iriInList(iris) {
  return iris.map(i => `<${i}>`).join(', ')
}

// --- Role discovery ------------------------------------------------------------

/**
 * Discover every property that plays a given role in the holon
 * infrastructure -- every property P such that `P rdfs:subPropertyOf* <roleIri>`
 * holds somewhere in the dataset (graph-agnostic, matching the rest of
 * this module's graph-agnostic design). Always includes the role
 * predicate itself (the `*` path is reflexive at length zero; the Set
 * seed below is a defensive belt-and-braces in case a given SPARQL
 * engine's zero-length-path handling ever differs).
 *
 * This is the entire mechanism that keeps this module schema-agnostic:
 * it is the only place a "which predicates count as containment/
 * connection" decision is made, and that decision is made by querying
 * the data's own declarations, never by a hardcoded domain predicate
 * list in this file.
 *
 * @param {string} sparqlEndpoint
 * @param {string} roleIri  e.g. CONTAINMENT_ROLE or CONNECTION_ROLE
 * @returns {Promise<string[]>}  property IRIs playing this role
 */
export async function discoverRoleProperties(sparqlEndpoint, roleIri) {
  const query = `
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    SELECT DISTINCT ?prop WHERE {
      GRAPH ?g { ?prop rdfs:subPropertyOf* <${roleIri}> }
    }`
  const { bindings } = await runQuery(sparqlEndpoint, query)
  const props = new Set([roleIri])
  for (const b of bindings) {
    if (b.prop?.value) props.add(b.prop.value)
  }
  return [...props]
}

// --- Data fetch ------------------------------------------------------------------

/**
 * Fetch a holon's own properties, its parent (if any), its direct
 * children (if any), and its connections (if any) -- via whichever
 * properties are currently discovered to play the containment or
 * connection role (see discoverRoleProperties()). Graph-agnostic by
 * design -- holons in the currently-populated model aren't confined to
 * a single dedicated graph, so this queries across GRAPH ?g rather than
 * assuming one.
 *
 * TODO (namespace reconciliation): once/if holons migrate to the
 * w3id.org/holon three-graph model (see file header), this is the place
 * to branch -- e.g. check for a holon:schemaGraph/holon:sceneGraph
 * declaration on the target IRI first, and delegate to something built on
 * lib/lifecycle.js's listHolonContents() when found, falling back to this
 * ontologist.io-namespace path otherwise.
 *
 * @param {string} sparqlEndpoint
 * @param {string} holonIri
 * @returns {Promise<{ exists: boolean, self: object[], parent: object|null, children: object[], connections: object[] }>}
 */
export async function fetchHolonProjection(sparqlEndpoint, holonIri) {
  // 1. Own triples, wherever they live
  const selfQuery = `
    SELECT ?p ?o WHERE {
      GRAPH ?g { <${holonIri}> ?p ?o }
    } ORDER BY ?p`
  const { bindings: selfBindings } = await runQuery(sparqlEndpoint, selfQuery)

  if (selfBindings.length === 0) {
    return { exists: false, self: [], parent: null, children: [], connections: [] }
  }

  // Discover role membership fresh on every call -- cheap relative to the
  // rest of the traversal, and guarantees a newly-declared subPropertyOf
  // takes effect immediately with no cache to invalidate.
  const [containmentProps, connectionProps] = await Promise.all([
    discoverRoleProperties(sparqlEndpoint, CONTAINMENT_ROLE),
    discoverRoleProperties(sparqlEndpoint, CONNECTION_ROLE)
  ])
  const containmentList = iriInList(containmentProps)
  const connectionList  = iriInList(connectionProps)

  // 2. Parent, if any -- first match against any containment-role property
  const parentQuery = `
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    SELECT ?parent ?parentLabel ?viaProp WHERE {
      GRAPH ?g {
        <${holonIri}> ?viaProp ?parent .
        FILTER(?viaProp IN (${containmentList}))
        OPTIONAL { ?parent rdfs:label ?parentLabel }
      }
    } LIMIT 1`
  const { bindings: parentBindings } = await runQuery(sparqlEndpoint, parentQuery)
  const parent = parentBindings[0]
    ? {
        iri: parentBindings[0].parent.value,
        label: parentBindings[0].parentLabel?.value ?? null,
        via: parentBindings[0].viaProp?.value ?? null
      }
    : null

  // 3. Direct children -- inverse of any containment-role property, with
  //    label + domain types. Deliberately one hop only: per the SCE map
  //    metaphor, parent/child is a scale relationship, so a projection of
  //    this holon shows what's immediately inside it, not the full
  //    recursive subtree.
  const childrenQuery = `
    PREFIX rdfs:  <http://www.w3.org/2000/01/rdf-schema#>
    PREFIX holon: <${HOLON_ONTOLOGIST_NS}>
    SELECT ?child ?label ?type ?viaProp WHERE {
      GRAPH ?g {
        ?child ?viaProp <${holonIri}> .
        FILTER(?viaProp IN (${containmentList}))
        OPTIONAL { ?child rdfs:label ?label }
        OPTIONAL { ?child a ?type . FILTER(?type != holon:Holon) }
      }
    } ORDER BY ?label ?child`
  const { bindings: childBindings } = await runQuery(sparqlEndpoint, childrenQuery)

  const childMap = new Map()
  for (const b of childBindings) {
    const iri = b.child.value
    if (!childMap.has(iri)) {
      childMap.set(iri, { iri, label: b.label?.value ?? null, types: [], via: b.viaProp?.value ?? null })
    }
    if (b.type?.value) childMap.get(iri).types.push(b.type.value)
  }

  // 4. Connections -- any connection-role property, in EITHER direction.
  //    Unlike containment (a child always points at its parent, one
  //    direction by convention), connection-role properties may be
  //    asserted in either direction depending on which side the schema
  //    designer chose as subject -- e.g. a sea `geo:borders` the
  //    continents around it, but nothing requires the reverse triple to
  //    also be asserted, symmetric property or not. Querying only the
  //    outbound direction would silently miss real connections.
  const connectionsQuery = `
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    SELECT ?other ?label ?viaProp ?direction WHERE {
      GRAPH ?g {
        {
          <${holonIri}> ?viaProp ?other .
          FILTER(?viaProp IN (${connectionList}))
          BIND("outbound" AS ?direction)
        } UNION {
          ?other ?viaProp <${holonIri}> .
          FILTER(?viaProp IN (${connectionList}))
          BIND("inbound" AS ?direction)
        }
        OPTIONAL { ?other rdfs:label ?label }
      }
    } ORDER BY ?label`
  const { bindings: connectionBindings } = await runQuery(sparqlEndpoint, connectionsQuery)

  const connectionMap = new Map()
  for (const b of connectionBindings) {
    const iri = b.other?.value
    const via = b.viaProp?.value
    if (!iri || !via) continue
    const key = `${iri}|${via}` // same pair could show both directions if both triples exist; dedupe per (other, property)
    if (!connectionMap.has(key)) {
      connectionMap.set(key, {
        iri,
        label: b.label?.value ?? null,
        property: via,
        direction: b.direction?.value ?? 'outbound'
      })
    }
  }

  return {
    exists: true,
    self: selfBindings,
    parent,
    children: [...childMap.values()],
    connections: [...connectionMap.values()]
  }
}

// --- DataBook projection builder --------------------------------------------------

/**
 * Build a projection DataBook for a holon, following the canonical
 * projection frontmatter documented in the sce skill: id, title, type,
 * version, created, transmission{type,sequence,timestamp}, holon{iri,mode}.
 *
 * @param {string} holonIri
 * @param {object} projection  result of fetchHolonProjection()
 * @param {'immersive'|'cinematic'|'active_inference'|'exploded_view'} mode
 * @returns {string}  Markdown DataBook
 */
export function buildHolonDataBook(holonIri, projection, mode) {
  const { self, parent, children, connections } = projection
  const ts     = new Date().toISOString()
  const tsDate = ts.slice(0, 10)

  const labelRow       = self.find(b => localName(b.p.value) === 'label')
  const descriptionRow = self.find(b => localName(b.p.value) === 'description')
  const commentRow     = self.find(b => localName(b.p.value) === 'comment')
  const label = labelRow?.o.value ?? localName(holonIri)
  // holon:description is the canonical instance-level narrative field --
  // what an agent's projection actually narrates. rdfs:comment is reserved
  // for schema/class-level documentation (see sol:Moon, sol:distanceFromPrimary,
  // etc. in urn:data:ontology) and is accepted here only as a fallback for
  // holons that predate the holon:description convention.
  const description = descriptionRow?.o.value ?? commentRow?.o.value ?? null

  // -- Frontmatter --------------------------------------------------------------
  const frontmatter = [
    '---',
    `id: ${holonIri}#projection-1`,
    `title: "Projection — ${mdEscape(label)}"`,
    `type: databook`,
    `version: 1.0.0`,
    `created: ${tsDate}`,
    `transmission:`,
    `  type: full`,
    `  sequence: 1`,
    `  timestamp: ${ts}`,
    `holon:`,
    `  iri: ${holonIri}`,
    `  mode: ${mode}`,
    '---',
    ''
  ].join('\n')

  // -- Heading + scene summary ---------------------------------------------------
  const headingLines = [
    `# ${label}`,
    ''
  ]
  if (description) headingLines.push(description, '')
  headingLines.push(
    parent
      ? `**Contained by:** [${parent.label ?? localName(parent.iri)}](${parent.iri}) _(via ${localName(parent.via)})_`
      : `**Contained by:** _(none — this is a root holon)_`,
    ''
  )
  headingLines.push(
    children.length > 0
      ? `**Direct children (${children.length}):** ${children.map(c => c.label ?? localName(c.iri)).join(', ')}`
      : `**Direct children:** _(none)_`,
    ''
  )
  headingLines.push(
    connections.length > 0
      ? `**Connections (${connections.length}):** ${connections.map(c => c.label ?? localName(c.iri)).join(', ')}`
      : `**Connections:** _(none)_`,
    '',
    '---',
    ''
  )
  const heading = headingLines.join('\n')

  // -- Block 1: own properties ----------------------------------------------------
  const propLines = self.map(b => {
    const pred = `<${b.p.value}>`
    const obj  = b.o.type === 'uri' ? `<${b.o.value}>` : JSON.stringify(b.o.value)
    return `<${holonIri}> ${pred} ${obj} .`
  })
  const propertiesBlock = [
    '## Properties',
    '',
    '<!-- databook:id: holon-properties -->',
    '```turtle',
    propLines.join('\n') || '# (no properties)',
    '```',
    ''
  ].join('\n')

  // -- Block 2: scene -- direct children as a navigable list ------------------------
  const sceneLines = children.length
    ? children.map(c =>
        `- [${c.label ?? localName(c.iri)}](${c.iri})` +
        (c.types.length ? ` _(${c.types.map(localName).join(', ')})_` : '') +
        ` — via \`${localName(c.via)}\``
      ).join('\n')
    : '_(no children -- this holon has no scene contents at this scale)_'
  const sceneBlock = [
    '## Scene',
    '',
    '_Direct children only, discovered via whichever properties currently',
    'play the containment role (rdfs:subPropertyOf* holon:isPartOf). Per',
    'the SCE map metaphor, parent/child is a scale relationship -- an',
    'agent situated here perceives one hop of decomposition, not the full',
    'subtree. To go deeper, request the child holon directly._',
    '',
    '<!-- databook:id: holon-scene -->',
    '```markdown',
    sceneLines,
    '```',
    ''
  ].join('\n')

  // -- Block 3: connections -- non-containment peers, either direction ----------------
  const connectionLines = connections.length
    ? connections.map(c => {
        const arrow = c.direction === 'outbound' ? '→' : '←'
        return `- ${arrow} \`${localName(c.property)}\` [${c.label ?? localName(c.iri)}](${c.iri})`
      }).join('\n')
    : '_(no connections)_'
  const connectionsBlock = [
    '## Connections',
    '',
    '_Non-containment relations, discovered via whichever properties',
    'currently play the connection role (rdfs:subPropertyOf*',
    'holon:isConnectedTo), checked in both directions since a connection',
    'may be asserted from either side. These are peers, not scene',
    'contents -- unlike Scene, a holon may have any number of',
    'connections, to holons anywhere in the holarchy, not just its own',
    'children._',
    '',
    '<!-- databook:id: holon-connections -->',
    '```markdown',
    connectionLines,
    '```',
    ''
  ].join('\n')

  // -- Block 4: metadata (YAML) -------------------------------------------------
  const metaBlock = [
    '## Metadata',
    '',
    '<!-- databook:id: holon-metadata -->',
    '```yaml',
    `iri: ${holonIri}`,
    `label: "${mdEscape(label)}"`,
    `mode: ${mode}`,
    `timestamp: ${ts}`,
    `parent: ${parent ? parent.iri : 'null'}`,
    `childCount: ${children.length}`,
    `connectionCount: ${connections.length}`,
    '```',
    ''
  ].join('\n')

  return [frontmatter, heading, propertiesBlock, sceneBlock, connectionsBlock, metaBlock].join('\n')
}

// --- Route handler --------------------------------------------------------------

/**
 * GET /holon/:iri route handler.
 *
 * Called from server.js as:
 *   app.get('/holon/:iri', (req, res) => getHolonHandler(req, res, { JENA_SPARQL }))
 *
 * The MCP wrapper's hbGetHolon() builds the request with
 * encodeURIComponent(holonIri), so the full IRI (including scheme and
 * slashes) arrives already percent-encoded as a single path segment --
 * Express decodes route params automatically, so req.params.iri is the
 * plain IRI string with no extra handling needed here.
 */
export async function getHolonHandler(req, res, { JENA_SPARQL }) {
  const holonIri = req.params.iri
  const requestedMode = req.query.projection
  const mode = PROJECTION_MODES.includes(requestedMode) ? requestedMode : 'immersive'

  if (!holonIri) {
    return res.status(400).json({ error: 'Holon IRI is required in the path.' })
  }

  console.log(`[Bridge] GET /holon/${holonIri} (projection=${mode})`)

  try {
    const projection = await fetchHolonProjection(JENA_SPARQL, holonIri)
    if (!projection.exists) {
      return res.status(404).json({
        error: `Holon <${holonIri}> not found in dataset.`,
        note:  'Searched across all named graphs for triples with this IRI as subject.'
      })
    }
    const doc = buildHolonDataBook(holonIri, projection, mode)
    return res.type('text/markdown')
      .set('Content-Disposition', `inline; filename="${localName(holonIri)}.databook.md"`)
      .send(doc)
  } catch (err) {
    console.error(`[Bridge] GET /holon/${holonIri} failed:`, err.message)
    return res.status(500).json({ error: 'Internal bridge error', message: err.message })
  }
}
