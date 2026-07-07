/**
 * clear-holarchy.js -- TEST-ONLY recursive holarchy wipe
 *
 * Not part of the P1-P4 tool surface. Never imported by lib/lifecycle.js or
 * exposed as an MCP tool. No holon:*Command type -- this generates no event
 * and is not part of the CommandEvent pipeline.
 *
 * Recursively deletes a holon and every descendant reachable via
 * holon:parentHolon: schema/scene/event named graphs and registry records.
 * Bypasses tombstone status entirely -- this is a hard, unconditional
 * delete, unlike deleteHolon() (tombstone) or purgeHolon() (GC on an
 * already-tombstoned holon).
 *
 * Double-gated:
 *   1. opts.confirm === true          -- catches fat-fingering the call
 *   2. env ALLOW_HOLARCHY_WIPE === '1' -- catches running in the wrong
 *      context entirely. Deliberately a dedicated var rather than reusing
 *      NODE_ENV, since NODE_ENV is used for unrelated purposes (build
 *      optimisation, logging) and could be flipped for a reason that has
 *      nothing to do with willingness to destroy data.
 *
 * CLI-only exposure by design (bin/holon test:clear-holarchy). Never wire
 * this into an MCP tool -- an agent conversation should not be able to
 * invoke it via ambiguous phrasing.
 */

import { runQuery } from '../lib/sparql.js'

const HOLON_NS = 'https://w3id.org/holon/'

function graphsFor(holonIri) {
  return {
    schema: `${holonIri}/schema`,
    scene: `${holonIri}/scene`,
    events: `${holonIri}/events`
  }
}

async function findAllDescendants(sparqlEndpoint, rootHolonIri) {
  const query = `
    PREFIX holon: <${HOLON_NS}>
    SELECT ?child WHERE {
      ?child holon:parentHolon+ <${rootHolonIri}> .
    }`
  const { bindings } = await runQuery(sparqlEndpoint, query)
  return bindings.map(b => b.child.value)
}

/**
 * @param {{sparqlEndpoint: string, gspEndpoint: string}} conn
 * @param {string} rootHolonIri
 * @param {{confirm: true, dryRun?: boolean}} opts
 * @returns {Promise<{deletedGraphs: string[], deletedRegistryEntries: string[]}>}
 */
export async function clearHolarchy(conn, rootHolonIri, opts) {
  if (opts?.confirm !== true) {
    throw new Error('clearHolarchy requires explicit { confirm: true }')
  }
  if (process.env.ALLOW_HOLARCHY_WIPE !== '1') {
    throw new Error(
      'clearHolarchy refused -- set ALLOW_HOLARCHY_WIPE=1 in the environment ' +
      'to enable this test-only operation. This is deliberately not tied to ' +
      'NODE_ENV.'
    )
  }

  const descendants = await findAllDescendants(conn.sparqlEndpoint, rootHolonIri)
  const targets = [rootHolonIri, ...descendants]
  const graphList = targets.flatMap(iri => Object.values(graphsFor(iri)))

  console.warn(`[clearHolarchy] ${opts.dryRun ? 'DRY RUN -- ' : ''}wiping ${targets.length} holon(s): ${targets.join(', ')}`)

  if (opts.dryRun) {
    return { deletedGraphs: graphList, deletedRegistryEntries: targets }
  }

  for (const g of graphList) {
    await fetch(`${conn.gspEndpoint}?graph=${encodeURIComponent(g)}`, { method: 'DELETE' }).catch(() => {})
  }

  for (const holonIri of targets) {
    const deleteQuery = `DELETE WHERE { <${holonIri}> ?p ?o }`
    await fetch(conn.sparqlEndpoint.replace('/query', '/update'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/sparql-update' },
      body: deleteQuery
    }).catch(() => {})
  }

  console.warn(`[clearHolarchy] Wiped ${targets.length} holon(s), ${graphList.length} graph(s)`)
  return { deletedGraphs: graphList, deletedRegistryEntries: targets }
}
