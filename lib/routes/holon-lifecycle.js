/**
 * lib/routes/holon-lifecycle.js
 *
 * GET /holon[/:iri] plus the eighteen holon lifecycle verbs. Extracted
 * from server.js 2026-07-19 -- first slice of the router split (see
 * server.js's own top-of-file note). Structural extraction only, no
 * behaviour change: every route body is unchanged except for how it
 * reads server.js's shared mutable dataset config, which now comes
 * through getter functions passed in at mount time rather than closing
 * over server.js's module-level `let`s directly (impossible across
 * modules). Because these are live getters, not a one-time snapshot,
 * a runtime dataset switch (POST /dataset) is still immediately visible
 * here exactly as it was before the extraction.
 *
 * Deliberately NOT converted to a shared state object in this pass --
 * see server.js's router-split roadmap comment for why (Kurt, 2026-07-19:
 * "we're not done developing... any deep refactor at this stage is
 * probably wasted effort" -- getter injection gets the same isolation
 * benefit as a state object without touching any route this pass didn't
 * need to touch).
 */

import express from 'express'
import { getHolonHandler } from '../holon.js'
import {
  createRootHolon, addSchema, addEntity, promoteEntity, addProjection,
  modifyEntity, annotateProperty, listHolonContents, editMetadata,
  deleteHolon, purgeHolon, designateAgent, moveHolon,
  proposeAgentPropertyUpdate, createAgent,
  formGroup, joinGroup, leaveGroup, navigateAgent,
  CommandRejected, UnauthorisedError
} from '../lifecycle.js'

/**
 * @param {object} deps
 * @param {() => string}      deps.getDataset
 * @param {() => string}      deps.getJenaBase
 * @param {() => string}      deps.getJenaSparql
 * @param {() => string}      deps.getJenaGsp
 * @param {() => string|null} deps.getDatasetHolonIri
 * @returns {import('express').Router}
 */
