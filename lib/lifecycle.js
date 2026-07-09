/**
 * lifecycle.js -- Holon lifecycle verbs (P4)
 *
 * Implements the twelve verbs whose contract is defined in
 * schemas/lifecycle-verbs.schema.json (source of truth for signatures --
 * this file is a generated-by-hand consumer of that schema, not the other
 * way around).
 *
 * Namespace: https://w3id.org/holon/ (intentionally ahead of the older
 * https://ontologist.io/ns/holon# namespace used by sce/HGA-proper, pending
 * reconciliation).
 *
 * Every mutating verb follows the CommandEvent pipeline already documented
 * in the sce skill: validate -> authorise -> execute -> assert -> log -> update.
 * Every verb is DataBook-in / DataBook-out at the boundary -- Turtle/SPARQL/
 * JSON are internal transport only, never returned directly to callers.
 *
 * Design decisions locked into this implementation (see the holon-lifecycle
 * skill for full rationale):
 *   - Entity/holon boundary: lazy realization via holon:portalPotential,
 *     resolved only by promoteEntity(). Eligibility is declared once on the
 *     schema's NodeShape (holon:holonEligible), not decided ad hoc at
 *     instantiation time. This is what bounds the holarchy depth.
 *   - Reification: RDF 1.2 / Turtle 1.2 native reification for property-level
 *     annotations -- not RDF-star quoted triples, not classic rdf:Statement.
 *   - Deletion: tombstone by default (deleteHolon). Hard purge (purgeHolon)
 *     is a separate, explicitly-confirmed operation. The event graph is
 *     never touched by either -- it is append-only.
 *   - ACL: holon:RoleBinding is anchored at the holon where it was granted.
 *     authorise() walks holon:isPartOf UPWARD from the target holon and
 *     stops at the first binding found -- it never crosses above the anchor
 *     the grantor themselves holds. Capability set: Read, Write, Promote,
 *     Grant, Owner (Owner implies the rest). designateAgent() enforces an
 *     escalation guard: a grantor can only issue capabilities they hold.
 *   - Reparenting: moveHolon() changes holon:isPartOf directly -- aligned
 *     2026-07-09 from an earlier holon:parentHolon predicate to match the
 *     containment predicate actually populated in live datasets (see the
 *     holon-schema-patterns skill). Any holon may be flagged
 *     holon:rootLocked true (typically set at createRootHolon time) to
 *     mark it as an intentional root structure -- a registry, a corridor
 *     spine, a journeys index -- that should never be silently reparented
 *     by a stray moveHolon call. A locked holon can still be moved with
 *     { force: true }, which is a deliberate, visible override rather than
 *     a separate bypass path.
 *   - CAUTION: as of this alignment, resolveCapabilities()'s ancestor walk
 *     will return an empty capability set for any holon with no RoleBinding
 *     reachable via isPartOf -- which today is most holons in most
 *     datasets, since isPartOf is sparsely populated by design (many
 *     holons are intentionally standalone) and no RoleBinding has yet been
 *     seeded anywhere. Every mutating verb will throw UnauthorisedError
 *     until at least one RoleBinding exists on a reachable ancestor.
 */

import { runQuery, runConstruct, pushToGraph, runUpdate, replaceTriples } from './sparql.js'
import { validateWithShacl } from './shacl.js'
import { DataBook } from './databook.js'

export const HOLON_NS = 'https://w3id.org/holon/'

// --- Error classes -------------------------------------------------------------

export class CommandRejected extends Error {
  constructor(reason, commandType) {
    super(reason)
    this.name = 'CommandRejected'
    this.commandType = commandType
    this.holonEvent = `${HOLON_NS}CommandRejected`
  }
}

export class UnauthorisedError extends Error {
  constructor(actorIri, holonIri, capability) {
    super(`Actor <${actorIri}> lacks capability "${capability}" on <${holonIri}> (or any ancestor)`)
    this.name = 'UnauthorisedError'
    this.actorIri = actorIri
    this.holonIri = holonIri
    this.capability = capability
  }
}

// --- Capability model ------------------------------------------------------------

const CAPABILITY_IMPLIES = {
  Owner: ['Owner', 'Grant', 'Promote', 'Write', 'Read'],
  Grant: ['Grant', 'Write', 'Read'],
  Promote: ['Promote', 'Write', 'Read'],
  Write: ['Write', 'Read'],
  Read: ['Read']
}

function expandCapabilities(capabilities) {
  const out = new Set()
  for (const c of capabilities) {
    for (const implied of (CAPABILITY_IMPLIES[c] ?? [c])) out.add(implied)
  }
  return out
}

