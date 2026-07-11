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

/**
 * Express middleware: wraps every HTTP request end-to-end with the same
 * Process Started/Ended log pair used by timedProcess, sharing the same
 * sequence counter so request-level and Jena/LLM-level blocks read as one
 * chronological log rather than two separate numbering schemes.
 *
 * This is the piece that actually answers "where is the latency coming
 * from": total request duration here, minus the sum of whatever Jena
 * SELECT/CONSTRUCT/UPDATE/GSP and LLM builder/interpreter blocks fired
 * during that same request, is time spent somewhere this bridge doesn't
 * control -- network round-trip to the client, the MCP remote SSE relay,
 * client-side bandwidth (e.g. contention from screen-sharing on a call).
 * If the request-level duration is close to the sum of its inner blocks,
 * the bridge itself is the bottleneck; if there's a large gap, it isn't.
 *
 * Mount as early as possible (right after CORS headers, before auth/MCP
 * compatibility middleware) so the timer covers as much of the request
 * lifecycle as this process actually sees.
 *
 * Usage: app.use(requestTimingMiddleware())
 */
export function requestTimingMiddleware() {
  return (req, res, next) => {
    const id = ++_seq
    const startedAt = Date.now()
    const label = `HTTP ${req.method} ${req.path}`
    console.log(`[PROCESS ${id}] Started: ${label}`)
    res.on('finish', () => {
      const ms = Date.now() - startedAt
      console.log(`[PROCESS ${id}] Ended: ${label}  (${ms}ms, HTTP ${res.statusCode})`)
    })
    next()
  }
}
