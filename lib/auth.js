/**
 * lib/auth.js
 *
 * Bearer token authentication middleware for HolonBridge.
 *
 * Usage in server.js:
 *   import { requireAuth } from './lib/auth.js'
 *   app.use(requireAuth)
 *
 * Configuration:
 *   BEARER_TOKEN  (env)  — required in production; generate with:
 *                          openssl rand -hex 32
 *
 * Behaviour:
 *   - GET /health is always public (monitoring probes need no token)
 *   - If BEARER_TOKEN is unset, logs a warning and passes all requests through
 *     (dev/loopback mode only — never deploy to a public URL without a token)
 *   - All other routes require: Authorization: Bearer <token>
 *   - Returns 401 JSON on failure; never leaks the expected token value
 */

const BEARER_TOKEN = process.env.BEARER_TOKEN?.trim()

if (!BEARER_TOKEN) {
  console.warn(
    '[Bridge] WARNING: BEARER_TOKEN not set — all endpoints are unauthenticated. ' +
    'Set BEARER_TOKEN in .env and restart before exposing to any network.'
  )
}

/**
 * Express middleware.  Attach with: app.use(requireAuth)
 * Must be registered AFTER the CORS middleware so that OPTIONS preflight
 * requests are handled before auth fires.
 */
export function requireAuth(req, res, next) {
  // Always allow health probes — monitoring infrastructure should not need auth
  if (req.path === '/health') return next()

  // Dev mode: no token configured — pass through with a warning already logged
  if (!BEARER_TOKEN) return next()

  const header = req.headers['authorization'] ?? ''
  const token  = header.startsWith('Bearer ') ? header.slice(7).trim() : ''

  if (token !== BEARER_TOKEN)
    return res.status(401).json({ error: 'Unauthorized — bad or missing Bearer token' })

  next()
}

export { BEARER_TOKEN }
