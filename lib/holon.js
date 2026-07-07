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
 * the reconciliation. When holons migrate to the w3id.org/holon
 * three-graph model, this route should be extended (or replaced) to
 * detect which model a given holon IRI follows and delegate accordingly.
 * Flagged as a TODO in fetchHolonProjection() below rather than resolved
 * here -- that's a design decision for the holon-lifecycle skill, not
 * something to settle unilaterally inside a bug-fix pass.
 */

import { runQuery } from './sparql.js'

export const HOLON_ONTOLOGIST_NS = 'https://ontologist.io/ns/holon#'

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

// --- Data fetch ------------------------------------------------------------------

/**
 * Fetch a holon's own properties, its parent (if any), and its direct
 * children (if any), via holon:isPartOf in both directions. Graph-agnostic
 * by design -- holons in the currently-populated model aren't confined to
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
 * @returns {Promise<{ exists: boolean, self: object[], parent: object|null, children: object[] }>}
 */
export async function fetchHolonProjection(sparqlEndpoint, holonIri) {
  const HOLON = HOLON_ONTOLOGIST_NS

  // 1. Own triples, wherever they live
  const selfQuery = `
    SELECT ?p ?o WHERE {
      GRAPH ?g { <${holonIri}> ?p ?o }
    } ORDER BY ?p`
  const { bindings: selfBindings } = await runQuery(sparqlEndpoint, selfQuery)

  if (selfBindings.length === 0) {
    return { exists: false, self: [], parent: null, children: [] }
  }

  // 2. Parent, if any
  const parentQuery = `
    PREFIX holon: <${HOLON}>
    PREFIX rdfs:  <http://www.w3.org/2000/01/rdf-schema#>
    SELECT ?parent ?parentLabel WHERE {
      GRAPH ?g {
        <${holonIri}> holon:isPartOf ?parent .
        OPTIONAL { ?parent rdfs:label ?parentLabel }
      }
    } LIMIT 1`
  const { bindings: parentBindings } = await runQuery(sparqlEndpoint, parentQuery)
  const parent = parentBindings[0]
    ? { iri: parentBindings[0].parent.value, label: parentBindings[0].parentLabel?.value ?? null }
    : null

  // 3. Direct children -- inverse of holon:isPartOf, with label + domain types.
  //    Deliberately one hop only: per the SCE map metaphor, parent/child is
  //    a scale relationship, so a projection of this holon shows what's
  //    immediately inside it, not the full recursive subtree.
  const childrenQuery = `
    PREFIX holon: <${HOLON}>
    PREFIX rdfs:  <http://www.w3.org/2000/01/rdf-schema#>
    SELECT ?child ?label ?type WHERE {
      GRAPH ?g {
        ?child holon:isPartOf <${holonIri}> .
        OPTIONAL { ?child rdfs:label ?label }
        OPTIONAL { ?child a ?type . FILTER(?type != holon:Holon) }
      }
    } ORDER BY ?label ?child`
  const { bindings: childBindings } = await runQuery(sparqlEndpoint, childrenQuery)

  const childMap = new Map()
  for (const b of childBindings) {
    const iri = b.child.value
    if (!childMap.has(iri)) {
      childMap.set(iri, { iri, label: b.label?.value ?? null, types: [] })
    }
    if (b.type?.value) childMap.get(iri).types.push(b.type.value)
  }

  return {
    exists: true,
    self: selfBindings,
    parent,
    children: [...childMap.values()]
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
  const { self, parent, children } = projection
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
      ? `**Contained by:** [${parent.label ?? localName(parent.iri)}](${parent.iri})`
      : `**Contained by:** _(none — this is a root holon)_`,
    ''
  )
  headingLines.push(
    children.length > 0
      ? `**Direct children (${children.length}):** ${children.map(c => c.label ?? localName(c.iri)).join(', ')}`
      : `**Direct children:** _(none)_`,
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
        (c.types.length ? ` _(${c.types.map(localName).join(', ')})_` : '')
      ).join('\n')
    : '_(no children -- this holon has no scene contents at this scale)_'
  const sceneBlock = [
    '## Scene',
    '',
    '_Direct children only. Per the SCE map metaphor, parent/child is a',
    'scale relationship -- an agent situated here perceives one hop of',
    'decomposition, not the full subtree. To go deeper, request the child',
    'holon directly._',
    '',
    '<!-- databook:id: holon-scene -->',
    '```markdown',
    sceneLines,
    '```',
    ''
  ].join('\n')

  // -- Block 3: metadata (YAML) -------------------------------------------------
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
    '```',
    ''
  ].join('\n')

  return [frontmatter, heading, propertiesBlock, sceneBlock, metaBlock].join('\n')
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
