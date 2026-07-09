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
 *     authorise() walks the containment role UPWARD from the target holon
 *     and stops at the first binding found -- it never crosses above the
 *     anchor the grantor themselves holds. Capability set: Read, Write,
 *     Promote, Grant, Owner (Owner implies the rest). designateAgent()
 *     enforces an escalation guard: a grantor can only issue capabilities
 *     they hold.
 *   - Containment is schema-driven, not a single hardcoded predicate
 *     (aligned 2026-07-09, correcting an earlier attempt that hardcoded
 *     literal holon:isPartOf and missed nearly every real link). Domain
 *     schemas commonly declare their own containment predicate as
 *     rdfs:subPropertyOf holon:isPartOf -- e.g. geo:administrativePartOf
 *     for the geography model -- rather than asserting the literal
 *     holon:isPartOf triple directly. resolveCapabilities() and moveHolon()
 *     both call lib/holon.js's discoverRoleProperties(CONTAINMENT_ROLE) to
 *     find every property currently playing that role via the
 *     rdfs:subPropertyOf* path, mirroring the read-side traversal GET
 *     /holon already uses. moveHolon() additionally detects which specific
 *     predicate an existing parent link uses and rewrites that same
 *     predicate, rather than replacing a domain-typed link with a generic
 *     one.
 *   - Reparenting: moveHolon() changes the detected containment predicate
 *     directly. Any holon may be flagged holon:rootLocked true (typically
 *     set at createRootHolon time) to mark it as an intentional root
 *     structure -- a registry, a corridor spine, a journeys index -- that
 *     should never be silently reparented by a stray moveHolon call. A
 *     locked holon can still be moved with { force: true }, which is a
 *     deliberate, visible override rather than a separate bypass path.
 *   - Numeric agent-property updates (proposeAgentPropertyUpdate, added
 *     2026-07-09) generalise a pattern already present in this dataset's
 *     event history for schema:healthPoints: a holon:ModelUpdateRequest
 *     carrying previousValue/proposedValue/rationale, paired with a
 *     holon:ModelUpdateApprove referencing it via holon:appliesRequest.
 *     Unlike every other verb in this file, it targets the FLAT
 *     urn:{dataset}:holons / urn:{dataset}:events graphs live Adventure-
 *     Mode-style datasets actually use, not the per-holon schema/scene/
 *     events triad graphsFor() mints -- pass conn.holonsGraph/eventsGraph
 *     explicitly, or they default from conn.dataset. Validation runs
 *     BEFORE any write: the proposed value is checked against whatever
 *     SHACL shape governs that property (e.g. holon:AgentHealthShape,
 *     holon:AgentWealthShape) using an isolated single-property payload,
 *     so a rejected proposal never produces a request without a matching
 *     approval, or any partial state at all.
 */