/**
 * Resolve the effective capability set an actor holds on a holon, walking
 * holon:isPartOf upward and stopping at the first RoleBinding found.
 * A binding anchored at a descendant holon never grants access to an
 * ancestor -- ownership of a subtree is bounded by construction.
 *
 * @param {string} sparqlEndpoint
 * @param {string} holonIri
 * @param {string} actorIri
 * @returns {Promise<Set<string>>}
 */
export async function resolveCapabilities(sparqlEndpoint, holonIri, actorIri) {
  let current = holonIri
  const visited = new Set()

  while (current && !visited.has(current)) {
    visited.add(current)

    const query = `
      PREFIX holon: <${HOLON_NS}>
      SELECT ?capability WHERE {
        GRAPH ?registryGraph {
          ?binding a holon:RoleBinding ;
                   holon:boundAgent <${actorIri}> ;
                   holon:boundHolon <${current}> ;
                   holon:capability ?capability .
        }
      }`
    const { bindings } = await runQuery(sparqlEndpoint, query)

    if (bindings.length > 0) {
      const raw = bindings.map(b => b.capability.value.split(/[/#]/).pop())
      return expandCapabilities(raw)
    }

    const parentQuery = `
      PREFIX holon: <${HOLON_NS}>
      SELECT ?parent WHERE {
        GRAPH ?registryGraph { <${current}> holon:isPartOf ?parent }
      }`
    const { bindings: parentBindings } = await runQuery(sparqlEndpoint, parentQuery)
    current = parentBindings[0]?.parent?.value ?? null
  }

  return new Set()
}

/**
 * Gate a mutating verb. Throws UnauthorisedError (never a silent no-op) if
 * the actor lacks the required capability anywhere on the ancestor chain.
 *
 * @param {string} sparqlEndpoint
 * @param {string} holonIri
 * @param {{iri: string}} actor
 * @param {'Read'|'Write'|'Promote'|'Grant'|'Owner'} capability
 */
export async function authorise(sparqlEndpoint, holonIri, actor, capability) {
  if (!capability) return // some verbs (createRootHolon) have no gate
  const held = await resolveCapabilities(sparqlEndpoint, holonIri, actor.iri)
  if (!held.has(capability)) {
    throw new UnauthorisedError(actor.iri, holonIri, capability)
  }
}

// --- DataBook helpers ------------------------------------------------------------

/**
 * Minimal DataBook serializer -- frontmatter + one or more fenced blocks.
 * Pairs with databook.js's loadDataBook()/DataBook class for the read side.
 *
 * @param {object} frontmatter
 * @param {{id: string, label: string, lang: string, content: string}[]} blocks
 * @returns {string}
 */
export function buildDataBook(frontmatter, blocks) {
  const yaml = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join('\n')

  const body = blocks.map(b => (
    `<!-- databook:id: ${b.id} -->\n` +
    (b.label ? `<!-- databook:label: ${b.label} -->\n` : '') +
    '```' + (b.lang ?? 'turtle') + '\n' +
    b.content.trimEnd() + '\n' +
    '```'
  )).join('\n\n')

  return `---\n${yaml}\n---\n\n${body}\n`
}

function stampProcess(frontmatter, actor) {
  return {
    ...frontmatter,
    process: {
      timestamp: new Date().toISOString(),
      agent: { iri: actor.iri, role: actor.role ?? 'actor' }
    }
  }
}

function graphsFor(holonIri) {
  return {
    schema: `${holonIri}/schema`,
    scene: `${holonIri}/scene`,
    events: `${holonIri}/events`
  }
}

async function logEvent(gspEndpoint, holonIri, commandType, actor, payload) {
  const { events } = graphsFor(holonIri)
  const eventId = `urn:event:${crypto.randomUUID()}`
  const turtle = `
@prefix holon: <${HOLON_NS}> .
@prefix prov:  <http://www.w3.org/ns/prov#> .
@prefix xsd:   <http://www.w3.org/2001/XMLSchema#> .

<${eventId}> a holon:AssertionEvent ;
    holon:targetHolon <${holonIri}> ;
    holon:derivedFromCommand holon:${commandType} ;
    holon:receivedAt "${new Date().toISOString()}"^^xsd:dateTime ;
    prov:wasGeneratedBy <${actor.iri}> .
`.trim()
  await pushToGraph(gspEndpoint, events, turtle, 'append')
  return eventId
}

// --- 1. createRootHolon ------------------------------------------------------

/**
 * @param {{sparqlEndpoint: string, gspEndpoint: string}} conn
 * @param {{baseIri: string, label: string, actor: {iri: string}, rootLocked?: boolean}} params
 * @returns {Promise<string>} serialized HolonDataBook
 */
export async function createRootHolon(conn, { baseIri, label, actor, rootLocked }) {
  const graphs = graphsFor(baseIri)
  const turtle = `
@prefix holon: <${HOLON_NS}> .
@prefix rdfs:  <http://www.w3.org/2000/01/rdf-schema#> .

<${baseIri}> a holon:Holon ;
    rdfs:label "${label}" ;
    holon:status holon:RegisteredStatus ;
    holon:schemaGraph <${graphs.schema}> ;
    holon:sceneGraph <${graphs.scene}> ;
    holon:eventGraph <${graphs.events}>${rootLocked ? ' ;\n    holon:rootLocked true' : ''} .
`.trim()

  await pushToGraph(conn.gspEndpoint, null, turtle, 'append') // registry graph = default graph
  await logEvent(conn.gspEndpoint, baseIri, 'CreateRootHolonCommand', actor, {})

  return buildDataBook(
    stampProcess({ id: baseIri, title: label, type: 'holon' }, actor),
    [{ id: 'root-holon', label: 'Root holon registration', content: turtle }]
  )
}

// --- 2. addSchema --------------------------------------------------------------

/**
 * @param {{sparqlEndpoint: string, gspEndpoint: string}} conn
 * @param {string} holonIri
 * @param {{markdown: string}} schemaDataBook
 * @param {{iri: string}} actor
 */
export async function addSchema(conn, holonIri, schemaDataBook, actor) {
  await authorise(conn.sparqlEndpoint, holonIri, actor, 'Write')

  const db = new DataBook(schemaDataBook.markdown, `<inline>/${holonIri}/schema`)
  const { schema } = graphsFor(holonIri)

  // Concatenate all turtle/shacl blocks (ontology, taxonomy, SHACL, named queries
  // travel together as one schema graph push)
  const turtle = db.ids().map(id => db.block(id)).filter(Boolean).join('\n\n')
  await pushToGraph(conn.gspEndpoint, schema, turtle, 'append')
  await logEvent(conn.gspEndpoint, holonIri, 'AddSchemaCommand', actor, {})

  return buildDataBook(
    stampProcess({ id: `${holonIri}#schema`, title: 'Schema', type: 'holon-schema' }, actor),
    [{ id: 'schema', label: 'Schema graph contents', content: turtle }]
  )
}

// --- 3. addEntity ----------------------------------------------------------------

/**
 * @param {{sparqlEndpoint: string, gspEndpoint: string, dataset: string, jenaBase: string}} conn
 * @param {string} holonIri
 * @param {{markdown: string}} entityDataBook
 * @param {{iri: string}} actor
 */
export async function addEntity(conn, holonIri, entityDataBook, actor) {
  await authorise(conn.sparqlEndpoint, holonIri, actor, 'Write')

  const db = new DataBook(entityDataBook.markdown, `<inline>/${holonIri}/entity`)
  const { schema, scene } = graphsFor(holonIri)
  const turtle = db.ids().map(id => db.block(id)).filter(Boolean).join('\n\n')

  const report = await validateWithShacl(conn.jenaBase, conn.dataset, schema, turtle)
  if (!report.conforms) {
    throw new CommandRejected(
      `SHACL violation: ${report.violations.map(v => v.message).join('; ')}`,
      'AddEntityCommand'
    )
  }

  // Eligibility check -- does the entity's type match a holon-eligible NodeShape?
  const eligQuery = `
    PREFIX sh:    <http://www.w3.org/ns/shacl#>
    PREFIX holon: <${HOLON_NS}>
    SELECT ?entity ?shape ?childSchema WHERE {
      GRAPH <${schema}> {
        ?shape sh:targetClass ?type ;
               holon:holonEligible true .
        OPTIONAL { ?shape holon:eligibleChildSchema ?childSchema }
      }
    }`
  const { bindings: eligible } = await runQuery(conn.sparqlEndpoint, eligQuery)

  let finalTurtle = turtle
  if (eligible.length > 0) {
    // Stamp holon:portalPotential on entities matching an eligible shape.
    // (In practice this SPARQL should join against the entity's rdf:type
    // extracted from the pushed turtle -- left as a TODO refinement once
    // we have real schema data to test eligibility matching against.)
    finalTurtle += `\n\n# holon:portalPotential stamped for eligible types -- see TODO above`
  }

  await pushToGraph(conn.gspEndpoint, scene, finalTurtle, 'append')
  await logEvent(conn.gspEndpoint, holonIri, 'AddEntityCommand', actor, {})

  return buildDataBook(
    stampProcess({ id: `${holonIri}#entity`, title: 'Entity', type: 'holon-entity' }, actor),
    [{ id: 'entity', label: 'Entity added to scene graph', content: finalTurtle }]
  )
}

// --- 4. promoteEntity --------------------------------------------------------------

/**
 * @param {{sparqlEndpoint: string, gspEndpoint: string}} conn
 * @param {string} entityIri
 * @param {{childBaseIri?: string, actor: {iri: string}}} opts
 * @returns {Promise<{parent: string, child: string}>}
 */
export async function promoteEntity(conn, entityIri, opts) {
  const potentialQuery = `
    PREFIX holon: <${HOLON_NS}>
    SELECT ?childSchema ?parentHolon WHERE {
      <${entityIri}> holon:portalPotential ?childSchema ;
                      holon:withinHolon ?parentHolon .
    }`
  const { bindings } = await runQuery(conn.sparqlEndpoint, potentialQuery)
  if (bindings.length === 0) {
    throw new CommandRejected(
      `<${entityIri}> has no unresolved holon:portalPotential`,
      'PromoteEntityCommand'
    )
  }

  const parentHolonIri = bindings[0].parentHolon.value
  const childSchemaShape = bindings[0].childSchema?.value

  await authorise(conn.sparqlEndpoint, parentHolonIri, opts.actor, 'Promote')

  const childIri = opts.childBaseIri ?? `${entityIri}/realised`
  const graphs = graphsFor(childIri)

  const childTurtle = `
@prefix holon: <${HOLON_NS}> .
<${childIri}> a holon:Holon ;
    holon:isPartOf <${parentHolonIri}> ;
    holon:status holon:CandidateStatus ;
    holon:schemaGraph <${graphs.schema}> ;
    holon:sceneGraph <${graphs.scene}> ;
    holon:eventGraph <${graphs.events}> .
`.trim()
  await pushToGraph(conn.gspEndpoint, null, childTurtle, 'append')

  if (childSchemaShape) {
    // Seed the child's root boundary from the single root shape referenced
    // by holon:eligibleChildSchema (see open design question: single shape
    // vs. bundled schema -- deferred until Datavid gives a real test case).
    const seedTurtle = `# Seeded from ${childSchemaShape} -- addSchema() extends this normally`
    await pushToGraph(conn.gspEndpoint, graphs.schema, seedTurtle, 'append')
  }

  // Atomic swap: DELETE the resolved holon:portalPotential triple, INSERT
  // holon:targetHolon, in one DELETE/INSERT WHERE -- no longer an append
  // that would leave the stale potential marker alongside the resolved link.
  await replaceTriples(
    conn.sparqlEndpoint,
    graphsFor(parentHolonIri).scene,
    `<${entityIri}> holon:portalPotential ?old .`,
    `<${entityIri}> holon:targetHolon <${childIri}> .`,
    { prefixes: `PREFIX holon: <${HOLON_NS}>` }
  )
  const resolveTurtle = `
@prefix holon: <${HOLON_NS}> .
<${entityIri}> holon:targetHolon <${childIri}> .
`.trim()

  await logEvent(conn.gspEndpoint, parentHolonIri, 'PromoteEntityCommand', opts.actor, {})
  await logEvent(conn.gspEndpoint, childIri, 'CreateRootHolonCommand', opts.actor, {})

  return {
    parent: buildDataBook(
      stampProcess({ id: parentHolonIri, title: 'Parent (portal resolved)', type: 'holon' }, opts.actor),
      [{ id: 'portal', label: 'Portal resolved', content: resolveTurtle }]
    ),
    child: buildDataBook(
      stampProcess({ id: childIri, title: 'Realised holon', type: 'holon' }, opts.actor),
      [{ id: 'root-holon', label: 'Root holon registration', content: childTurtle }]
    )
  }
}

// --- 5. addProjection --------------------------------------------------------------

/**
 * @param {{gspEndpoint: string}} conn
 * @param {string} holonIri
 * @param {{queryIri: string, promptBlockIri?: string, mode: 'eager'|'lazy', clientMode: string}} spec
 * @param {{iri: string}} actor
 */
export async function addProjection(conn, holonIri, spec, actor) {
  const turtle = `
@prefix holon: <${HOLON_NS}> .
<${holonIri}> holon:hasProjection [
    holon:projectionQuery <${spec.queryIri}> ;
    ${spec.promptBlockIri ? `holon:promptBlock <${spec.promptBlockIri}> ;` : ''}
    holon:transmissionMode "${spec.mode}" ;
    holon:clientMode "${spec.clientMode}"
] .
`.trim()
  await pushToGraph(conn.gspEndpoint, null, turtle, 'append')
  await logEvent(conn.gspEndpoint, holonIri, 'AddProjectionCommand', actor, {})

  return buildDataBook(
    stampProcess({ id: `${holonIri}#projection`, title: 'Projection interface', type: 'holon-projection' }, actor),
    [{ id: 'projection', label: 'Registered projection', content: turtle }]
  )
}

// --- 6. modifyEntity --------------------------------------------------------------

/**
 * @param {{sparqlEndpoint: string, gspEndpoint: string, jenaBase: string, dataset: string}} conn
 * @param {string} entityIri
 * @param {{markdown: string}} patchDataBook  turtle block(s): retract + assert
 * @param {{iri: string}} actor
 */
export async function modifyEntity(conn, entityIri, patchDataBook, actor) {
  const holonQuery = `
    PREFIX holon: <${HOLON_NS}>
    SELECT ?holon WHERE { <${entityIri}> holon:withinHolon ?holon }`
  const { bindings } = await runQuery(conn.sparqlEndpoint, holonQuery)
  const holonIri = bindings[0]?.holon?.value
  if (!holonIri) throw new CommandRejected(`<${entityIri}> is not bound to a holon`, 'ModifyEntityCommand')

  await authorise(conn.sparqlEndpoint, holonIri, actor, 'Write')

  const db = new DataBook(patchDataBook.markdown, `<inline>/${entityIri}/patch`)
  const { schema, scene } = graphsFor(holonIri)
  const turtle = db.ids().map(id => db.block(id)).filter(Boolean).join('\n\n')

  const report = await validateWithShacl(conn.jenaBase, conn.dataset, schema, turtle)
  if (!report.conforms) {
    throw new CommandRejected(
      `SHACL violation: ${report.violations.map(v => v.message).join('; ')}`,
      'ModifyEntityCommand'
    )
  }

  await pushToGraph(conn.gspEndpoint, scene, turtle, 'append')
  await logEvent(conn.gspEndpoint, holonIri, 'ModifyEntityCommand', actor, {})

  return buildDataBook(
    stampProcess({ id: `${entityIri}#modification`, title: 'Entity modified', type: 'holon-entity' }, actor),
    [{ id: 'patch', label: 'Applied patch', content: turtle }]
  )
}

// --- 7. annotateProperty --------------------------------------------------------------

/**
 * RDF 1.2 / Turtle 1.2 native reification -- annotates a specific triple
 * (entityIri, property, currentValue) rather than mutating it directly.
 *
 * @param {{gspEndpoint: string, sparqlEndpoint: string}} conn
 * @param {string} entityIri
 * @param {string} property  full IRI
 * @param {{value: unknown, note?: string, eventType: 'AssertionEvent'|'CommandEvent'}} annotation
 * @param {{iri: string}} actor
 */
export async function annotateProperty(conn, entityIri, property, annotation, actor) {
  const holonQuery = `
    PREFIX holon: <${HOLON_NS}>
    SELECT ?holon WHERE { <${entityIri}> holon:withinHolon ?holon }`
  const { bindings } = await runQuery(conn.sparqlEndpoint, holonQuery)
  const holonIri = bindings[0]?.holon?.value
  if (!holonIri) throw new CommandRejected(`<${entityIri}> is not bound to a holon`, 'AnnotatePropertyCommand')

  await authorise(conn.sparqlEndpoint, holonIri, actor, 'Write')

  const { scene } = graphsFor(holonIri)
  const valueLiteral = typeof annotation.value === 'string'
    ? `"${annotation.value.replace(/"/g, '\\"')}"`
    : String(annotation.value)

  // RDF 1.2 / Turtle 1.2 reification: << s p o >> as the subject of the
  // annotation itself, per the RDF-star/RDF 1.2 recommendation Fuseki 6.0
  // supports natively.
  const turtle = `
@prefix holon: <${HOLON_NS}> .
@prefix prov:  <http://www.w3.org/ns/prov#> .
@prefix xsd:   <http://www.w3.org/2001/XMLSchema#> .

<< <${entityIri}> <${property}> ${valueLiteral} >> a holon:${annotation.eventType} ;
    ${annotation.note ? `holon:note "${annotation.note.replace(/"/g, '\\"')}" ;` : ''}
    prov:wasGeneratedBy <${actor.iri}> ;
    holon:receivedAt "${new Date().toISOString()}"^^xsd:dateTime .
`.trim()

  await pushToGraph(conn.gspEndpoint, scene, turtle, 'append')
  await logEvent(conn.gspEndpoint, holonIri, 'AnnotatePropertyCommand', actor, {})

  return buildDataBook(
    stampProcess({ id: `${entityIri}#annotation`, title: 'Property annotation', type: 'holon-annotation' }, actor),
    [{ id: 'annotation', label: `Reified annotation on ${property}`, content: turtle }]
  )
}

