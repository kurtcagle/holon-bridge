/**
 * sequence.js -- Dataset-scoped sequence-ID minting
 *
 * Implements the hev:SequenceCounter / hev:sequenceId pattern designed
 * 2026-07-19 for the Bridgerton dataset (day-one invariant "minted
 * sequence numbers" from the RQB Annex's graph-first-for-pilots
 * discussion) and generalised here so any dataset can use it.
 *
 * Identifier shape: {PUBLIC_BASE_URL}/counter/{dataset}/id-{n}
 *   e.g. https://kurtcagle-mcp.ngrok.io/counter/bridgerton/id-25
 * The domain names the issuing bridge; the dataset path segment names
 * the scope; '/id-' marks where the parsable number starts. See the
 * hev:sequenceId comment in urn:data:ontology for the full reasoning --
 * the scope is encoded in the identifier itself so that if minting is
 * later promoted from per-dataset to per-bridge or network-wide, prior
 * IDs remain unambiguous and never collide.
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
 */

import { runQuery, runUpdate } from './sparql.js'

const HEV_NS = 'https://w3id.org/holon/event/'

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
 * @param {string} [opts.publicBaseUrl]  Overrides PUBLIC_BASE_URL env var for this call
 * @returns {Promise<{ value: number, sequenceId: string }>}
 */
export async function mintSequenceId(opts) {
  const {
    sparqlEndpoint, updateEndpoint, dataset, graphIri, counterIri,
    publicBaseUrl = process.env.PUBLIC_BASE_URL ?? 'https://kurtcagle-mcp.ngrok.io'
  } = opts

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

    const sequenceId = `${publicBaseUrl.replace(/\/+$/, '')}/counter/${encodeURIComponent(dataset)}/id-${value}`
    return { value, sequenceId }
  })
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