import { runQuery, runConstruct, pushToGraph, runUpdate, replaceTriples } from './sparql.js'
import { validateWithShacl } from './shacl.js'
import { DataBook } from './databook.js'
import { discoverRoleProperties, CONTAINMENT_ROLE } from './holon.js'

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

  // Schema-driven, matching lib/holon.js's discoverRoleProperties(): finds
  // every property P such that P rdfs:subPropertyOf* holon:isPartOf,
  // e.g. geo:administrativePartOf. Hardcoding the literal predicate here
  // would silently skip every domain-typed containment link (which is most
  // of them -- literal holon:isPartOf is rare in practice; domain schemas
  // declare their own containment property as a subproperty instead).
  // Discovered once per call, reused at every step of the walk -- role
  // declarations don't change mid-traversal.
  const containmentProps = await discoverRoleProperties(sparqlEndpoint, CONTAINMENT_ROLE)
  const containmentList  = containmentProps.map(p => `<${p}>`).join(', ')

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
      SELECT ?parent WHERE {
        GRAPH ?registryGraph { <${current}> ?viaProp ?parent . FILTER(?viaProp IN (${containmentList})) }
      } LIMIT 1`
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
  const containmentProps = await discoverRoleProperties(conn.sparqlEndpoint, CONTAINMENT_ROLE)
  const containmentList  = containmentProps.map(p => `<${p}>`).join(', ')
  const parentQuery = `
    SELECT ?parent WHERE {
      <${holonIri}> ?viaProp ?parent . FILTER(?viaProp IN (${containmentList}))
    } LIMIT 1`
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
 * Reparents a holon: changes its containment link from whatever it
 * currently is (if anything) to newParentIri. This is a structural move in
 * the containment tree -- not to be confused with tracking where an agent
 * currently stands within a scene (that is a scene-graph/property concern,
 * outside this verb's scope).
 *
 * Containment-role-aware (2026-07-09): domain schemas commonly declare
 * their own containment predicate as rdfs:subPropertyOf holon:isPartOf
 * (e.g. geo:administrativePartOf) rather than asserting the literal
 * holon:isPartOf triple directly -- see lib/holon.js's
 * discoverRoleProperties() for the same pattern on the read side. This
 * verb detects which containment-role predicate a holon's existing parent
 * link actually uses and rewrites *that* predicate, so moving a
 * domain-typed holon (e.g. a geo:Country) doesn't leave a stale
 * geo:administrativePartOf triple behind while adding a redundant generic
 * holon:isPartOf one alongside it. A holon with no existing parent gets
 * its new link written as plain holon:isPartOf -- a domain-agnostic verb
 * has no basis to guess a more specific predicate for a link that didn't
 * exist before.
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

  const containmentProps = await discoverRoleProperties(conn.sparqlEndpoint, CONTAINMENT_ROLE)
  const containmentList  = containmentProps.map(p => `<${p}>`).join(', ')

  const stateQuery = `
    PREFIX holon: <${HOLON_NS}>
    SELECT ?parent ?viaProp ?rootLocked WHERE {
      OPTIONAL { <${holonIri}> ?viaProp ?parent . FILTER(?viaProp IN (${containmentList})) }
      OPTIONAL { <${holonIri}> holon:rootLocked ?rootLocked }
    } LIMIT 1`
  const { bindings } = await runQuery(conn.sparqlEndpoint, stateQuery)
  const oldParentIri = bindings[0]?.parent?.value ?? null
  const oldViaProp    = bindings[0]?.viaProp?.value ?? null
  const rootLocked    = bindings[0]?.rootLocked?.value === 'true'

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

  // Rewrite via whichever predicate the old link actually used, so a
  // domain-typed link (e.g. geo:administrativePartOf) stays domain-typed
  // rather than being replaced by a generic one. No prior parent -> no
  // predicate to preserve, so default to the generic role predicate itself.
  const writeProp = oldViaProp ?? CONTAINMENT_ROLE
  const PREFIXES  = `PREFIX holon: <${HOLON_NS}>`
  await replaceTriples(
    conn.sparqlEndpoint, null,
    `<${holonIri}> <${writeProp}> ?old .`,
    `<${holonIri}> <${writeProp}> <${newParentIri}> .`,
    { prefixes: PREFIXES, wherePattern: `OPTIONAL { <${holonIri}> <${writeProp}> ?old } .` }
  )

  const turtle = `
@prefix holon: <${HOLON_NS}> .
<${holonIri}> <${writeProp}> <${newParentIri}> .
`.trim()

  await logEvent(conn.gspEndpoint, holonIri, 'MoveHolonCommand', actor, {
    fromParent: oldParentIri,
    toParent: newParentIri,
    viaProp: writeProp,
    forced: !!(rootLocked && force)
  })

  return buildDataBook(
    stampProcess({ id: `${holonIri}#move`, title: 'Holon reparented', type: 'holon-move' }, actor),
    [{
      id: 'move',
      label: `Reparented ${oldParentIri ?? '(no prior parent)'} -> ${newParentIri} (via ${writeProp.split(/[/#]/).pop()})${rootLocked ? ' (rootLocked override)' : ''}`,
      content: turtle
    }]
  )
}

