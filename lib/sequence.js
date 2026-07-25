/**
 * sequence.js -- Dataset-scoped sequence-ID minting
 *
 * Implements the hev:SequenceCounter / hev:sequenceId pattern designed
 * 2026-07-19 for the Bridgerton dataset (day-one invariant "minted
 * sequence numbers" from the RQB Annex's graph-first-for-pilots
 * discussion) and generalised here so any dataset can use it.
 *
 * Identifier shape (since 2026-07-24), when a class is supplied:
 *   {PUBLIC_BASE_URL}/counter/{dataset}/{ClassLocalName}/{n}
 *   e.g. https://kurtcagle-mcp.ngrok.io/counter/bridgerton/StateAssertion/26
 *
 * Identifier shape when no class is supplied (the original form, still
 * emitted so existing callers are untouched):
 *   {PUBLIC_BASE_URL}/counter/{dataset}/id-{n}
 *   e.g. https://kurtcagle-mcp.ngrok.io/counter/bridgerton/id-25
 *
 * The domain names the issuing bridge; the dataset path segment names
 * the scope; the class segment (or '/id-') marks where the parsable
 * number starts. See the hev:sequenceId comment in urn:data:ontology
 * for the full reasoning -- the scope is encoded in the identifier
 * itself so that if minting is later promoted from per-dataset to
 * per-bridge or network-wide, prior IDs remain unambiguous and never
 * collide.
 *
 * -- Why the class is a LABEL and not a SHARD --
 *
 * The class segment names what was minted; it does NOT select a separate
 * counter. There is still exactly one hev:SequenceCounter per dataset and
 * the numbers it issues are globally monotonic across all classes:
 *
 *   .../counter/bridgerton/StateAssertion/26
 *   .../counter/bridgerton/Person/27
 *   .../counter/bridgerton/StateAssertion/31
 *
 * The whole point of hev:sequenceId in an event graph is a TOTAL ORDER
 * over assertions. Sharding the counter per class would buy denser
 * numbers at the cost of that order -- you could no longer tell whether
 * StateAssertion/5 was minted before or after Person/3, and recovering
 * that would mean falling back to wall-clock timestamps, which are
 * exactly what a monotonic counter exists to avoid depending on.
 *
 * The gaps within a class are therefore not a defect. A gap is evidence
 * that something else was minted in between, which is information.
 *
 * A path segment is used rather than a hyphenated token ('StateAssertion-26')
 * so that {base}/counter/{dataset}/{Class} is itself a meaningful collection
 * resource, and {base}/counter/{dataset} remains the counter. Hyphens make
 * the class part of an opaque string; segments keep it navigable, which suits
 * a REST-first bridge.
 *
 * -- On graph patterns --
 *
 * All graph patterns here use GRAPH <iri> { } explicitly, never a bare
 * triple pattern -- this Fuseki configuration has no union default
 * graph (confirmed empirically 2026-07-19 while building the shapes
 * this counter supports), so an unwrapped pattern silently matches
 * nothing rather than erroring, which is a much worse failure mode
 * than a query that simply fails loudly.
 *
 * -- On atomicity --
 *
 * A single SPARQL UPDATE combining DELETE/INSERT/WHERE in one request is
 * genuinely atomic against ALL concurrent writers, from any process,
 * because Jena TDB2 is multiple-readers-or-single-writer: an UPDATE
 * request holds the write lock for its entire duration, so no other
 * UPDATE can interleave with it. The WHERE clause reads whatever value
 * is current AT COMMIT TIME, not at request-send time, so the increment
 * itself can never be lost or double-applied no matter how many bridge
 * processes send requests concurrently.
 *
 * What TDB2's guarantee does NOT cover is reporting the correct newly-
 * minted number back to the caller that produced it. Fuseki's UPDATE
 * endpoint returns only success/failure, not bound values -- so getting
 * "the number I just minted" back to the HTTP caller needs a SEPARATE
 * SELECT after the UPDATE, and between that UPDATE and that SELECT
 * another process's mint could run, causing this caller's SELECT to
 * read a value higher than the one its own increment actually produced.
 * The underlying counter is still perfectly correct in that case (every
 * mint gets a distinct, correctly ordered number) -- but two different
 * HTTP callers could both be told "id-7" for what were actually two
 * different mints.
 *
 * The per-dataset mutex below closes that gap for the scope actually
 * decided (2026-07-19): one HolonBridge process per dataset. It
 * serialises this process's own UPDATE+SELECT pairs so no other mint
 * request FROM THIS PROCESS can interleave between them. It does NOT
 * protect against a second, independent HolonBridge process minting
 * against the same Fuseki dataset concurrently -- that's the "per-
 * HolonBridge" and "network-wide" scopes Kurt named as deliberately
 * out of scope for now. Promoting to either later needs the mutex
 * promoted too: a cross-process lock (e.g. against the admin dataset)
 * for per-bridge scope, or a dedicated sequencer service for network-
 * wide scope. Both are real infrastructure, not a config flag -- flagged
 * here rather than silently assumed away, same discipline as this
 * codebase's other KNOWN GAP comments (see lib/scheduler.js).
 *
 * -- KNOWN GAP: endpoint pass-through --
 *
 * mintSequenceId() accepts opts.entityClass as of 2026-07-24, but the
 * HTTP mint route in server.js does not yet read a class from the
 * request and forward it here. Until it does, HTTP callers keep getting
 * the legacy /id-{n} form; direct in-process callers (lib/lifecycle.js
 * and friends) can adopt the class form immediately by passing
 * entityClass. Wiring the route is a small pass-through, deliberately
 * left to a separate change rather than folded into this one.
 */