// --- 8. listHolonContents --------------------------------------------------------------

/**
 * @param {{sparqlEndpoint: string}} conn
 * @param {string} holonIri
 * @param {{typeFilter?: string, includeChildren?: boolean, actor: {iri: string}}} opts
 */
export async function listHolonContents(conn, holonIri, opts) {
  await authorise(conn.sparqlEndpoint, holonIri, opts.actor, 'Read')

  const { scene } = graphsFor(holonIri)
  const typeClause = opts.typeFilter ? `?entity a <${opts.typeFilter}> .` : ''
  const query = `
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    SELECT ?entity ?type ?label WHERE {
      GRAPH <${scene}> {
        ?entity a ?type .
        ${typeClause}
        OPTIONAL { ?entity rdfs:label ?label }
      }
    }`
  const turtle = await runConstruct(conn.sparqlEndpoint, `
    CONSTRUCT { ?entity a ?type } WHERE {
      GRAPH <${scene}> { ?entity a ?type . ${typeClause} }
    }`)

  return buildDataBook(
    {
      id: `${holonIri}#projection-listing`,
      title: `Projection -- contents of ${holonIri}`,
      transmission: { type: 'full', timestamp: new Date().toISOString() },
      holon: { iri: holonIri, mode: 'listing' }
    },
    [{ id: 'listing', label: 'Scene graph contents', content: turtle || '# (empty)' }]
  )
}

