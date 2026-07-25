/**
 * http.js -- fetch with a timeout, in one place
 *
 * server.js hand-rolls the same AbortController + setTimeout + try/finally
 * dance more than a dozen times, with timeouts of 4s, 10s, 30s and 60s chosen
 * per call site and no way to change any of them without editing code. This
 * collapses that to one helper and gives the timeouts names.
 *
 * Two things the inline version kept getting slightly differently, both fixed
 * here once rather than at each call site:
 *
 *   1. AbortError surfaces as the generic message "This operation was aborted",
 *      which then reaches the caller as an opaque 500 unless the route happens
 *      to check err.name -- several do, several don't. fetchWithTimeout throws
 *      a TimeoutError carrying the url and the budget that was exceeded, so a
 *      route can render a 504 with something actionable in it.
 *
 *   2. The timer must be cleared on the success path too, or a 60s request
 *      timeout keeps the event loop alive for 60s after the response has
 *      already been handled. The try/finally below is what guarantees that.
 */

/**
 * Named timeout budgets. Overridable per deployment via env vars rather than
 * being edited in code -- the previous values were effectively hard-coded
 * constants scattered across route handlers.
 *
 * PING     -- liveness probes; should fail fast, the caller may be mid-tunnel-setup
 * CONTROL  -- small admin writes (registry updates, graph ops)
 * QUERY    -- ordinary SELECT/CONSTRUCT/GSP traffic
 * LONG     -- rule CONSTRUCTs, which can legitimately take a while
 */
export const TIMEOUTS = {
  PING:    parseInt(process.env.HTTP_TIMEOUT_PING    ?? '4000',  10),
  CONTROL: parseInt(process.env.HTTP_TIMEOUT_CONTROL ?? '10000', 10),
  QUERY:   parseInt(process.env.HTTP_TIMEOUT_QUERY   ?? '30000', 10),
  LONG:    parseInt(process.env.HTTP_TIMEOUT_LONG    ?? '60000', 10)
}

/** Thrown when a request exceeds its budget. Check `err instanceof TimeoutError`. */
export class TimeoutError extends Error {
  constructor(url, timeoutMs) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`)
    this.name      = 'TimeoutError'
    this.url       = url
    this.timeoutMs = timeoutMs
  }
}

/**
 * fetch() with an enforced timeout.
 *
 * @param {string} url
 * @param {RequestInit & {timeoutMs?: number}} [init]
 *        timeoutMs defaults to TIMEOUTS.QUERY. An explicit `signal` is
 *        respected: aborting it aborts the request, and the timeout still
 *        applies independently.
 * @returns {Promise<Response>}
 * @throws {TimeoutError} when the budget is exceeded
 */
export async function fetchWithTimeout(url, init = {}) {
  const { timeoutMs = TIMEOUTS.QUERY, signal: callerSignal, ...rest } = init

  const controller = new AbortController()
  const onAbort    = () => controller.abort()
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort()
    else callerSignal.addEventListener('abort', onAbort, { once: true })
  }

  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)

  try {
    return await fetch(url, { ...rest, signal: controller.signal })
  } catch (err) {
    // Distinguish "we gave up" from "the caller cancelled" -- both arrive as
    // AbortError, and only the first is a 504.
    if (timedOut) throw new TimeoutError(url, timeoutMs)
    throw err
  } finally {
    clearTimeout(timer)
    if (callerSignal) callerSignal.removeEventListener('abort', onAbort)
  }
}

/**
 * fetchWithTimeout + read the body as text, raising a single error that carries
 * both status and a truncated body.
 *
 * The inline pattern this replaces is: fetch, await .text(), check .ok, build a
 * message with body.slice(0, 200) or .slice(0, 300) depending on the call site.
 * Same shape everywhere now.
 *
 * @param {string} url
 * @param {RequestInit & {timeoutMs?: number, errorBodyChars?: number}} [init]
 * @returns {Promise<{status: number, body: string}>}
 * @throws {Error} on a non-2xx response, with `.status` and `.body` attached
 */
export async function fetchText(url, init = {}) {
  const { errorBodyChars = 300, ...rest } = init
  const response = await fetchWithTimeout(url, rest)
  const body     = await response.text()

  if (!response.ok) {
    const err = new Error(`${url} returned HTTP ${response.status}: ${body.slice(0, errorBodyChars)}`)
    err.status = response.status
    err.body   = body
    throw err
  }

  return { status: response.status, body }
}