import { runQuery, runUpdate } from './sparql.js'

const HEV_NS = 'https://w3id.org/holon/event/'

/**
 * A class segment must be safe to drop into a path unescaped, and must
 * look like an RDF local name so that a reader can map the segment back
 * to a class without guessing. Anything else is rejected loudly rather
 * than silently percent-encoded, which would produce IDs that are stable
 * but unreadable -- defeating the point of putting the class there.
 */
const CLASS_SEGMENT_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/

/**
 * Reduce a class reference to its local name.
 *
 * Accepts a full IRI ('https://w3id.org/holon/event/StateAssertion'), a
 * CURIE ('hev:StateAssertion'), or an already-bare local name
 * ('StateAssertion'). Hash and slash are checked before colon so that
 * the scheme separator in an IRI is never mistaken for a CURIE prefix
 * separator.
 *
 * @param {string} entityClass
 * @returns {string} the local name, validated as a path segment
 * @throws {Error} if the local name would not be a safe, readable segment
 */
export function classSegment(entityClass) {
  if (typeof entityClass !== 'string' || entityClass.trim() === '')
    throw new Error('entityClass must be a non-empty string (full IRI, CURIE, or bare local name)')

  const raw = entityClass.trim()
  let local

  const lastHash  = raw.lastIndexOf('#')
  const lastSlash = raw.lastIndexOf('/')
  const lastColon = raw.lastIndexOf(':')

  if (lastHash >= 0 || lastSlash >= 0)      local = raw.slice(Math.max(lastHash, lastSlash) + 1)
  else if (lastColon >= 0)                  local = raw.slice(lastColon + 1)
  else                                      local = raw

  if (!CLASS_SEGMENT_RE.test(local))
    throw new Error(`entityClass '${entityClass}' reduces to local name '${local}', which is not a usable path segment -- expected an RDF local name matching ${CLASS_SEGMENT_RE}`)

  return local
}

/**
 * Parse a minted sequence ID back into its parts.
 *
 * Reads BOTH shapes: the class form minted since 2026-07-24 and the
 * legacy '/id-{n}' form. Legacy IDs are deliberately never rewritten --
 * they are opaque, still unique, and still correctly ordered, and
 * editing them would mean editing history in a graph whose whole
 * proposition is that history is immutable.
 *
 * @param {string} sequenceId
 * @returns {{ dataset: string, entityClass: string|null, value: number }|null}
 *          null if the IRI is not a recognisable minted sequence ID
 */
export function parseSequenceId(sequenceId) {
  if (typeof sequenceId !== 'string') return null

  const legacy = sequenceId.match(/\/counter\/([^/]+)\/id-(\d+)$/)
  if (legacy) return {
    dataset:     decodeURIComponent(legacy[1]),
    entityClass: null,
    value:       parseInt(legacy[2], 10)
  }

  const classed = sequenceId.match(/\/counter\/([^/]+)\/([^/]+)\/(\d+)$/)
  if (classed) return {
    dataset:     decodeURIComponent(classed[1]),
    entityClass: classed[2],
    value:       parseInt(classed[3], 10)
  }

  return null
}

/**
 * Ensure a dataset's hev:SequenceCounter exists, seeding it at 0 if absent.
 * Idempotent -- safe to call on every mint.
 */
async function ensureCounter(sparqlEndpoint, updateEndpoint, graphIri, counterIri) {
  const { bindings } = await runQuery(sparqlEndpoint, `
PREFIX hev: <${HEV_NS}>
SELECT ?v WHERE { GRAPH <${graphIri}> { <${counterIri}> hev:currentSequenceValue ?v } }
`.trim())

  if (bindings.length > 0) return   // already seeded

  await runUpdate(sparqlEndpoint, `
PREFIX hev: <${HEV_NS}>
INSERT DATA {
  GRAPH <${graphIri}> {
    <${counterIri}> a hev:SequenceCounter ;
      hev:currentSequenceValue 0 .
  }
}
`.trim(), { updateEndpoint })
}

