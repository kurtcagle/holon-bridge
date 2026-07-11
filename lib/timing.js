/**
 * timing.js -- Process Started/Ended log instrumentation
 *
 * Wraps a labelled async operation with matching "Process Started" /
 * "Process Ended" console log lines, so the two dominant contributors to
 * perceived latency -- Jena query/update time and LLM call time -- can be
 * read directly out of server logs and separated from everything else
 * (network round-trip to the client, MCP remote SSE relay, client-side
 * bandwidth) that happens outside these blocks. If total observed lag is
 * much larger than the sum of PROCESS blocks in a request, the gap is
 * latency/transport, not Jena or LLM processing -- which is exactly the
 * Google-Meet-bandwidth case this was written for.
 *
 * Convention: every block gets a short one-line description of what's
 * being initiated, plus a duration on the closing line. Nesting is fine --
 * each call gets its own start/end pair with its own sequence number, so a
 * SPARQL call made from inside an LLM retry loop still shows up as its own
 * bounded interval rather than being folded into the outer one.
 */

let _seq = 0

/**
 * Wrap an async operation with Process Started / Process Ended log lines.
 *
 * @param {string} label         Short description of what's being initiated,
 *                                e.g. "SPARQL SELECT (urn:data:holons)" or
 *                                "LLM builder call (claude-sonnet-4-6)"
 * @param {() => Promise<T>} fn  The operation to time
 * @returns {Promise<T>}
 */
export async function timedProcess(label, fn) {
  const id = ++_seq
  const startedAt = Date.now()
  console.log(`[PROCESS ${id}] Started: ${label}`)
  try {
    const result = await fn()
    const ms = Date.now() - startedAt
    console.log(`[PROCESS ${id}] Ended: ${label}  (${ms}ms)`)
    return result
  } catch (err) {
    const ms = Date.now() - startedAt
    console.log(`[PROCESS ${id}] Ended: ${label}  (${ms}ms, FAILED: ${err.message})`)
    throw err
  }
}