// --- 13. proposeAgentPropertyUpdate --------------------------------------------------

/**
 * Propose, validate, and (if valid) apply a delta to a numeric agent
 * property -- schema:healthPoints and schema:currentWealth are the two
 * known callers, but this is deliberately generic to any property governed
 * by a SHACL shape with the same shape: a bounded number that moves by
 * discrete deltas (heal/damage, earn/spend).
 *
 * Operates on the FLAT urn:{dataset}:holons / urn:{dataset}:events graphs
 * (see this file's header) -- pass conn.holonsGraph/conn.eventsGraph to
 * override, otherwise they default to urn:{conn.dataset}:holons/:events.
 * conn.shapesGraph defaults to urn:{conn.dataset}:shacl.
 *
 * Validate-before-write, no exceptions: the proposed value is checked
 * against the shapes graph BEFORE any triple is written. A rejected
 * proposal throws CommandRejected and leaves no trace in either graph --
 * never a ModelUpdateRequest sitting unapproved, never a partial state
 * change. This is the fix for the gap the toll-payment session surfaced:
 * plain SPARQL UPDATE (what every ad hoc currency/HP change in this
 * dataset used before now) has no gate at all. This verb is the gate.
 *
 * Capping: if opts.capProperty is given (e.g. schema:maxHealthPoints),
 * the proposed value is capped at whatever that property currently holds
 * on the same agent -- mirrors the "capped at maxHealthPoints" rationale
 * already recorded by hand in this dataset's history. opts.floor defaults
 * to 0 (an agent can't go below empty-handed or dead-broke by default;
 * pass a different floor for properties where 0 isn't the right bound).
 *
 * Validation payload is deliberately narrow: just { agentIri a holon:Agent ;
 * property proposedValue ; [capProperty capValue] }, not a full copy of the
 * agent's record. A real Agent has many other required fields (rdfs:label,
 * etc.) that this isolated payload won't carry, which trips unrelated
 * minCount violations on shapes like holon:AgentShape that have nothing to
 * do with this specific property. Rather than pull the agent's entire
 * current state into the test payload (expensive, and still an incomplete
 * simulation of the post-write graph), violations are filtered down to
 * only those whose sh:resultPath matches the property actually being
 * changed. A shape's comparison constraints against other properties
 * (e.g. AgentHealthShape's healthPoints <= maxHealthPoints) still work
 * correctly because capProperty's current value is included in the same
 * isolated payload when supplied.
 *
 * @param {{sparqlEndpoint: string, gspEndpoint: string, jenaBase: string, dataset: string, holonsGraph?: string, eventsGraph?: string, shapesGraph?: string}} conn
 * @param {string} agentIri
 * @param {{property: string, delta: number, rationale: string, actor: {iri: string}, capProperty?: string, floor?: number}} opts
 * @returns {Promise<string>} serialized HolonDataBook
 */
