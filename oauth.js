/**
 * oauth.js — OAuth2 Client Credentials shim for HolonBridge
 * ES Module version (server.js uses ESM imports)
 *
 * Provides a minimal OAuth2 client_credentials grant endpoint so that
 * claude.ai connectors (which expect OAuth Client ID + Secret) can
 * authenticate against the static BEARER_TOKEN.
 *
 * Flow:
 *   1. claude.ai POSTs to /oauth/token with client_id + client_secret
 *   2. This module validates against OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET
 *   3. Returns { access_token: BEARER_TOKEN, token_type: "Bearer", expires_in: 3600 }
 *   4. claude.ai uses that access_token as Bearer on all subsequent SSE/message calls
 *
 * Usage in server.js (before requireAuth middleware):
 *   import registerOAuth from './oauth.js'
 *   registerOAuth(app)
 *
 * Required .env additions:
 *   OAUTH_CLIENT_ID=holonbridge-claude
 *   OAUTH_CLIENT_SECRET=<new strong secret — different from BEARER_TOKEN>
 *
 * claude.ai connector settings:
 *   URL:                 https://kurtcagle-mcp.ngrok.io/sse
 *   OAuth Client ID:     value of OAUTH_CLIENT_ID
 *   OAuth Client Secret: value of OAUTH_CLIENT_SECRET
 */

export default function registerOAuthRoutes(app) {

  // ── OAuth2 Discovery document ──────────────────────────────────────────────
  // claude.ai may probe this before attempting the token request.
  app.get('/.well-known/oauth-authorization-server', (req, res) => {
    const base = process.env.PUBLIC_BASE_URL ?? 'https://kurtcagle-mcp.ngrok.io'
    res.json({
      issuer:                                     base,
      token_endpoint:                             `${base}/oauth/token`,
      grant_types_supported:                      ['client_credentials'],
      token_endpoint_auth_methods_supported:      ['client_secret_post', 'client_secret_basic'],
      response_types_supported:                   ['token'],
    })
  })

  // ── Token endpoint ─────────────────────────────────────────────────────────
  app.post('/oauth/token', (req, res) => {
    let clientId, clientSecret

    // Support HTTP Basic auth: Authorization: Basic base64(id:secret)
    const authHeader = req.headers['authorization'] ?? ''
    if (authHeader.startsWith('Basic ')) {
      const decoded    = Buffer.from(authHeader.slice(6), 'base64').toString('utf8')
      const sep        = decoded.indexOf(':')
      clientId         = decoded.slice(0, sep)
      clientSecret     = decoded.slice(sep + 1)
    } else {
      // application/x-www-form-urlencoded body (most common from claude.ai)
      clientId         = req.body?.client_id
      clientSecret     = req.body?.client_secret
    }

    const grantType = req.body?.grant_type

    if (grantType !== 'client_credentials') {
      return res.status(400).json({
        error:             'unsupported_grant_type',
        error_description: 'Only client_credentials is supported',
      })
    }

    const expectedId     = process.env.OAUTH_CLIENT_ID
    const expectedSecret = process.env.OAUTH_CLIENT_SECRET
    const bearerToken    = process.env.BEARER_TOKEN   // what requireAuth checks

    if (!expectedId || !expectedSecret || !bearerToken) {
      console.error('[oauth] Missing OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, or BEARER_TOKEN in environment')
      return res.status(500).json({
        error:             'server_error',
        error_description: 'OAuth credentials not configured on server',
      })
    }

    if (clientId !== expectedId || clientSecret !== expectedSecret) {
      return res.status(401).json({
        error:             'invalid_client',
        error_description: 'Invalid client credentials',
      })
    }

    // Return BEARER_TOKEN as the access token — this is what requireAuth validates.
    return res.json({
      access_token: bearerToken,
      token_type:   'Bearer',
      expires_in:   3600,
      scope:        'mcp',
    })
  })
}
