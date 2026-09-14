/**
 * verify-root-bootstrap.js -- TEST-ONLY live verification for issue #8
 *
 * Runs Ben Wortley's exact repro (issue #8) against a live HolonBridge/
 * Fuseki instance: createRootHolon() followed immediately by addSchema(),
 * with NO designateAgent() call in between. Before the #8 fix this failed
 * at the second step with UnauthorisedError ("lacks capability Write");
 * after the fix (commit befe6748) it should succeed, because
 * createRootHolon() now self-grants actor an Owner RoleBinding on the new
 * root as part of creation.
 *
 * Not part of the eighteen-verb surface, never registered as an MCP tool,
 * no holon:*Command type of its own -- it only calls the real verbs and
 * checks their outcome, the same relationship clear-holarchy.js has to
 * the verbs it cleans up after. Lives in test-utils/, same directory
 * boundary as clear-holarchy.js, so it can never be imported by
 * production code paths by accident.
 *
 * No automated test framework exists for lib/lifecycle.js -- verification
 * has always been by running against a live Fuseki instance, the same way
 * Ben's original repro was run. This formalises that repro into a reusable
 * script instead of a one-off curl sequence, so it can be re-run whenever
 * the ACL path changes.
 *
 * Verifies three things, in order -- the repro exactly, plus one step
 * beyond it (confirming the bootstrap Owner binding is real and not just
 * "no error was thrown"):
 *   1. createRootHolon() succeeds and its returned DataBook contains the
 *      owner-binding block the #8 fix added.
 *   2. addSchema() on the same holon succeeds with NO designateAgent()
 *      call in between -- this is the exact step issue #8 reported as
 *      failing.
 *   3. resolveCapabilities() independently confirms actor holds Owner
 *      (and therefore Grant/Promote/Write/Read, per CAPABILITY_IMPLIES)
 *      on baseIri -- so a later designateAgent() delegation from this
 *      actor would also work, not just this one addSchema call.
 *
 * Does not clean up after itself -- the default baseIri is a fresh
 * urn:holon:test: IRI each run, so repeat runs never collide, but the
 * registry triples and graphs it creates are left behind. Run
 * test-utils/clear-holarchy.js separately (via `holon test:clear-holarchy
 * --root <baseIri> --confirm`) if you want them removed afterward.
 */

import { createRootHolon, addSchema, resolveCapabilities } from '../lib/lifecycle.js'

const DEFAULT_SCHEMA_MARKDOWN = `---
id: verify-root-bootstrap-schema
---

<!-- databook:id: shape -->
\`\`\`turtle
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix ex: <urn:holon:test:verify-root-bootstrap#> .

ex:PlaceholderShape a sh:NodeShape ;
    sh:targetClass ex:Placeholder .
\`\`\`
`

/**
 * @param {{sparqlEndpoint: string, gspEndpoint: string}} conn
 * @param {{baseIri?: string, actorIri?: string, label?: string}} [opts]
 * @returns {Promise<{
 *   baseIri: string,
 *   actorIri: string,
 *   steps: {name: string, ok: boolean, detail: string}[],
 *   passed: boolean
 * }>}
 */
export async function verifyRootBootstrap(conn, opts = {}) {
  const baseIri = opts.baseIri ?? `urn:holon:test:verify-root-bootstrap-${crypto.randomUUID()}`
  const actorIri = opts.actorIri ?? 'urn:test:verify-root-bootstrap-actor'
  const label = opts.label ?? 'Root Bootstrap Verification (issue #8)'
  const actor = { iri: actorIri }
  const steps = []

  // Step 1 -- createRootHolon(), same as the repro's first call. Before
  // #8 this always succeeded on its own; what's new is checking that the
  // returned DataBook now also carries the owner-binding block.
  let rootDataBook
  try {
    rootDataBook = await createRootHolon(conn, { baseIri, label, actor })
    const hasOwnerBinding = rootDataBook.includes('owner-binding')
    steps.push({
      name: 'createRootHolon',
      ok: hasOwnerBinding,
      detail: hasOwnerBinding
        ? 'succeeded, DataBook includes an owner-binding block'
        : 'succeeded but no owner-binding block found -- the #8 fix may be missing or reverted'
    })
  } catch (err) {
    steps.push({ name: 'createRootHolon', ok: false, detail: `threw: ${err.message}` })
    return { baseIri, actorIri, steps, passed: false }
  }

  // Step 2 -- addSchema() immediately, with NO designateAgent() call in
  // between. This is the exact step issue #8 reported as failing with
  // UnauthorisedError ("lacks capability Write").
  try {
    await addSchema(conn, baseIri, { markdown: DEFAULT_SCHEMA_MARKDOWN }, actor)
    steps.push({
      name: 'addSchema (no designateAgent call)',
      ok: true,
      detail: 'succeeded -- issue #8 does not reproduce'
    })
  } catch (err) {
    steps.push({
      name: 'addSchema (no designateAgent call)',
      ok: false,
      detail: `threw: ${err.message} -- this is issue #8 reproducing`
    })
    return { baseIri, actorIri, steps, passed: false }
  }

  // Step 3 -- independently confirm actor holds Owner via the same
  // resolveCapabilities() authorise() itself calls, rather than trusting
  // "step 2 didn't throw" alone. Owner implies Grant/Promote/Write/Read
  // (CAPABILITY_IMPLIES), so this also confirms a later designateAgent()
  // delegation from this actor would succeed.
  const held = await resolveCapabilities(conn.sparqlEndpoint, baseIri, actorIri)
  const holdsOwner = held.has('Owner')
  steps.push({
    name: 'resolveCapabilities confirms Owner',
    ok: holdsOwner,
    detail: holdsOwner
      ? `actor holds: ${[...held].sort().join(', ')}`
      : `actor holds: ${[...held].sort().join(', ') || '(none)'} -- expected Owner`
  })

  const passed = steps.every(s => s.ok)
  return { baseIri, actorIri, steps, passed }
}