export function createHolonLifecycleRouter(deps) {
  const { getDataset, getJenaBase, getJenaSparql, getJenaGsp, getDatasetHolonIri } = deps
  const router = express.Router()

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
// its resolved IRI as the new focus for getDataset().

router.get('/holon', async (req, res) => {
  await getHolonHandler(req, res, { JENA_SPARQL: req.sparqlEndpoint, DATASET: req.datasetOverride || getDataset() })
})

router.get('/holon/:iri', async (req, res) => {
  await getHolonHandler(req, res, { JENA_SPARQL: req.sparqlEndpoint, DATASET: req.datasetOverride || getDataset() })
})

// -- Lifecycle verbs (P4) -------------------------------------------------------
//
// Thin REST wrappers around lib/lifecycle.js's eighteen holon lifecycle
// verbs. Wired 2026-07-09 -- previously lib/lifecycle.js existed but no
// route ever called it. Every mutating verb requires an explicit actor in
// the request body -- { actor: { iri, role? } } -- since this bridge has
// no per-request user identity beyond the shared Bearer token. The actor
// IRI is what ends up in prov:wasGeneratedBy and in RoleBinding capability
// checks; callers are responsible for supplying the right one.
//
// STATUS: createRootHolon through listHolonContents (the first eight verbs)
// assume the per-holon schema/scene/events graph triad lib/lifecycle.js's
// graphsFor() mints -- no live dataset currently uses that topology (see
// lib/holon.js's header). Calling those against an existing flat-graph
// holon (e.g. a geo:Country) mints new, disconnected {iri}/schema etc.
// graphs alongside the real data rather than operating on it. editMetadata,
// deleteHolon, purgeHolon, designateAgent, and moveHolon are graph-topology-
// agnostic (or touch only a per-holon scene graph that harmlessly doesn't
// exist for flat-graph holons) and are the ones actually verified against
// live Adventure Mode data so far -- see this session's chat history for
// the France/Europe/Earth/home RoleBinding walk that confirmed moveHolon's
// authorisation path end-to-end.
//
// navigateAgent (2026-07-11) is the newest addition -- targets the same
// flat urn:{dataset}:holons/:events graphs as proposeAgentPropertyUpdate/
// createAgent, not the schema/scene/events triad. Written specifically to
// close the gap surfaced this session: Kim Meades' Bonn -> Germany chain
// (urn:event:kim-visit-001/002) and her subsequent Germany -> Munich move
// were both written as bare currentLocation triples via raw SPARQL UPDATE,
// with no verb enforcing a VisitEvent alongside the change. Not yet
// exercised against live Adventure Mode data end-to-end -- verify the
// visit-chain-tail lookup and destination-existence check on next use.
//
// getLifecycleConn(req) now also threads getDatasetHolonIri() through as
// datasetHolonIri -- the anchor lib/lifecycle.js's flat-graph verbs
// (proposeAgentPropertyUpdate, createAgent, formGroup, joinGroup,
// leaveGroup) gate Write capability checks against. When getDatasetHolonIri()
// is null (nothing set via POST /dataset-holon-iri or getDatasetHolonIri()
// env var), the key is simply omitted from conn so lib/lifecycle.js's own
// datasetAnchor() fallback (urn:{dataset}:root) applies -- the convention
// default is defined in exactly one place.
//
// req (added v2.10.0): every lifecycle route now passes its own req into
// getLifecycleConn(req), so a caller with a per-request X-Dataset-Override
// header (see the dataset-override middleware above) gets a conn scoped to
// THEIR dataset rather than whatever the module-level getDataset() global
// currently is -- this is what makes lifecycle verbs (create_agent,
// propose_property_update, navigate_agent, and all others) respect the
// same per-actor sticky dataset selection as the SPARQL-only tools. req is
// optional and defaults every field to the global, so any call site that
// still passes nothing (there shouldn't be any left, but belt-and-braces)
// behaves exactly as before this change. NOTE: getDatasetHolonIri() itself
// remains a single global regardless of dataset -- a dataset-specific
// anchor holon isn't represented here yet; a caller working in a dataset
// other than the global one may find lifecycle capability checks anchored
// somewhere that doesn't make sense for their dataset. Known follow-on gap,
// not solved by this change.
//
// Errors: CommandRejected -> 409, UnauthorisedError -> 403, else -> 500.

function getLifecycleConn(req) {
  const conn = {
    sparqlEndpoint: req?.sparqlEndpoint || getJenaSparql(),
    gspEndpoint:    req?.gspEndpoint    || getJenaGsp(),
    jenaBase:       getJenaBase(),
    dataset:        req?.datasetOverride || getDataset(),
  }
  if (getDatasetHolonIri()) conn.datasetHolonIri = getDatasetHolonIri()
  return conn
}

function requireActor(body, field = 'actor') {
  const actor = body?.[field]
  if (!actor || typeof actor !== 'object' || !actor.iri || typeof actor.iri !== 'string')
    throw { status: 400, body: { error: `"${field}" is required and must be an object: { iri, role? }.` } }
  return actor
}

function handleLifecycleError(err, res) {
  if (err && typeof err.status === 'number' && err.body) return res.status(err.status).json(err.body)
  if (err instanceof CommandRejected)
    return res.status(409).json({ error: err.message, commandType: err.commandType })
  if (err instanceof UnauthorisedError)
    return res.status(403).json({ error: err.message, actorIri: err.actorIri, holonIri: err.holonIri, capability: err.capability })
  console.error('[Bridge] Lifecycle verb error:', err)
  return res.status(500).json({ error: 'Internal bridge error', message: err.message })
}

// -- POST /holon -- createRootHolon -----------------------------------------------
//
// Body: { baseIri, label, actor: {iri, role?}, rootLocked?: boolean }

router.post('/holon', async (req, res) => {
  try {
    const actor = requireActor(req.body)
    const { baseIri, label, rootLocked } = req.body ?? {}
    if (!baseIri || typeof baseIri !== 'string' || !label || typeof label !== 'string')
      return res.status(400).json({ error: '"baseIri" and "label" are required strings.' })
    const doc = await createRootHolon(getLifecycleConn(req), { baseIri, label, actor, rootLocked })
    return res.type('text/markdown').send(doc)
  } catch (err) { return handleLifecycleError(err, res) }
})

// -- POST /holon/:iri/schema -- addSchema ------------------------------------------
//
// Body: { schemaDataBook: { markdown }, actor }

router.post('/holon/:iri/schema', async (req, res) => {
  try {
    const actor = requireActor(req.body)
    const { schemaDataBook } = req.body ?? {}
    if (!schemaDataBook?.markdown || typeof schemaDataBook.markdown !== 'string')
      return res.status(400).json({ error: '"schemaDataBook.markdown" is required.' })
    const doc = await addSchema(getLifecycleConn(req), req.params.iri, schemaDataBook, actor)
    return res.type('text/markdown').send(doc)
  } catch (err) { return handleLifecycleError(err, res) }
})

// -- POST /holon/:iri/entity -- addEntity ------------------------------------------
//
// Body: { entityDataBook: { markdown }, actor }

router.post('/holon/:iri/entity', async (req, res) => {
  try {
    const actor = requireActor(req.body)
    const { entityDataBook } = req.body ?? {}
    if (!entityDataBook?.markdown || typeof entityDataBook.markdown !== 'string')
      return res.status(400).json({ error: '"entityDataBook.markdown" is required.' })
    const doc = await addEntity(getLifecycleConn(req), req.params.iri, entityDataBook, actor)
    return res.type('text/markdown').send(doc)
  } catch (err) { return handleLifecycleError(err, res) }
})

// -- POST /entity/:iri/promote -- promoteEntity ------------------------------------
//
// Body: { childBaseIri?, actor }
// Response: { parent: <databook markdown>, child: <databook markdown> }

router.post('/entity/:iri/promote', async (req, res) => {
  try {
    const actor = requireActor(req.body)
    const { childBaseIri } = req.body ?? {}
    const result = await promoteEntity(getLifecycleConn(req), req.params.iri, { childBaseIri, actor })
    return res.json({ parent: result.parent, child: result.child })
  } catch (err) { return handleLifecycleError(err, res) }
})

// -- POST /holon/:iri/projection -- addProjection -----------------------------------
//
// Body: { spec: { queryIri, promptBlockIri?, mode: 'eager'|'lazy', clientMode }, actor }

router.post('/holon/:iri/projection', async (req, res) => {
  try {
    const actor = requireActor(req.body)
    const { spec } = req.body ?? {}
    if (!spec?.queryIri || !spec?.mode || !spec?.clientMode)
      return res.status(400).json({ error: '"spec.queryIri", "spec.mode", and "spec.clientMode" are required.' })
    const doc = await addProjection(getLifecycleConn(req), req.params.iri, spec, actor)
    return res.type('text/markdown').send(doc)
  } catch (err) { return handleLifecycleError(err, res) }
})

// -- POST /entity/:iri/modify -- modifyEntity --------------------------------------
//
// Body: { patchDataBook: { markdown }, actor }

router.post('/entity/:iri/modify', async (req, res) => {
  try {
    const actor = requireActor(req.body)
    const { patchDataBook } = req.body ?? {}
    if (!patchDataBook?.markdown || typeof patchDataBook.markdown !== 'string')
      return res.status(400).json({ error: '"patchDataBook.markdown" is required.' })
    const doc = await modifyEntity(getLifecycleConn(req), req.params.iri, patchDataBook, actor)
    return res.type('text/markdown').send(doc)
  } catch (err) { return handleLifecycleError(err, res) }
})

// -- POST /entity/:iri/annotate -- annotateProperty --------------------------------
//
// Body: { property, annotation: { value, note?, eventType: 'AssertionEvent'|'CommandEvent' }, actor }

router.post('/entity/:iri/annotate', async (req, res) => {
  try {
    const actor = requireActor(req.body)
    const { property, annotation } = req.body ?? {}
    if (!property || typeof property !== 'string' || !annotation || annotation.value === undefined || !annotation.eventType)
      return res.status(400).json({ error: '"property" (string) and "annotation.{value,eventType}" are required.' })
    const doc = await annotateProperty(getLifecycleConn(req), req.params.iri, property, annotation, actor)
    return res.type('text/markdown').send(doc)
  } catch (err) { return handleLifecycleError(err, res) }
})

// -- GET /holon/:iri/contents -- listHolonContents ----------------------------------
//
// Read-only. Query params: actorIri (required), typeFilter?, includeChildren?

router.get('/holon/:iri/contents', async (req, res) => {
  try {
    const { actorIri, typeFilter, includeChildren } = req.query
    if (!actorIri || typeof actorIri !== 'string')
      return res.status(400).json({ error: 'Query param "actorIri" is required.' })
    const doc = await listHolonContents(getLifecycleConn(req), req.params.iri, {
      typeFilter: typeFilter || undefined,
      includeChildren: includeChildren === 'true',
      actor: { iri: actorIri }
    })
    return res.type('text/markdown').send(doc)
  } catch (err) { return handleLifecycleError(err, res) }
})

// -- POST /holon/:iri/metadata -- editMetadata --------------------------------------
//
// Body: { patch: { title?, description?, status?: 'Candidate'|'Registered'|'Tombstoned' }, actor }

router.post('/holon/:iri/metadata', async (req, res) => {
  try {
    const actor = requireActor(req.body)
    const { patch } = req.body ?? {}
    if (!patch || typeof patch !== 'object')
      return res.status(400).json({ error: '"patch" is required.' })
    const doc = await editMetadata(getLifecycleConn(req), req.params.iri, patch, actor)
    return res.type('text/markdown').send(doc)
  } catch (err) { return handleLifecycleError(err, res) }
})

// -- DELETE /holon/:iri -- deleteHolon ------------------------------------------------
//
// Body: { actor }. Tombstones (status -> Tombstoned); event graph untouched.

router.delete('/holon/:iri', async (req, res) => {
  try {
    const actor = requireActor(req.body)
    const doc = await deleteHolon(getLifecycleConn(req), req.params.iri, { actor })
    return res.type('text/markdown').send(doc)
  } catch (err) { return handleLifecycleError(err, res) }
})

// -- POST /holon/:iri/purge -- purgeHolon ---------------------------------------------
//
// Body: { actor, confirm: true }. Hard GC on an already-Tombstoned holon.

router.post('/holon/:iri/purge', async (req, res) => {
  try {
    const actor = requireActor(req.body)
    const { confirm } = req.body ?? {}
    await purgeHolon(getLifecycleConn(req), req.params.iri, { actor, confirm })
    return res.json({ purged: true, iri: req.params.iri })
  } catch (err) { return handleLifecycleError(err, res) }
})

// -- POST /holon/:iri/agent -- designateAgent -----------------------------------------
//
// Body: { agent: { iri, name, kind: 'Agent'|'Persona'|'Actor', capability: [...] }, grantedBy: { iri, role? } }

router.post('/holon/:iri/agent', async (req, res) => {
  try {
    const grantedBy = requireActor(req.body, 'grantedBy')
    const { agent } = req.body ?? {}
    if (!agent?.iri || !agent?.name || !agent?.kind || !Array.isArray(agent?.capability))
      return res.status(400).json({ error: '"agent.{iri,name,kind,capability[]}" are required.' })
    const doc = await designateAgent(getLifecycleConn(req), req.params.iri, agent, grantedBy)
    return res.type('text/markdown').send(doc)
  } catch (err) { return handleLifecycleError(err, res) }
})

// -- POST /holon/:iri/move -- moveHolon -----------------------------------------------
//
// Body: { newParentIri, actor: {iri, role?}, force?: boolean }
//
// Reparents :iri to newParentIri. Containment-role-aware (see lib/lifecycle.js):
// detects and preserves whichever predicate (e.g. geo:administrativePartOf)
// the existing link uses, rather than replacing it with a generic one.

router.post('/holon/:iri/move', async (req, res) => {
  try {
    const actor = requireActor(req.body)
    const { newParentIri, force } = req.body ?? {}
    if (!newParentIri || typeof newParentIri !== 'string')
      return res.status(400).json({ error: '"newParentIri" is required.' })
    const doc = await moveHolon(getLifecycleConn(req), req.params.iri, { newParentIri, actor, force })
    return res.type('text/markdown').send(doc)
  } catch (err) { return handleLifecycleError(err, res) }
})

// -- POST /holon/:iri/property -- proposeAgentPropertyUpdate ---------------------------
//
// Body: { property, delta, rationale, actor: {iri, role?}, capProperty?, floor? }
//
// Propose->validate->apply a delta to a numeric agent property (e.g.
// schema:healthPoints, schema:currentWealth). Validated against whatever
// SHACL shape governs that property BEFORE anything is written -- a
// rejected proposal (409) leaves no trace in either the holons or events
// graph. Writes a holon:ModelUpdateRequest + holon:ModelUpdateApprove pair
// to urn:{dataset}:events and the new value to urn:{dataset}:holons.
// Operates on the flat Adventure-Mode-style graphs, not the per-holon
// schema/scene/events triad the rest of this verb family assumes. Always
// requires Write on the dataset anchor (see getLifecycleConn(req) /
// POST /dataset-holon-iri) -- not self-authorisable even for one's own agent.

router.post('/holon/:iri/property', async (req, res) => {
  try {
    const actor = requireActor(req.body)
    const { property, delta, rationale, capProperty, floor } = req.body ?? {}
    if (!property || typeof property !== 'string')
      return res.status(400).json({ error: '"property" (full IRI) is required.' })
    if (typeof delta !== 'number' || !Number.isFinite(delta))
      return res.status(400).json({ error: '"delta" must be a finite number.' })
    if (!rationale || typeof rationale !== 'string')
      return res.status(400).json({ error: '"rationale" is required.' })
    const doc = await proposeAgentPropertyUpdate(getLifecycleConn(req), req.params.iri, {
      property, delta, rationale, actor, capProperty, floor
    })
    return res.type('text/markdown').send(doc)
  } catch (err) { return handleLifecycleError(err, res) }
})

// -- POST /holon/:iri/navigate -- navigateAgent -----------------------------------
//
// Body: { destinationIri, actor: {iri, role?}, note? }
//
// Moves an agent to a new holon, writing a holon:VisitEvent chained via
// holon:nextVisit from whatever VisitEvent is currently that agent's chain
// tail, then updates holon:currentLocation to match. :iri is the agentIri
// being moved (same convention as /holon/:iri/property, where :iri also
// names an agent rather than a generic containment-tree holon). Destination
// must already exist as a holon in holonsGraph -- rejects a dangling move.
// Self-service when actor.iri === :iri; Write on the dataset anchor
// required to move an agent other than the actor.

router.post('/holon/:iri/navigate', async (req, res) => {
  try {
    const actor = requireActor(req.body)
    const { destinationIri, note } = req.body ?? {}
    if (!destinationIri || typeof destinationIri !== 'string')
      return res.status(400).json({ error: '"destinationIri" is required.' })
    const doc = await navigateAgent(getLifecycleConn(req), req.params.iri, { destinationIri, actor, note })
    return res.type('text/markdown').send(doc)
  } catch (err) { return handleLifecycleError(err, res) }
})

// -- POST /agent -- createAgent ---------------------------------------------------
//
// Body: {
//   agentIri, label, agentKind, description?, extraTurtle?,
//   trackableProperties?: [{ property, value, capProperty?, capValue?, floor? }],
//   actor: {iri, role?}
// }
//
// Mints a new Agent holon with baseline values for its trackable properties,
// writing a holon:CreationEvent plus one holon:PropertyBaselineEvent per
// trackable property. Each property's governing shape/capProperty/floor is
// resolved from ontology metadata (holon:governedByShape/holon:capProperty/
// holon:floor) unless overridden in the request. A single baseline that
// violates its shape rejects the entire creation (409) -- no partial agent.
// Always requires Write on the dataset anchor (see getLifecycleConn(req) /
// POST /dataset-holon-iri).
//
// Separate from POST /holon (createRootHolon), which uses the older per-
// holon schema/scene/events graph triad -- this operates on the flat
// urn:{dataset}:holons/:events/:ontology graphs Adventure-Mode-style
// datasets actually use.

router.post('/agent', async (req, res) => {
  try {
    const actor = requireActor(req.body)
    const { agentIri, label, agentKind, description, extraTurtle, trackableProperties } = req.body ?? {}
    if (!agentIri || typeof agentIri !== 'string')
      return res.status(400).json({ error: '"agentIri" is required.' })
    if (!label || typeof label !== 'string')
      return res.status(400).json({ error: '"label" is required.' })
    if (!agentKind || typeof agentKind !== 'string')
      return res.status(400).json({ error: '"agentKind" is required.' })
    if (trackableProperties !== undefined && !Array.isArray(trackableProperties))
      return res.status(400).json({ error: '"trackableProperties" must be an array if provided.' })
    const doc = await createAgent(getLifecycleConn(req), {
      agentIri, label, agentKind, description, extraTurtle,
      trackableProperties: trackableProperties ?? [],
      actor
    })
    return res.type('text/markdown').send(doc)
  } catch (err) { return handleLifecycleError(err, res) }
})

// -- POST /group -- formGroup ---------------------------------------------------
//
// Body: { groupIri, label, memberIris: string[], activeMemberIri, actor: {iri, role?} }
//
// Creates a holon:Group -- a spatial/co-location carrier (tour party,
// vehicle passengers), distinct from an organizational Team/Corporation
// (capability/authority, modeled via RoleBinding). Forms at the active
// member's current location; every initial member's own currentLocation is
// removed in favor of the group's. Exactly one initial member must be
// active; the rest are forced inactive as part of joining. Self-service:
// no capability check when every entry in memberIris is the actor
// themselves; Write on the dataset anchor is required as soon as another
// agent is included.

router.post('/group', async (req, res) => {
  try {
    const actor = requireActor(req.body)
    const { groupIri, label, memberIris, activeMemberIri } = req.body ?? {}
    if (!groupIri || typeof groupIri !== 'string')
      return res.status(400).json({ error: '"groupIri" is required.' })
    if (!label || typeof label !== 'string')
      return res.status(400).json({ error: '"label" is required.' })
    if (!Array.isArray(memberIris) || memberIris.length === 0)
      return res.status(400).json({ error: '"memberIris" must be a non-empty array.' })
    if (!activeMemberIri || typeof activeMemberIri !== 'string')
      return res.status(400).json({ error: '"activeMemberIri" is required.' })
    const doc = await formGroup(getLifecycleConn(req), { groupIri, label, memberIris, activeMemberIri, actor })
    return res.type('text/markdown').send(doc)
  } catch (err) { return handleLifecycleError(err, res) }
})

// -- POST /group/:iri/join -- joinGroup ------------------------------------------
//
// Body: { memberIri, actor: {iri, role?} }
//
// Adds a member to an existing group. The member's own currentLocation is
// removed; they default to isActive false. Self-service when
// actor.iri === memberIri; Write on the dataset anchor required otherwise.

router.post('/group/:iri/join', async (req, res) => {
  try {
    const actor = requireActor(req.body)
    const { memberIri } = req.body ?? {}
    if (!memberIri || typeof memberIri !== 'string')
      return res.status(400).json({ error: '"memberIri" is required.' })
    const doc = await joinGroup(getLifecycleConn(req), req.params.iri, memberIri, { actor })
    return res.type('text/markdown').send(doc)
  } catch (err) { return handleLifecycleError(err, res) }
})

// -- POST /group/:iri/leave -- leaveGroup ----------------------------------------
//
// Body: { memberIri, actor: {iri, role?}, handoffTo?: string }
//
// Removes a member, restoring their own currentLocation (copied from the
// group's). If the leaving member is active and others remain, handoffTo
// is required. Auto-dissolves (tombstones) the group once membership drops
// to one, restoring that sole member's independent currentLocation.
// Self-service when actor.iri === memberIri; Write on the dataset anchor
// required otherwise.

router.post('/group/:iri/leave', async (req, res) => {
  try {
    const actor = requireActor(req.body)
    const { memberIri, handoffTo } = req.body ?? {}
    if (!memberIri || typeof memberIri !== 'string')
      return res.status(400).json({ error: '"memberIri" is required.' })
    const doc = await leaveGroup(getLifecycleConn(req), req.params.iri, memberIri, { actor, handoffTo })
    return res.type('text/markdown').send(doc)
  } catch (err) { return handleLifecycleError(err, res) }
})

// -- end lifecycle verbs -----------------------------------------------------------

  return router
}