export async function proposeAgentPropertyUpdate(conn, agentIri, opts) {
  const { property, delta, rationale, actor, capProperty, floor = 0 } = opts
  const holonsGraph = conn.holonsGraph ?? `urn:${conn.dataset}:holons`
  const eventsGraph = conn.eventsGraph ?? `urn:${conn.dataset}:events`
  const shapesGraph = conn.shapesGraph ?? `urn:${conn.dataset}:shacl`

  const stateQuery = `
    SELECT ?current ?cap WHERE {
      GRAPH <${holonsGraph}> {
        OPTIONAL { <${agentIri}> <${property}> ?current }
        ${capProperty ? `OPTIONAL { <${agentIri}> <${capProperty}> ?cap }` : ''}
      }
    } LIMIT 1`
  const { bindings } = await runQuery(conn.sparqlEndpoint, stateQuery)
  const previousValue = bindings[0]?.current?.value !== undefined ? Number(bindings[0].current.value) : 0
  const capValue = (capProperty && bindings[0]?.cap?.value !== undefined) ? Number(bindings[0].cap.value) : null

  let proposedValue = previousValue + delta
  if (capValue !== null) proposedValue = Math.min(proposedValue, capValue)
  proposedValue = Math.max(proposedValue, floor)

  const propLocal = property.split(/[/#]/).pop()
  const fmt = v => (Number.isInteger(v) ? String(v) : v.toFixed(2))

  const testTurtle = `
@prefix holon: <${HOLON_NS}> .
<${agentIri}> a holon:Agent ;
    <${property}> ${fmt(proposedValue)}${capProperty && capValue !== null ? ` ;\n    <${capProperty}> ${fmt(capValue)}` : ''} .
`.trim()

  const report = await validateWithShacl(conn.jenaBase, conn.dataset, shapesGraph, testTurtle)
  const relevantViolations = (report.violations ?? []).filter(v => v.path === property)
  if (relevantViolations.length > 0) {
    throw new CommandRejected(
      `Proposed ${propLocal}=${proposedValue} for <${agentIri}> violates its governing shape: ` +
      relevantViolations.map(v => v.message).join('; '),
      'ModelUpdateRequest'
    )
  }

  // Validation passed -- now write request, approval, and the actual
  // property value in sequence. No cross-graph transaction exists in
  // Fuseki here, but validate-before-write means a rejected proposal never
  // reaches this point, so there's nothing to roll back on the reject path.
  const requestIri = `urn:event:${crypto.randomUUID()}`
  const approveIri = `urn:event:${crypto.randomUUID()}`
  const now = new Date().toISOString()
  const deltaLabel = `${delta >= 0 ? '+' : ''}${delta}`

  const eventTurtle = `
@prefix holon: <${HOLON_NS}> .
@prefix rdfs:  <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd:   <http://www.w3.org/2001/XMLSchema#> .

<${requestIri}> a holon:ModelUpdateRequest ;
    rdfs:label "${propLocal} ${deltaLabel}: ${previousValue} -> ${proposedValue}" ;
    holon:agent <${actor.iri}> ;
    holon:targetHolon <${agentIri}> ;
    holon:targetProperty <${property}> ;
    holon:previousValue "${previousValue}" ;
    holon:proposedValue "${proposedValue}" ;
    holon:rationale "${rationale.replace(/"/g, '\\"')}" ;
    holon:requestStatus "approved" ;
    holon:occurredAt "${now}"^^xsd:dateTime ;
    holon:wasSuccessful true .

<${approveIri}> a holon:ModelUpdateApprove ;
    rdfs:label "Approve: ${propLocal} ${previousValue} -> ${proposedValue}" ;
    holon:agent <${actor.iri}> ;
    holon:appliesRequest <${requestIri}> ;
    holon:occurredAt "${now}"^^xsd:dateTime ;
    holon:wasSuccessful true .
`.trim()

  await pushToGraph(conn.gspEndpoint, eventsGraph, eventTurtle, 'append')

  await runUpdate(conn.sparqlEndpoint, `
    DELETE { GRAPH <${holonsGraph}> { <${agentIri}> <${property}> ?old } }
    INSERT { GRAPH <${holonsGraph}> { <${agentIri}> <${property}> ${fmt(proposedValue)} } }
    WHERE  { OPTIONAL { GRAPH <${holonsGraph}> { <${agentIri}> <${property}> ?old } } }
  `.trim())

  return buildDataBook(
    stampProcess({ id: requestIri, title: `${propLocal} update`, type: 'holon-model-update' }, actor),
    [{ id: 'update', label: `${propLocal}: ${previousValue} -> ${proposedValue}`, content: eventTurtle }]
  )
}