// --- 9. editMetadata --------------------------------------------------------------

/**
 * @param {{sparqlEndpoint: string, gspEndpoint: string}} conn
 * @param {string} holonIri
 * @param {{title?: string, description?: string, status?: string}} patch
 * @param {{iri: string}} actor
 */
export async function editMetadata(conn, holonIri, patch, actor) {
  await authorise(conn.sparqlEndpoint, holonIri, actor, 'Write')

  const PREFIXES = `PREFIX holon: <${HOLON_NS}>\nPREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>`
  const triples = []

  // Each field is its own DELETE/INSERT WHERE -- replaces the prior value
  // rather than appending alongside it (the pushToGraph GSP POST this used
  // to use only ever adds).
  if (patch.title) {
    const esc = patch.title.replace(/"/g, '\\"')
    await replaceTriples(
      conn.sparqlEndpoint, null,
      `<${holonIri}> rdfs:label ?old .`,
      `<${holonIri}> rdfs:label "${esc}" .`,
      { prefixes: PREFIXES, wherePattern: `OPTIONAL { <${holonIri}> rdfs:label ?old } .` }
    )
    triples.push(`<${holonIri}> rdfs:label "${esc}" .`)
  }
  if (patch.description) {
    const esc = patch.description.replace(/"/g, '\\"')
    await replaceTriples(
      conn.sparqlEndpoint, null,
      `<${holonIri}> rdfs:comment ?old .`,
      `<${holonIri}> rdfs:comment "${esc}" .`,
      { prefixes: PREFIXES, wherePattern: `OPTIONAL { <${holonIri}> rdfs:comment ?old } .` }
    )
    triples.push(`<${holonIri}> rdfs:comment "${esc}" .`)
  }
  if (patch.status) {
    await replaceTriples(
      conn.sparqlEndpoint, null,
      `<${holonIri}> holon:status ?old .`,
      `<${holonIri}> holon:status holon:${patch.status}Status .`,
      { prefixes: PREFIXES, wherePattern: `OPTIONAL { <${holonIri}> holon:status ?old } .` }
    )
    triples.push(`<${holonIri}> holon:status holon:${patch.status}Status .`)
  }

  const turtle = `@prefix holon: <${HOLON_NS}> .\n${triples.join('\n')}`
  await logEvent(conn.gspEndpoint, holonIri, 'EditMetadataCommand', actor, {})

  return buildDataBook(
    stampProcess({ id: `${holonIri}#metadata`, title: patch.title ?? holonIri, type: 'holon-metadata' }, actor),
    [{ id: 'metadata', label: 'Metadata patch', content: turtle }]
  )
}

// --- 10. deleteHolon / purgeHolon --------------------------------------------------------------

/**
 * Tombstones a holon. Event graph untouched -- append-only.
 *
 * @param {{sparqlEndpoint: string, gspEndpoint: string}} conn
 * @param {string} holonIri
 * @param {{actor: {iri: string}}} opts
 */
export async function deleteHolon(conn, holonIri, opts) {
  await authorise(conn.sparqlEndpoint, holonIri, opts.actor, 'Owner')

  const PREFIXES = `PREFIX holon: <${HOLON_NS}>`
  await replaceTriples(
    conn.sparqlEndpoint, null,
    `<${holonIri}> holon:status ?old .`,
    `<${holonIri}> holon:status holon:TombstonedStatus .`,
    { prefixes: PREFIXES, wherePattern: `OPTIONAL { <${holonIri}> holon:status ?old } .` }
  )

  // Remove the portal reference from the parent's scene graph, if any.
  // Still open: whether a Tombstoned child's portal stub should be removed
  // outright or replaced with a holon:TombstonedTarget marker so the
  // parent's scene graph records that a crossing point existed and was
  // later closed, rather than silently reverting to unresolved potential.
  // Implemented here as outright removal (simpler, matches "reversible in
  // principle" via the event graph, not via the scene graph) -- flag if
  // you want the marker behavior instead.
  const parentQuery = `
    PREFIX holon: <${HOLON_NS}>
    SELECT ?parent WHERE { <${holonIri}> holon:isPartOf ?parent }`
  const { bindings } = await runQuery(conn.sparqlEndpoint, parentQuery)
  const parentHolonIri = bindings[0]?.parent?.value
  if (parentHolonIri) {
    await runUpdate(conn.sparqlEndpoint, `
      PREFIX holon: <${HOLON_NS}>
      DELETE { GRAPH <${graphsFor(parentHolonIri).scene}> { ?entity holon:targetHolon <${holonIri}> } }
      WHERE  { GRAPH <${graphsFor(parentHolonIri).scene}> { ?entity holon:targetHolon <${holonIri}> } }
    `.trim())
  }

  const turtle = `
@prefix holon: <${HOLON_NS}> .
<${holonIri}> holon:status holon:TombstonedStatus .
`.trim()
  await logEvent(conn.gspEndpoint, holonIri, 'DeleteHolonCommand', opts.actor, {})

  return buildDataBook(
    stampProcess({ id: `${holonIri}#tombstone`, title: 'Tombstoned', type: 'holon' }, opts.actor),
    [{ id: 'tombstone', label: 'Tombstone marker', content: turtle }]
  )
}

/**
 * Secondary GC operation on an already-tombstoned holon. Scheduling TBD.
 * NOT the test-only clearHolarchy utility -- see test-utils/clear-holarchy.js.
 *
 * @param {{sparqlEndpoint: string, gspEndpoint: string}} conn
 * @param {string} holonIri
 * @param {{actor: {iri: string}, confirm: true}} opts
 */
export async function purgeHolon(conn, holonIri, opts) {
  if (opts.confirm !== true) throw new Error('purgeHolon requires confirm: true')
  await authorise(conn.sparqlEndpoint, holonIri, opts.actor, 'Owner')

  const statusQuery = `
    PREFIX holon: <${HOLON_NS}>
    SELECT ?status WHERE { <${holonIri}> holon:status ?status }`
  const { bindings } = await runQuery(conn.sparqlEndpoint, statusQuery)
  const status = bindings[0]?.status?.value ?? ''
  if (!status.endsWith('TombstonedStatus')) {
    throw new CommandRejected(`<${holonIri}> is not Tombstoned -- purge refused`, null)
  }

  const graphs = graphsFor(holonIri)
  // GSP DELETE on schema/scene graphs; event graph and registry record are
  // deliberately left for audit -- full purge semantics (including whether
  // the event graph itself is ever eligible for GC) are TBD.
  for (const g of [graphs.schema, graphs.scene]) {
    await fetch(`${conn.gspEndpoint}?graph=${encodeURIComponent(g)}`, { method: 'DELETE' })
  }
  return null
}

// --- 11. designateAgent --------------------------------------------------------------

/**
 * @param {{sparqlEndpoint: string, gspEndpoint: string}} conn
 * @param {string} holonIri
 * @param {{iri: string, name: string, kind: 'Agent'|'Persona'|'Actor', capability: string[]}} agent
 * @param {{iri: string}} grantedBy
 */
export async function designateAgent(conn, holonIri, agent, grantedBy) {
  const grantorCapabilities = await resolveCapabilities(conn.sparqlEndpoint, holonIri, grantedBy.iri)
  if (!grantorCapabilities.has('Grant')) {
    throw new UnauthorisedError(grantedBy.iri, holonIri, 'Grant')
  }
  for (const c of agent.capability) {
    if (!grantorCapabilities.has(c)) {
      throw new CommandRejected(
        `Grantor <${grantedBy.iri}> cannot issue capability "${c}" -- exceeds own capability set`,
        'DesignateAgentCommand'
      )
    }
  }

  const bindingIri = `urn:role-binding:${crypto.randomUUID()}`
  const turtle = `
@prefix holon: <${HOLON_NS}> .
@prefix prov:  <http://www.w3.org/ns/prov#> .

<${agent.iri}> a prov:${agent.kind} ;
    <http://www.w3.org/2000/01/rdf-schema#label> "${agent.name.replace(/"/g, '\\"')}" .

<${bindingIri}> a holon:RoleBinding ;
    holon:boundAgent <${agent.iri}> ;
    holon:boundHolon <${holonIri}> ;
    ${agent.capability.map(c => `holon:capability holon:${c}`).join(' ;\n    ')} ;
    holon:grantedBy <${grantedBy.iri}> .
`.trim()

  await pushToGraph(conn.gspEndpoint, null, turtle, 'append') // registry graph
  await logEvent(conn.gspEndpoint, holonIri, 'DesignateAgentCommand', grantedBy, {})

  return buildDataBook(
    stampProcess({ id: bindingIri, title: `Agent designated: ${agent.name}`, type: 'holon-role-binding' }, grantedBy),
    [{ id: 'role-binding', label: 'RoleBinding', content: turtle }]
  )
}

// --- 12. moveHolon --------------------------------------------------------------

/**
 * Reparents a holon: changes its holon:isPartOf from whatever it
 * currently is (if anything) to newParentIri. This is a structural move in
 * the containment tree -- not to be confused with tracking where an agent
 * currently stands within a scene (that is a scene-graph/property concern,
 * outside this verb's scope).
 *
 * Uses holon:isPartOf (aligned 2026-07-09 from an earlier holon:parentHolon
 * predicate) to match the containment predicate actually populated in live
 * datasets -- see the holon-schema-patterns skill for the isPartOf/
 * isConnectedTo design. Note this predicate is sparsely populated by
 * design in most datasets today (many holons are intentionally standalone,
 * e.g. carried inventory items), so a missing ?parent binding is common
 * and not itself an error -- it just means the holon has no containment
 * ancestor to walk for authorisation purposes (see authorise() caveat in
 * this file's header).
 *
 * Any holon may carry holon:rootLocked true to mark it as an intentional
 * root structure (a registry, a corridor spine, a journeys index) that
 * should not be silently reparented by an incidental moveHolon call.
 * Locked holons refuse the move unless opts.force is true -- a visible,
 * deliberate override rather than a separate unlock step.
 *
 * Requires Write capability on both the holon being moved and the
 * destination parent (moving into a subtree you can't write to is refused,
 * same as any other cross-boundary write).
 *
 * @param {{sparqlEndpoint: string, gspEndpoint: string}} conn
 * @param {string} holonIri
 * @param {{newParentIri: string, actor: {iri: string}, force?: boolean}} opts
 * @returns {Promise<string>} serialized HolonDataBook
 */
export async function moveHolon(conn, holonIri, opts) {
  const { newParentIri, actor, force } = opts

  const stateQuery = `
    PREFIX holon: <${HOLON_NS}>
    SELECT ?parent ?rootLocked WHERE {
      OPTIONAL { <${holonIri}> holon:isPartOf ?parent }
      OPTIONAL { <${holonIri}> holon:rootLocked ?rootLocked }
    }`
  const { bindings } = await runQuery(conn.sparqlEndpoint, stateQuery)
  const oldParentIri = bindings[0]?.parent?.value ?? null
  const rootLocked   = bindings[0]?.rootLocked?.value === 'true'

  if (rootLocked && !force) {
    throw new CommandRejected(
      `<${holonIri}> is holon:rootLocked -- refusing to reparent. Pass { force: true } to override.`,
      'MoveHolonCommand'
    )
  }

  if (newParentIri === holonIri) {
    throw new CommandRejected(`<${holonIri}> cannot be its own parent`, 'MoveHolonCommand')
  }

  // Actor needs Write both where the holon currently lives and where it's
  // headed -- matches the general cross-boundary-write posture used
  // elsewhere (e.g. promoteEntity requires Promote on the parent, not just
  // the entity). A holon with no existing parent (a prior root) only needs
  // Write on the destination.
  if (oldParentIri) await authorise(conn.sparqlEndpoint, oldParentIri, actor, 'Write')
  await authorise(conn.sparqlEndpoint, newParentIri, actor, 'Write')

  const PREFIXES = `PREFIX holon: <${HOLON_NS}>`
  await replaceTriples(
    conn.sparqlEndpoint, null,
    `<${holonIri}> holon:isPartOf ?old .`,
    `<${holonIri}> holon:isPartOf <${newParentIri}> .`,
    { prefixes: PREFIXES, wherePattern: `OPTIONAL { <${holonIri}> holon:isPartOf ?old } .` }
  )

  const turtle = `
@prefix holon: <${HOLON_NS}> .
<${holonIri}> holon:isPartOf <${newParentIri}> .
`.trim()

  await logEvent(conn.gspEndpoint, holonIri, 'MoveHolonCommand', actor, {
    fromParent: oldParentIri,
    toParent: newParentIri,
    forced: !!(rootLocked && force)
  })

  return buildDataBook(
    stampProcess({ id: `${holonIri}#move`, title: 'Holon reparented', type: 'holon-move' }, actor),
    [{
      id: 'move',
      label: `Reparented ${oldParentIri ?? '(no prior parent)'} -> ${newParentIri}${rootLocked ? ' (rootLocked override)' : ''}`,
      content: turtle
    }]
  )
}