/**
 * Atomically mint the next sequence ID for a dataset.
 *
 * @param {object} opts
 * @param {string} opts.sparqlEndpoint   Query endpoint for the target dataset
 * @param {string} opts.updateEndpoint   Update endpoint for the target dataset
 * @param {string} opts.dataset          Dataset name -- the scope, and the mutex key
 * @param {string} opts.graphIri         Named graph the counter holon lives in
 * @param {string} opts.counterIri       Full IRI of the hev:SequenceCounter individual
 * @param {string} [opts.entityClass]    Class of the thing being minted, as a full IRI,
 *                                       CURIE, or bare local name. When given, the local
 *                                       name becomes a path segment in the returned ID.
 *                                       When omitted, the legacy '/id-{n}' form is used.
 *                                       This does NOT select a separate counter -- see
 *                                       the module docstring.
 * @param {string} [opts.publicBaseUrl]  Overrides PUBLIC_BASE_URL env var for this call
 * @returns {Promise<{ value: number, sequenceId: string, entityClass: string|null }>}
 */
export async function mintSequenceId(opts) {
  const {
    sparqlEndpoint, updateEndpoint, dataset, graphIri, counterIri, entityClass,
    publicBaseUrl = process.env.PUBLIC_BASE_URL ?? 'https://kurtcagle-mcp.ngrok.io'
  } = opts

  // Validate the class BEFORE taking the lock and touching the counter. A bad
  // class must not burn a sequence number -- a gap caused by a caller typo is
  // indistinguishable, after the fact, from a gap caused by a real concurrent
  // mint, and the whole value of this counter rests on gaps being meaningful.
  const segment = entityClass === undefined || entityClass === null
    ? null
    : classSegment(entityClass)

  return withDatasetLock(dataset, async () => {
    await ensureCounter(sparqlEndpoint, updateEndpoint, graphIri, counterIri)

    // The atomic increment. Single UPDATE, DELETE+INSERT+WHERE together --
    // see the module docstring for why this alone is race-free against
    // ANY concurrent writer, in-process or not.
    await runUpdate(sparqlEndpoint, `
PREFIX hev: <${HEV_NS}>
DELETE { GRAPH <${graphIri}> { <${counterIri}> hev:currentSequenceValue ?old } }
INSERT { GRAPH <${graphIri}> { <${counterIri}> hev:currentSequenceValue ?new } }
WHERE {
  GRAPH <${graphIri}> { <${counterIri}> hev:currentSequenceValue ?old }
  BIND(?old + 1 AS ?new)
}
`.trim(), { updateEndpoint })

    // Read back the value THIS call's own increment produced. Race-free
    // against other mints from THIS process only, by construction of the
    // mutex above -- see the module docstring's atomicity note for the
    // cross-process caveat.
    const { bindings } = await runQuery(sparqlEndpoint, `
PREFIX hev: <${HEV_NS}>
SELECT ?v WHERE { GRAPH <${graphIri}> { <${counterIri}> hev:currentSequenceValue ?v } }
`.trim())

    const value = parseInt(bindings[0]?.v?.value ?? '', 10)
    if (!Number.isFinite(value))
      throw new Error(`Sequence counter <${counterIri}> read back a non-numeric value after mint -- check for a concurrent non-atomic writer touching this counter directly (e.g. a hand-run SPARQL UPDATE outside this module).`)

    const base = `${publicBaseUrl.replace(/\/+$/, '')}/counter/${encodeURIComponent(dataset)}`
    const sequenceId = segment === null
      ? `${base}/id-${value}`
      : `${base}/${segment}/${value}`

    return { value, sequenceId, entityClass: segment }
  })
}

/** One mutex chain per dataset -- see the atomicity note above. */
const mintLocks = new Map()

function withDatasetLock(dataset, fn) {
  const prior = mintLocks.get(dataset) ?? Promise.resolve()
  const next  = prior.then(fn, fn)   // run fn regardless of prior's outcome
  // Chain-bookkeeping only -- swallows rejection so the lock never wedges
  // permanently after a failed mint. The real result/error for THIS call
  // still comes from `next`, returned below, untouched by this catch.
  mintLocks.set(dataset, next.catch(() => {}))
  return next
}

/**
 * Read a dataset's current counter value without minting.
 *
 * @param {object} opts
 * @param {string} opts.sparqlEndpoint
 * @param {string} opts.graphIri
 * @param {string} opts.counterIri
 * @returns {Promise<number|null>}  null if the counter doesn't exist yet
 */
export async function readSequenceValue({ sparqlEndpoint, graphIri, counterIri }) {
  const { bindings } = await runQuery(sparqlEndpoint, `
PREFIX hev: <${HEV_NS}>
SELECT ?v WHERE { GRAPH <${graphIri}> { <${counterIri}> hev:currentSequenceValue ?v } }
`.trim())
  if (bindings.length === 0) return null
  const value = parseInt(bindings[0]?.v?.value ?? '', 10)
  return Number.isFinite(value) ? value : null
}
