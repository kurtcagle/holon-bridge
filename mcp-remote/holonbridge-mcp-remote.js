/**
 * holonbridge-mcp-remote.js
 *
 * Remote (HTTP/SSE) transport wrapper for holonbridge-mcp.
 * Exposes MCP tools over the MCP remote protocol so that the
 * Claude web client (claude.ai) can connect to them as a custom connector.
 *
 * Architecture
 * ------------
 *   claude.ai  --HTTPS/SSE-->  holonbridge-mcp-remote (:3032, ngrok)
 *                                       |
 *                                  HTTP REST + Bearer
 *                                       |
 *                              HolonBridge REST (:3031)
 *                                       |
 *                                  Fuseki (:3030)
 *
 * Setup
 * -----
 *   npm install @modelcontextprotocol/sdk express cors
 *   (no new dependency for OAuth/JWT -- see signJwt/verifyJwt below,
 *   hand-rolled HS256 using Node's built-in crypto module)
 *
 * GitHub OAuth App setup (one-time, on your own GitHub account or org):
 *   Register an OAuth App (not a GitHub App -- no installation-level
 *   permissions needed, just identity -- no scope is requested at all).
 *   Note this does NOT require the account to be a GitHub Organization --
 *   a personal account works identically, since access is gated by
 *   GITHUB_ALLOWED_USERS below, not org membership.
 *   Authorization callback URL: {MCP_PUBLIC_URL}/oauth/github/callback
 *   Note the generated Client ID and Client Secret for the env vars below.
 *
 * Environment (.env in the same directory as this file):
 *   HOLONBRIDGE_URL=http://localhost:3031
 *   HB_BEARER_TOKEN=<token for outbound HolonBridge REST calls -- service-
 *                    to-service secret between this process and
 *                    HolonBridge, never seen by a browser or a person>
 *   GITHUB_CLIENT_ID=<from the GitHub OAuth App above>
 *   GITHUB_CLIENT_SECRET=<from the GitHub OAuth App above>
 *   GITHUB_ALLOWED_USERS=kurtcagle,benwortley  # comma-separated GitHub
 *               logins permitted to log in, case-insensitive. This is the
 *               access gate -- not org membership (see v1.15.1 changelog).
 *   JWT_SECRET=<generate with: openssl rand -hex 32 -- signs per-user
 *               login tokens this process issues; distinct from
 *               HB_BEARER_TOKEN>
 *   JWT_EXPIRES_IN_SEC=43200         # optional, default 12h
 *   SERVICE_ACTOR_IRI=https://w3id.org/users/service-account  # optional
 *   MCP_REMOTE_TOKEN=<optional legacy fallback -- see Token relationship>
 *   MCP_PORT=3032
 *   MCP_PUBLIC_URL=https://kurtcagle-mcp.ngrok.io  # your public ngrok/tunnel URL
 *   FUSEKI_GSP=http://localhost:3030/ds/data        # retained for health reporting
 *                                                   # no longer used by push_turtle
 *
 * Token relationship (2026-07-11, v1.15.1):
 *   HB_BEARER_TOKEN      -- protects HolonBridge from the MCP remote. Static
 *                          service-to-service secret, unchanged by this
 *                          version, never exposed to a browser or a person.
 *   GitHub OAuth          -- a PERSON authenticates by logging into GitHub;
 *                          access is gated by GITHUB_ALLOWED_USERS, a
 *                          static allowlist of GitHub logins (see
 *                          /authorize, /oauth/github/callback below) --
 *                          not GitHub Organization membership, which v1.15.0
 *                          originally used and which requires the account
 *                          in question to actually be an Organization (a
 *                          personal account, which is what most solo/small-
 *                          team setups actually are, always fails that
 *                          check regardless of identity).
 *   Per-user JWT          -- minted by /token after a successful GitHub
 *                          login, carrying sub=https://w3id.org/users/
 *                          {githubLogin}. This is what a browser/client
 *                          actually holds and sends as Bearer on /sse and
 *                          /message -- verified by requireAuth, resolved to
 *                          req.actorIri once per session.
 *   MCP_REMOTE_TOKEN      -- OPTIONAL legacy fallback for non-interactive
 *                          automation (scripts/CI) that can't do a browser
 *                          login. If set, requireAuth still accepts an
 *                          exact match, but resolves to the single shared
 *                          SERVICE_ACTOR_IRI rather than a real identity --
 *                          same ambiguity every call had before this
 *                          version. New interactive use should always go
 *                          through GitHub login instead.
 *
 * NOTE on registry-backed profiles (see below): querying GET /registry uses
 * this bridge's own HB_BEARER_TOKEN, which is sufficient to read federation
 * metadata (which bridges exist, their URL, their health). It is NOT
 * sufficient to authenticate SPARQL/push calls against a *different* bridge
 * once switched via set_endpoint -- that still depends on whatever auth the
 * target bridge (e.g. Ben's GGSC instance) itself requires. The interbridge
 * token model (shared vs. per-bridge credentials) is a separate open question
 * from registry discovery and is not resolved by this change.
 *
 * Changelog
 * ---------
 *   2026-07-13 v1.19.0 Watch .env and .dataset-acl.json for changes on disk
 *                      and exit cleanly (debounced) when either changes, so
 *                      an external process supervisor (NSSM, pm2, systemd,
 *                      a restart-loop wrapper) restarts this process with
 *                      freshly loaded config. Deliberately does NOT attempt
 *                      to hot-reload dotenv or the ACL table in place --
 *                      .env is only ever read once at startup (via
 *                      `import 'dotenv/config'`), and JWT_SECRET in
 *                      particular changing under active sessions would
 *                      invalidate already-issued tokens in a way that's
 *                      easy to get subtly wrong if done live. A clean exit
 *                      + supervisor restart is simpler and safer than
 *                      partial in-process reload. If this process is ever
 *                      run bare (`node holonbridge-mcp-remote.js`, no
 *                      supervisor), it will now exit on config edits and
 *                      NOT come back up on its own -- pair this with NSSM/
 *                      pm2/a restart loop, not a bare `node` invocation.
 *   2026-07-12 v1.18.0 Add list_dataset_acls tool: the full multi-user
 *                      per-dataset ACL table (who has what access to which
 *                      dataset), merged against the live /datasets list so
 *                      datasets with no explicit .dataset-acl.json entry
 *                      (falling back to defaultAccess) are also visible --
 *                      previously the only way to see this was reading
 *                      .dataset-acl.json directly on the server. Restricted
 *                      to the bridge operator (actor login "kurtcagle"),
 *                      since unlike list_datasets (which only ever reports
 *                      the calling actor's own access), this exposes every
 *                      other actor's grants too.
 *   2026-07-11 v1.17.0 Per-dataset access control (Option 1). Loads a static
 *                      .dataset-acl.json file mapping datasets to permitted
 *                      actors and access levels ("r", "rw", or absent =
 *                      defaultAccess). Enforcement at the MCP tool level:
 *                      requireReadAccess() gates sparql_select, sparql_construct,
 *                      get_holon, list_graphs, nl_query, validate_turtle;
 *                      requireWriteAccess() gates sparql_update, push_turtle,
 *                      propose_property_update, create_agent, navigate_agent;
 *                      switch_dataset refuses switching to a dataset the actor
 *                      can't access; list_datasets shows yourAccess per dataset.
 *                      Actor keys are GitHub logins (case-insensitive); "*"
 *                      means all authenticated users. No ACL file = no
 *                      enforcement (permissive fallback). Denied requests never
 *                      leave mcp-remote -- HolonBridge never sees them.
 *   2026-07-11 v1.16.0 Per-actor sticky dataset selection. switch_dataset
 *                      no longer calls HolonBridge's global POST /dataset
 *                      (which silently changed every other concurrent
 *                      caller's dataset -- the cross-user isolation bug
 *                      Kurt identified). Instead, tracks a per-actor
 *                      dataset preference in a local JSON file
 *                      (.actor-dataset-state.json), persisted across
 *                      restarts and keyed by the actor's IRI from their
 *                      GitHub OAuth login. On every outbound HTTP call,
 *                      hbHeaders() injects X-Dataset-Override with the
 *                      current actor's preference; HolonBridge v2.10.0's
 *                      new dataset-override middleware reads this and
 *                      routes the request to the right Fuseki endpoints
 *                      without touching any process-wide global. Two
 *                      people connected simultaneously now query different
 *                      datasets without interfering. DEFAULT_DATASET env
 *                      var (default 'ds') controls what first-time actors
 *                      land on before they ever call switch_dataset.
 *   2026-07-11 v1.15.1 FIX: v1.15.0's access gate (GitHub Organization
 *                      membership via GET /user/memberships/orgs/:org)
 *                      404s unconditionally when the configured account is
 *                      a personal GitHub profile rather than an actual
 *                      Organization -- which is what most solo/small-team
 *                      setups, including this one, actually run out of.
 *                      Confirmed live: a real login attempt was rejected
 *                      with "not a member" despite correct credentials,
 *                      because kurtcagle is a personal account with no
 *                      memberships to check. Replaced GITHUB_ORG with
 *                      GITHUB_ALLOWED_USERS, a static comma-separated
 *                      allowlist of GitHub logins checked locally in
 *                      /oauth/github/callback -- no GitHub API call and no
 *                      OAuth scope needed for the check at all (dropped
 *                      'read:org' from the /authorize request). Works
 *                      identically whether the account in question is
 *                      personal or a real org, and matches what was
 *                      actually asked for (a closed list of specific
 *                      people) more directly than org membership did.
 *   2026-07-11 v1.15.0 Replace the single shared MCP_REMOTE_TOKEN with real
 *                      GitHub OAuth login. /authorize now redirects to
 *                      GitHub instead of minting a fake code; a new
 *                      /oauth/github/callback route exchanges the GitHub
 *                      code, fetches identity, and checks ACTIVE membership
 *                      in GITHUB_ORG (via /user/memberships/orgs/:org,
 *                      read:org scope -- no elevated org permissions
 *                      needed) before issuing anything; /token now signs a
 *                      real per-user JWT (hand-rolled HS256, no new
 *                      dependency -- see signJwt/verifyJwt) carrying
 *                      sub=https://w3id.org/users/{githubLogin} instead of
 *                      handing back the shared secret. requireAuth verifies
 *                      that JWT (or, as a legacy fallback, an exact
 *                      MCP_REMOTE_TOKEN match resolving to
 *                      SERVICE_ACTOR_IRI) and resolves the caller's
 *                      identity once at /sse connection time; every
 *                      lifecycle-verb tool (propose_property_update,
 *                      create_agent, navigate_agent) now reads that
 *                      identity via currentActorIri() -- threaded through
 *                      the same AsyncLocalStorage already used for
 *                      request-correlation IDs -- instead of trusting a
 *                      client-supplied actor_iri parameter, which is
 *                      dropped from all three tool schemas. This is the
 *                      substantive change: before this version, anyone
 *                      holding the one shared token could claim to be any
 *                      actor in the system; RoleBinding capability checks
 *                      were only ever as trustworthy as that claim.
 *   2026-07-11 v1.14.0 Add navigate_agent tool, wrapping HolonBridge's
 *                      lifecycle verb navigateAgent (POST
 *                      /holon/:iri/navigate, lib/lifecycle.js). Third
 *                      lifecycle verb exposed through this MCP remote
 *                      (after propose_property_update in v1.11.0 and
 *                      create_agent in v1.12.0). Moves an agent to a new
 *                      holon, writing a holon:VisitEvent chained via
 *                      holon:nextVisit from the agent's current visit-chain
 *                      tail, then updates holon:currentLocation to match --
 *                      closes the gap where every prior currentLocation
 *                      change in live Adventure Mode data (including Kim
 *                      Meades' Bonn -> Germany -> Munich chain) was written
 *                      by hand via raw sparql_update with no verb
 *                      enforcing a VisitEvent alongside the change.
 *   2026-07-11 v1.13.0 Add Process Started/Ended timing instrumentation
 *                      (lib/timing.js's timedProcess, shared with HolonBridge
 *                      REST) around every outbound hb* HTTP call to
 *                      HolonBridge, plus a correlation ID generated once per
 *                      incoming POST /message and threaded through via
 *                      AsyncLocalStorage into hbHeaders()'s X-Request-Id
 *                      header. HolonBridge's own requestTimingMiddleware
 *                      logs the same ID when present -- grepping a reqId
 *                      across both processes' logs and diffing the two
 *                      durations isolates the ngrok tunnel between
 *                      mcp-remote and HolonBridge REST specifically, as
 *                      distinct from Jena or LLM processing time (both
 *                      already instrumented server-side) or the separate
 *                      Claude-client-to-mcp-remote SSE tunnel (not
 *                      measurable this way -- no server-side visibility
 *                      into when Claude issued the request on that leg).
 *   2026-07-10 v1.12.0 Add create_agent tool, wrapping HolonBridge's
 *                      lifecycle verb createAgent (POST /agent,
 *                      lib/lifecycle.js). Second lifecycle verb exposed
 *                      through this MCP remote (after propose_property_update
 *                      in v1.11.0). Mints an Agent holon with baseline
 *                      values for its trackable properties, writing a
 *                      CreationEvent plus one PropertyBaselineEvent per
 *                      property -- closes the provenance gap where every
 *                      Adventure Mode agent up to this point had
 *                      healthPoints/currentWealth asserted as bare triples
 *                      with no event-graph record of their starting values.
 *   2026-07-09 v1.11.0 Add propose_property_update tool, wrapping HolonBridge's
 *                      lifecycle verb proposeAgentPropertyUpdate (POST
 *                      /holon/:iri/property, lib/lifecycle.js). Before this,
 *                      none of lib/lifecycle.js's thirteen verbs were reachable
 *                      through this MCP remote at all -- only the pre-lifecycle
 *                      surface (query/update/push/validate/get_holon) was
 *                      exposed. This is the first lifecycle verb wired through,
 *                      chosen because it's the one with an actual near-term use
 *                      (Adventure Mode agent health/wealth changes going through
 *                      a real SHACL-gated propose/approve pair instead of raw
 *                      sparql_update with no enforcement at all). The other
 *                      twelve verbs remain unexposed here pending the same
 *                      treatment.
 *   2026-07-07 v1.10.3 FIX: hbPushTurtle()'s shapes_graph parameter was
 *                      non-blocking. It called hbValidate() and awaited the
 *                      result, but never inspected report.conforms -- a
 *                      validation report with conforms:false is a normal
 *                      successful HTTP response, not a thrown error, so
 *                      nothing stopped the subsequent /update push. Before
 *                      v1.10.2 this was accidentally masked: hbValidate()
 *                      always threw (the v1.10.1 /validate contract bug),
 *                      so shapes_graph always blocked the push -- for the
 *                      wrong reason (broken endpoint, not real violations).
 *                      Fixed in v1.10.2, the accidental gate disappeared:
 *                      confirmed live that a sol:Planet instance missing
 *                      every required property (mass, meanRadius,
 *                      orbitalPeriod, distanceFromSun, moonCount, orbits)
 *                      still pushed successfully with shapes_graph set.
 *                      Fix: hbPushTurtle() now checks report.conforms and
 *                      throws -- listing focusNode/path/message per
 *                      violation -- before the /update call, so a
 *                      non-conforming payload never reaches the target
 *                      graph. Conforming payloads and calls without
 *                      shapes_graph are unaffected.
 *   2026-07-07 v1.10.2 FIX: hbValidate() was calling /validate with the old
 *                      contract (raw Turtle body, Content-Type: text/turtle,
 *                      shapes graph as a `?shapes=` query param). The route
 *                      handler (lib/validate.js, v2.9.1+) was refactored to
 *                      require a JSON body of { dataGraph, shapesGraph } where
 *                      dataGraph is the IRI of an *already-loaded* named graph
 *                      -- it fetches that graph via GSP and delegates to
 *                      validateWithShacl(). Since hbValidate() never sent
 *                      dataGraph, every call hit the route's own 400 guard
 *                      ('"dataGraph" is required...'), regardless of dataset,
 *                      shapes graph content, or payload -- including trivial
 *                      two-triple payloads. This also broke push_turtle
 *                      whenever a shapes_graph was supplied, since
 *                      hbPushTurtle() calls hbValidate() first in that case.
 *                      Fix: hbValidate() now pushes the submitted Turtle to a
 *                      short-lived temp graph via the existing hbPushTurtle
 *                      path (mode='replace', no shapes_graph so no recursion),
 *                      calls /validate with the correct JSON contract against
 *                      that temp graph, then drops it (best-effort, does not
 *                      block the returned report on cleanup success).
 *   2026-07-01 v1.10.1 FIX: set_endpoint was cosmetic. Every hb* HTTP helper
 *                      (hbQuery, hbUpdate, hbPushTurtle, hbGetHolon,
 *                      hbValidate, hbNlQuery, hbListGraphs) plus the inline
 *                      list_datasets/switch_dataset fetches called the
 *                      module-level HOLONBRIDGE_URL constant directly,
 *                      ignoring activeProfile entirely -- so switching
 *                      profiles never redirected any actual query, push, or
 *                      dataset call; only get_endpoint/list_endpoints ever
 *                      read activeProfile. Introduced activeBaseUrl(), the
 *                      single source of truth for "which bridge do we talk
 *                      to right now," and routed every HTTP call through it.
 *                      /health now reports activeBridge alongside the
 *                      configured default, so this class of bug is visible
 *                      without having to compare dataset listings by hand.
 *                      This bug predates and was not introduced by v1.10.0;
 *                      it was exposed by v1.10.0 making profile-switching
 *                      to a *meaningfully different* bridge possible for the
 *                      first time (previously all named profiles pointed at
 *                      variations of the same local setup).
 *   2026-07-01 v1.10.0 Registry-backed profile discovery. list_endpoints,
 *                      get_endpoint, and set_endpoint now merge static
 *                      .env PROFILE_<n>_URL entries with live results
 *                      from GET /registry on HolonBridge (federated bridge
 *                      registry, GitHub-backed, health-checked server-side).
 *                      Any bridge registered in the federation -- e.g. Ben's
 *                      GGSC bridge -- becomes switchable via set_endpoint
 *                      without manual config edits or a restart. Registry
 *                      results are cached 30s; set_endpoint forces a fresh
 *                      pull so newly-registered bridges are available
 *                      immediately. Falls back to static/cached profiles if
 *                      the registry call fails (non-fatal).
 *   2026-06-28 v1.9.0  Route push_turtle through HolonBridge REST (/update)
 *                      instead of calling Fuseki GSP directly. Benefits:
 *                      - mode defaults to 'append' (POST/merge) not 'replace' (PUT)
 *                      - Bearer auth flows through on every push
 *                      - mode exposed as MCP tool parameter; callers opt into 'replace'
 *                      - Removes dependency on jenaBase / direct Fuseki access
 *   2026-06-28 v1.8.0  Fix push_turtle writes to wrong dataset: FUSEKI_GSP was
 *                      hardcoded in .env and never updated when switch_dataset
 *                      was called. Now derives jenaBase from FUSEKI_GSP once at
 *                      startup; tracks activeFusekiDataset in module state;
 *                      switch_dataset syncs it on success; hbPushTurtle builds
 *                      the GSP URL dynamically as jenaBase/activeFusekiDataset/data.
 *                      Also synced mcp-remote/ with root canonical file.
 *   2026-06-26 v1.7.1  (previous -- see git log)
 *   2026-06-26 v1.2    Fix POST /message 400: remove express.json() middleware;
 *                      pass req.body explicitly to handlePostMessage.
 *   2026-06-26 v1.1    Fix "Already connected" crash: create McpServer per
 *                      SSE connection instead of sharing one instance.
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { randomUUID, createHmac } from 'crypto';
import { readFileSync, writeFileSync, existsSync, watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { timedProcess } from '../lib/timing.js';

// -- Configuration -----------------------------------------------------------------
//
// Identity model (2026-07-11, v1.15.1): GitHub OAuth replaces the single
// shared MCP_REMOTE_TOKEN as the primary way a *person* authenticates.
// GITHUB_CLIENT_ID/SECRET and GITHUB_ALLOWED_USERS are required for the
// login flow (see /authorize, /oauth/github/callback, /token below).
// JWT_SECRET signs the per-user tokens this process issues after a
// successful GitHub login and allowlist check -- distinct from
// HB_BEARER_TOKEN, which remains a service-to-service secret between this
// process and HolonBridge REST and is never seen by a browser or a person.
//
// MCP_REMOTE_TOKEN is now OPTIONAL and legacy: if set, it's still accepted
// as a Bearer credential (for scripts/CI that can't do an interactive
// GitHub login), but it resolves to a single shared SERVICE_ACTOR_IRI
// rather than a real person's identity -- every RoleBinding capability
// check against that IRI applies to whatever holds the token, same
// ambiguity as before this change. New interactive use should go through
// GitHub login.

const {
  HOLONBRIDGE_URL = 'http://localhost:3031',
  HB_BEARER_TOKEN,
  MCP_REMOTE_TOKEN,
  MCP_PORT = '3032',
  FUSEKI_GSP = 'http://localhost:3030/ds/data',  // retained for health reporting; no longer used by push_turtle
  GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET,
  GITHUB_ALLOWED_USERS,
  JWT_SECRET,
  JWT_EXPIRES_IN_SEC = String(12 * 60 * 60),   // 12h default
  SERVICE_ACTOR_IRI = 'https://w3id.org/users/service-account',
  DEFAULT_DATASET = 'ds',   // dataset a person lands on the FIRST time they log in, before ever calling switch_dataset
} = process.env;

if (!HB_BEARER_TOKEN)    throw new Error('HB_BEARER_TOKEN is required in .env');
if (!GITHUB_CLIENT_ID)   throw new Error('GITHUB_CLIENT_ID is required in .env (GitHub OAuth App)');
if (!GITHUB_CLIENT_SECRET) throw new Error('GITHUB_CLIENT_SECRET is required in .env (GitHub OAuth App)');
if (!GITHUB_ALLOWED_USERS) throw new Error('GITHUB_ALLOWED_USERS is required in .env -- comma-separated GitHub logins permitted to log in');
if (!JWT_SECRET)         throw new Error('JWT_SECRET is required in .env (generate with: openssl rand -hex 32) -- signs per-user login tokens');

const JWT_EXPIRES_IN_SECONDS = parseInt(JWT_EXPIRES_IN_SEC, 10) || 12 * 60 * 60;

// Case-insensitive allowlist of GitHub logins permitted to authenticate.
// Replaces an earlier org-membership check (GET /user/memberships/orgs/:org)
// that assumed GITHUB_ORG named an actual GitHub Organization -- it doesn't
// have to be one. Most solo/small-team setups (this one included) run out
// of a personal GitHub account, where that endpoint 404s for everyone
// regardless of identity. An explicit allowlist works identically whether
// the account in question is a personal profile or a real org, needs no
// GitHub scope beyond default identity read (no more 'read:org'), and is a
// one-line .env edit to add or remove someone -- which is what "a closed
// network of people working within a shared GitHub environment" actually
// asks for.
const ALLOWED_GITHUB_LOGINS = new Set(
  GITHUB_ALLOWED_USERS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);

// -- Per-actor sticky dataset preference (v1.16.0) ------------------------------
//
// Tracks which Fuseki dataset each logged-in actor last selected via
// switch_dataset, persisted to a small JSON file so the preference survives
// mcp-remote restarts (the actor doesn't have to re-switch every time they
// reconnect). On every outbound HTTP call to HolonBridge, hbHeaders()
// injects X-Dataset-Override with the current actor's dataset preference --
// HolonBridge v2.10.0's dataset-override middleware reads this and routes
// the request to the right Fuseki dataset endpoints without touching the
// process-wide global that every other concurrent caller might also be
// reading. This is the mcp-remote side of the fix for the cross-user
// dataset isolation bug described in server.js v2.10.0's header.
//
// The store is a simple { [actorIri]: datasetName } map. Actors who have
// never called switch_dataset default to DEFAULT_DATASET (env var, default
// 'ds'). The file lives alongside this script in the mcp-remote directory;
// add .actor-dataset-state.json to .gitignore.

const __hbDirname = dirname(fileURLToPath(import.meta.url));
const ACTOR_DATASET_STATE_FILE = join(__hbDirname, '.actor-dataset-state.json');

function loadActorDatasetState() {
  try {
    if (existsSync(ACTOR_DATASET_STATE_FILE)) {
      return JSON.parse(readFileSync(ACTOR_DATASET_STATE_FILE, 'utf8'));
    }
  } catch (err) {
    console.warn('[dataset-state] Failed to load persisted actor dataset state (starting fresh):', err.message);
  }
  return {};
}

let actorDatasetState = loadActorDatasetState();

function saveActorDatasetState() {
  try {
    writeFileSync(ACTOR_DATASET_STATE_FILE, JSON.stringify(actorDatasetState, null, 2));
  } catch (err) {
    console.warn('[dataset-state] Failed to persist actor dataset state:', err.message);
  }
}

function getActorDataset(actorIri) {
  return actorDatasetState[actorIri] ?? DEFAULT_DATASET;
}

function setActorDataset(actorIri, dataset) {
  actorDatasetState[actorIri] = dataset;
  saveActorDatasetState();
}

// -- Per-dataset access control (v1.17.0) ----------------------------------------
//
// Static allowlist mapping datasets to permitted actors and access levels.
// Loaded from .dataset-acl.json alongside this script at startup. Format:
//
//   {
//     "defaultAccess": "none",        // "none", "r", or "rw" for unlisted datasets
//     "datasets": {
//       "data":  { "*": "rw" },       // "*" = all authenticated users
//       "chloe": { "kurtcagle": "rw" },
//       "ggsc":  { "kurtcagle": "rw", "benwortley": "rw" }
//     }
//   }
//
// Access values: "r" (read only), "rw" (read + write), absent = defaultAccess.
// Actor keys are GitHub logins (matched case-insensitively against the login
// resolved at authentication time, not the full actor IRI). "*" matches any
// authenticated user. A specific login entry overrides "*" for that actor.
//
// Enforcement is at the MCP tool level in this process -- a denied request
// never leaves mcp-remote. This does not prevent someone with the raw
// HB_BEARER_TOKEN from curling HolonBridge directly (see Option 2/3 in the
// design notes for defense-in-depth if that matters).

const DATASET_ACL_FILE = join(__hbDirname, '.dataset-acl.json');

function loadDatasetAcl() {
  try {
    if (existsSync(DATASET_ACL_FILE)) {
      const raw = JSON.parse(readFileSync(DATASET_ACL_FILE, 'utf8'));
      console.log(`[dataset-acl] Loaded ACL for ${Object.keys(raw.datasets ?? {}).length} dataset(s) from ${DATASET_ACL_FILE}`);
      return raw;
    }
  } catch (err) {
    console.warn('[dataset-acl] Failed to load .dataset-acl.json (running without ACL -- all access permitted):', err.message);
  }
  return null;  // null = no ACL file = no enforcement
}

const datasetAcl = loadDatasetAcl();

// -- Auto-restart on config file changes (v1.19.0) --------------------------------
//
// Watches .env and .dataset-acl.json for changes and exits cleanly
// (debounced) when either changes, so an external process supervisor
// (NSSM, pm2, systemd, a restart-loop wrapper script) restarts this process
// with freshly loaded config. Deliberately does NOT attempt to hot-reload
// dotenv or the ACL table in place -- .env is only ever read once at
// startup (via `import 'dotenv/config'` at the top of this file), and
// JWT_SECRET in particular changing under active sessions would invalidate
// already-issued tokens in a way that's easy to get subtly wrong if handled
// live. A clean exit + supervisor restart is simpler and safer than a
// partial in-process reload.
//
// Debounced because editors and some tools emit multiple fs events for a
// single logical save (write-then-rename, or several writes for an atomic
// save) -- without debouncing this could trigger more than one restart per
// edit.
//
// IMPORTANT: if this process is ever run bare (`node holonbridge-mcp-remote.js`
// with no supervisor), it will now exit on a config edit and NOT come back
// up on its own. Pair this with NSSM/pm2/a restart-loop wrapper, not a bare
// `node` invocation.

const ENV_FILE = join(__hbDirname, '.env');
const RESTART_DEBOUNCE_MS = 500;
let restartTimer = null;

function scheduleRestart(reason) {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    console.log(`[restart] ${reason} -- exiting so the process supervisor can restart with fresh config.`);
    process.exit(0);
  }, RESTART_DEBOUNCE_MS);
}

for (const [label, watchPath] of [['.env', ENV_FILE], ['.dataset-acl.json', DATASET_ACL_FILE]]) {
  if (existsSync(watchPath)) {
    try {
      watch(watchPath, { persistent: true }, (eventType) => {
        scheduleRestart(`${label} changed (${eventType})`);
      });
      console.log(`[restart] Watching ${label} for changes (${watchPath})`);
    } catch (err) {
      console.warn(`[restart] Failed to watch ${label}:`, err.message);
    }
  } else {
    console.warn(`[restart] ${label} not found at ${watchPath} -- not watching. Create it and restart this process to enable watching.`);
  }
}

/**
 * Resolve the effective access level for a given actor on a given dataset.
 * Returns "rw", "r", or "none".
 *
 * Resolution order (first match wins):
 *   1. Specific login entry in the dataset's actor map
 *   2. "*" wildcard entry in the dataset's actor map
 *   3. defaultAccess from the ACL root
 *   4. "rw" if no ACL file is loaded at all (permissive fallback)
 */
function resolveDatasetAccess(githubLogin, dataset) {
  if (!datasetAcl) return 'rw';  // no ACL file = no enforcement
  const dsEntry = datasetAcl.datasets?.[dataset];
  if (!dsEntry) return datasetAcl.defaultAccess ?? 'none';
  const login = (githubLogin ?? '').toLowerCase();
  // Specific login entry takes priority over wildcard
  if (login && dsEntry[login] !== undefined) return dsEntry[login];
  if (login) {
    // Case-insensitive search through keys
    for (const [key, val] of Object.entries(dsEntry)) {
      if (key !== '*' && key.toLowerCase() === login) return val;
    }
  }
  // Wildcard
  if (dsEntry['*'] !== undefined) return dsEntry['*'];
  return datasetAcl.defaultAccess ?? 'none';
}

/**
 * Check that the current actor has at least read access to the current dataset.
 * Throws a descriptive error if denied. Call at the top of read-path tool handlers.
 */
function requireReadAccess() {
  if (!datasetAcl) return;  // no ACL = no enforcement
  const login = requestContext.getStore()?.githubLogin;
  const dataset = currentDataset();
  if (!dataset) return;  // no dataset in context = nothing to check
  const access = resolveDatasetAccess(login, dataset);
  if (access === 'none') {
    throw new Error(`Access denied: you (${login ?? 'unknown'}) do not have read access to dataset "${dataset}".`);
  }
  // "r" and "rw" both satisfy a read check
}

/**
 * Check that the current actor has write access to the current dataset.
 * Throws a descriptive error if denied. Call at the top of write-path tool handlers.
 */
function requireWriteAccess() {
  if (!datasetAcl) return;  // no ACL = no enforcement
  const login = requestContext.getStore()?.githubLogin;
  const dataset = currentDataset();
  if (!dataset) return;
  const access = resolveDatasetAccess(login, dataset);
  if (access !== 'rw') {
    const reason = access === 'r' ? 'you have read-only access' : 'you do not have access';
    throw new Error(`Write denied: ${reason} to dataset "${dataset}" (actor: ${login ?? 'unknown'}).`);
  }
}

// -- GSP dataset tracking (health reporting only) -------------------------------------------
//
// jenaBase and activeFusekiDataset are derived from FUSEKI_GSP and updated
// by switch_dataset. They are surfaced in /health for observability.
// push_turtle now routes through HolonBridge REST (/update) and no longer
// constructs a direct GSP URL.

const jenaBase = FUSEKI_GSP.replace(/\/[^/]+\/data\/?$/, '');   // "http://localhost:3030"
let activeFusekiDataset = FUSEKI_GSP.match(/\/([^/]+)\/data\/?$/)?.[1] ?? 'ds';

// -- JWT helpers (minimal HS256, no external dependency) -----------------------------
//
// Deliberately hand-rolled rather than pulling in `jsonwebtoken` -- the
// surface this process needs is tiny (sign one claim set, verify signature
// + expiry) and a dependency-free implementation means this file's identity
// layer can be read start-to-finish without trusting a third-party library's
// parsing of attacker-controlled input. Standard JWT wire format (base64url
// header.payload.signature) so tokens remain inspectable with any JWT
// debugger if needed.

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(input) {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(input.length + (4 - (input.length % 4 || 4)) % 4, '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function signJwt(payload, secret, expiresInSeconds) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat: now, exp: now + expiresInSeconds };
  const headerB64  = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(fullPayload));
  const signature = createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${headerB64}.${payloadB64}.${signature}`;
}

/**
 * Verify a JWT's signature and expiry. Returns the decoded payload on
 * success, or null on any failure (bad format, bad signature, expired) --
 * callers treat null as "not authenticated," never distinguishing failure
 * reasons to the client, to avoid leaking which part of a forged token was
 * wrong.
 */
function verifyJwt(token, secret) {
  try {
    const [headerB64, payloadB64, signatureB64] = token.split('.');
    if (!headerB64 || !payloadB64 || !signatureB64) return null;
    const expectedSig = createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (expectedSig !== signatureB64) return null;
    const payload = JSON.parse(base64urlDecode(payloadB64));
    if (typeof payload.exp !== 'number' || Math.floor(Date.now() / 1000) >= payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// -- HolonBridge HTTP helpers (aligned to v2.9.0 routes) ----------------------------

// -- Request correlation ----------------------------------------------------------
//
// A correlation ID generated once per incoming POST /message (i.e. once per
// MCP tool call, see app.post('/message', ...) below), threaded through to
// every outbound HolonBridge fetch via hbHeaders()'s X-Request-Id header.
// HolonBridge's own requestTimingMiddleware (lib/timing.js) logs the same ID
// when present, so a request's total duration as seen by this process can be
// diffed against its duration as seen by HolonBridge REST -- a *different*
// process, a *different* log file -- to isolate the ngrok tunnel between
// mcp-remote and HolonBridge REST specifically, as distinct from Jena or LLM
// processing time (both already instrumented server-side) or the separate
// Claude-client-to-mcp-remote SSE tunnel (not measurable this way -- no
// server-side visibility into when Claude issued the request on that leg).
//
// Extended 2026-07-11 (v1.15.0) to also carry actorIri/githubLogin -- the
// identity resolved once at /sse connection time from the caller's Bearer
// token (see requireAuth and the /sse handler below), threaded through the
// same AsyncLocalStorage so every lifecycle-verb tool handler can read
// currentActorIri() instead of trusting a client-supplied actor_iri
// parameter. This is the actual security-relevant change in this version --
// everything else here is plumbing to make that one substitution possible.

const requestContext = new AsyncLocalStorage();

function currentRequestId() {
  return requestContext.getStore()?.reqId;
}

function currentActorIri() {
  return requestContext.getStore()?.actorIri;
}

function currentDataset() {
  return requestContext.getStore()?.dataset;
}

const hbHeaders = (extra = {}) => {
  const reqId = currentRequestId();
  const dataset = currentDataset();
  return {
    Authorization: `Bearer ${HB_BEARER_TOKEN}`,
    ...(reqId ? { 'X-Request-Id': reqId } : {}),
    ...(dataset ? { 'X-Dataset-Override': dataset } : {}),
    ...extra,
  };
};

async function hbQuery(sparql, type = 'select') {
  return timedProcess(`mcp-remote -> HolonBridge /sparql-${type === 'construct' ? 'construct' : 'select'} [reqId=${currentRequestId() ?? 'none'}]`, async () => {
    const base = activeBaseUrl();
    if (type === 'construct') {
      const res = await fetch(`${base}/sparql-construct`, {
        method: 'POST',
        headers: hbHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ query: sparql }),
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(`HolonBridge /sparql-construct: HTTP ${res.status} -- ${msg.slice(0, 200)}`);
      }
      return res.text();
    } else {
      const res = await fetch(`${base}/sparql-select`, {
        method: 'POST',
        headers: hbHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
        body: JSON.stringify({ sparql }),
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(`HolonBridge /sparql-select: HTTP ${res.status} -- ${msg.slice(0, 200)}`);
      }
      return res.json();
    }
  });
}

async function hbUpdate(sparql) {
  return timedProcess(`mcp-remote -> HolonBridge /sparql-update [reqId=${currentRequestId() ?? 'none'}]`, async () => {
    const res = await fetch(`${activeBaseUrl()}/sparql-update`, {
      method: 'POST',
      headers: hbHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ update: sparql }),
    });
    if (!res.ok) {
      const msg = await res.text();
      throw new Error(`HolonBridge /sparql-update: HTTP ${res.status} -- ${msg.slice(0, 200)}`);
    }
    return res.json();
  });
}

async function hbPushTurtle(turtle, graphIri, shapesGraph, mode = 'append') {
  if (shapesGraph) {
    const report = await hbValidate(turtle, shapesGraph);
    if (report.conforms === false) {
      const violationLines = (report.violations ?? []).map((v, i) => {
        const focus = v.focusNode ? ` on <${v.focusNode}>` : '';
        const path  = v.path ? ` at ${v.path}` : '';
        const msg   = v.message ? ` -- ${v.message}` : '';
        return `  ${i + 1}.${focus}${path}${msg}`;
      });
      throw new Error(
        `SHACL validation failed against <${shapesGraph}> -- push aborted. ` +
        `${report.violationCount ?? report.violations?.length ?? 0} violation(s):\n` +
        (violationLines.length ? violationLines.join('\n') : '  (see rawReport for details)')
      );
    }
  }
  return timedProcess(`mcp-remote -> HolonBridge /update [reqId=${currentRequestId() ?? 'none'}]`, async () => {
    const res = await fetch(`${activeBaseUrl()}/update`, {
      method: 'POST',
      headers: hbHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ turtle, graph: graphIri, mode }),
    });
    if (!res.ok) {
      const msg = await res.text();
      throw new Error(`HolonBridge /update: HTTP ${res.status} -- ${msg.slice(0, 200)}`);
    }
    const result = await res.json();
    return `Pushed to <${graphIri}> via HolonBridge /update -- HTTP ${res.status}, mode=${mode}`;
  });
}

async function hbGetHolon(holonIri, projectionMode = 'immersive') {
  return timedProcess(`mcp-remote -> HolonBridge /holon [reqId=${currentRequestId() ?? 'none'}]`, async () => {
    const url = new URL(`${activeBaseUrl()}/holon/${encodeURIComponent(holonIri)}`);
    url.searchParams.set('projection', projectionMode);
    const res = await fetch(url.toString(), {
      headers: hbHeaders({ Accept: 'text/markdown' }),
    });
    if (!res.ok) throw new Error(`HolonBridge /holon: HTTP ${res.status}`);
    return res.text();
  });
}

/**
 * Propose->validate->apply a delta to a numeric agent property via
 * HolonBridge's proposeAgentPropertyUpdate lifecycle verb (POST
 * /holon/:iri/property, lib/lifecycle.js). Validated against the
 * property's governing SHACL shape BEFORE any write on the HolonBridge
 * side -- a rejection comes back as a non-2xx HTTP response (409 for
 * CommandRejected, 403 for UnauthorisedError), surfaced here as a thrown
 * Error carrying the response body so the violation detail isn't lost.
 *
 * actorIri (2026-07-11, v1.15.0) is no longer a caller-supplied argument --
 * it's read from currentActorIri(), resolved once at login from the
 * caller's verified GitHub identity (see requireAuth / /sse below). A tool
 * caller can no longer claim to be a different actor than the person who
 * actually logged in.
 */
async function hbProposePropertyUpdate(agentIri, property, delta, rationale, capProperty, floor) {
  const actorIri = currentActorIri();
  if (!actorIri) throw new Error('No authenticated actor identity on this session -- log in again.');
  return timedProcess(`mcp-remote -> HolonBridge /holon/.../property [reqId=${currentRequestId() ?? 'none'}]`, async () => {
    const url = `${activeBaseUrl()}/holon/${encodeURIComponent(agentIri)}/property`;
    const body = { property, delta, rationale, actor: { iri: actorIri } };
    if (capProperty !== undefined) body.capProperty = capProperty;
    if (floor !== undefined) body.floor = floor;
    const res = await fetch(url, {
      method: 'POST',
      headers: hbHeaders({ 'Content-Type': 'application/json', Accept: 'text/markdown' }),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HolonBridge /holon/.../property: HTTP ${res.status} -- ${text.slice(0, 400)}`);
    }
    return text;
  });
}

/**
 * Mint a new Agent holon via HolonBridge's createAgent lifecycle verb
 * (POST /agent, lib/lifecycle.js). Writes a CreationEvent plus one
 * PropertyBaselineEvent per trackable property; each property's governing
 * shape/capProperty/floor resolves from ontology metadata unless overridden
 * per-property in trackableProperties. A single baseline that violates its
 * shape rejects the whole creation -- surfaced here as a thrown Error
 * carrying the response body (409 with violation detail, not a silent
 * partial write).
 *
 * actorIri comes from currentActorIri() (see hbProposePropertyUpdate above
 * for why), not a caller-supplied argument.
 */
async function hbCreateAgent(agentIri, label, agentKind, description, extraTurtle, trackableProperties) {
  const actorIri = currentActorIri();
  if (!actorIri) throw new Error('No authenticated actor identity on this session -- log in again.');
  return timedProcess(`mcp-remote -> HolonBridge /agent [reqId=${currentRequestId() ?? 'none'}]`, async () => {
    const url = `${activeBaseUrl()}/agent`;
    const body = { agentIri, label, agentKind, actor: { iri: actorIri } };
    if (description !== undefined) body.description = description;
    if (extraTurtle !== undefined) body.extraTurtle = extraTurtle;
    if (trackableProperties !== undefined) body.trackableProperties = trackableProperties;
    const res = await fetch(url, {
      method: 'POST',
      headers: hbHeaders({ 'Content-Type': 'application/json', Accept: 'text/markdown' }),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HolonBridge /agent: HTTP ${res.status} -- ${text.slice(0, 400)}`);
    }
    return text;
  });
}

/**
 * Move an agent to a new holon via HolonBridge's navigateAgent lifecycle
 * verb (POST /holon/:iri/navigate, lib/lifecycle.js). Writes a
 * holon:VisitEvent chained via holon:nextVisit from the agent's current
 * visit-chain tail, then updates holon:currentLocation to match.
 * destinationIri must already exist as a holon on the HolonBridge side --
 * a dangling destination comes back as a non-2xx response (409
 * CommandRejected), surfaced here as a thrown Error carrying the response
 * body. Third lifecycle verb wired through this MCP remote (after
 * propose_property_update in v1.11.0 and create_agent in v1.12.0).
 *
 * actorIri comes from currentActorIri() (see hbProposePropertyUpdate above
 * for why), not a caller-supplied argument.
 */
async function hbNavigateAgent(agentIri, destinationIri, note) {
  const actorIri = currentActorIri();
  if (!actorIri) throw new Error('No authenticated actor identity on this session -- log in again.');
  return timedProcess(`mcp-remote -> HolonBridge /holon/.../navigate [reqId=${currentRequestId() ?? 'none'}]`, async () => {
    const url = `${activeBaseUrl()}/holon/${encodeURIComponent(agentIri)}/navigate`;
    const body = { destinationIri, actor: { iri: actorIri } };
    if (note !== undefined) body.note = note;
    const res = await fetch(url, {
      method: 'POST',
      headers: hbHeaders({ 'Content-Type': 'application/json', Accept: 'text/markdown' }),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HolonBridge /holon/.../navigate: HTTP ${res.status} -- ${text.slice(0, 400)}`);
    }
    return text;
  });
}

/**
 * Validate a Turtle payload against a SHACL shapes graph.
 *
 * The current /validate route (lib/validate.js, v2.9.1+) only validates a
 * named graph that already exists in the dataset -- it takes JSON
 * { dataGraph, shapesGraph } and fetches dataGraph via GSP internally. It
 * does not accept raw Turtle in the request body.
 *
 * To preserve this tool's existing contract (accept raw Turtle directly,
 * the way validate_turtle and push_turtle's shapes_graph option both do),
 * we push the submitted Turtle into a short-lived temp graph first, run
 * /validate against that graph's IRI, then drop the temp graph. Mirrors the
 * temp-graph pattern lib/shacl.js already uses server-side against Fuseki
 * directly -- this does the equivalent through the public REST surface.
 */
async function hbValidate(turtle, shapesGraph) {
  const tempGraph = `urn:holonbridge-mcp:validate-temp:${Date.now()}`;

  // Push without a shapesGraph so this doesn't recurse back into hbValidate.
  await hbPushTurtle(turtle, tempGraph, null, 'replace');

  let result;
  try {
    result = await timedProcess(`mcp-remote -> HolonBridge /validate [reqId=${currentRequestId() ?? 'none'}]`, async () => {
      const res = await fetch(`${activeBaseUrl()}/validate`, {
        method: 'POST',
        headers: hbHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
        body: JSON.stringify({ dataGraph: tempGraph, shapesGraph }),
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(`HolonBridge /validate: HTTP ${res.status} -- ${msg.slice(0, 200)}`);
      }
      return res.json();
    });
  } finally {
    // Best-effort cleanup -- don't let a failed DROP mask or block the
    // validation result itself.
    await hbUpdate(`DROP SILENT GRAPH <${tempGraph}>`).catch(() => {});
  }

  return result;
}

async function hbNlQuery(question, graph) {
  return timedProcess(`mcp-remote -> HolonBridge /query (NL) [reqId=${currentRequestId() ?? 'none'}]`, async () => {
    const body = { nl: question };
    if (graph) body.graph = graph;
    const res = await fetch(`${activeBaseUrl()}/query`, {
      method: 'POST',
      headers: hbHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const msg = await res.text();
      throw new Error(`HolonBridge /query: HTTP ${res.status} -- ${msg.slice(0, 200)}`);
    }
    return res.json();
  });
}

async function hbListGraphs(filter) {
  const res = await fetch(`${activeBaseUrl()}/graphs`, {
    headers: hbHeaders({ Accept: 'application/json' }),
  });
  if (!res.ok) throw new Error(`HolonBridge /graphs: HTTP ${res.status}`);
  const { graphs } = await res.json();
  return graphs
    .map(g => ({ iri: g.iri, triples: String(g.triples) }))
    .filter(g => !filter || g.iri.includes(filter));
}

// -- Static (.env) profile state -------------------------------------------------

const profiles = {
  default: { url: HOLONBRIDGE_URL, label: 'default (from .env)', source: 'static' },
};
Object.keys(process.env)
  .filter(k => k.startsWith('PROFILE_') && k.endsWith('_URL'))
  .forEach(k => {
    const name = k.replace(/^PROFILE_/, '').replace(/_URL$/, '').toLowerCase();
    profiles[name] = {
      url: process.env[k],
      label: process.env[`PROFILE_${name.toUpperCase()}_LABEL`] || name,
      source: 'static',
    };
  });

let activeProfile = 'default';

// -- Registry-backed profiles ----------------------------------------------------
//
// In addition to the static .env profiles above, profiles are pulled live
// from HolonBridge's federated bridge registry (GET /registry), which is
// sourced from a GitHub-backed RDF registry graph and health-checked
// server-side (see registry/session-init.js and registry/server-integration.md
// in this repo). This lets any bridge registered in the federation -- e.g.
// Ben Wortley's GGSC bridge -- become switchable via set_endpoint without
// manual profile edits or a restart, and stays current as the registry grows
// past two nodes.
//
// Cached for REGISTRY_CACHE_MAX_AGE_MS to avoid hitting /registry on every
// tool call; set_endpoint forces a fresh pull so a bridge registered moments
// ago is immediately available. On fetch failure, falls back to the last
// good cache (or empty, pre-first-fetch) rather than throwing -- registry
// unavailability should never break the static profiles.

const REGISTRY_CACHE_MAX_AGE_MS = 30_000;
let registryCache = { fetchedAt: 0, profiles: {} };

function slugFromIri(iri) {
  // "https://w3id.org/holonbridge/registry/ben-ggsc" -> "ben-ggsc"
  return iri.split('/').filter(Boolean).pop();
}

async function fetchRegistryProfiles({ force = false } = {}) {
  const age = Date.now() - registryCache.fetchedAt;
  if (!force && registryCache.fetchedAt && age < REGISTRY_CACHE_MAX_AGE_MS) {
    return registryCache.profiles;
  }
  try {
    const res = await fetch(`${HOLONBRIDGE_URL}/registry`, {
      headers: hbHeaders({ Accept: 'application/json' }),
    });
    if (!res.ok) {
      console.warn(`[registry] GET /registry: HTTP ${res.status} -- keeping previous cache`);
      return registryCache.profiles;
    }
    const { bridges = [] } = await res.json();
    const fresh = {};
    for (const b of bridges) {
      if (!b.iri || !b.url) continue;
      const slug = slugFromIri(b.iri);
      fresh[slug] = {
        url: b.url,
        label: b.label || slug,
        reachable: b.health?.reachable ?? b.reachable ?? null,
        latencyMs: b.health?.latencyMs ?? b.latencyMs ?? null,
        source: 'registry',
      };
    }
    registryCache = { fetchedAt: Date.now(), profiles: fresh };
    return fresh;
  } catch (err) {
    console.warn('[registry] fetch failed (non-fatal, using previous cache):', err.message);
    return registryCache.profiles;
  }
}

async function getMergedProfiles({ force = false } = {}) {
  const registryProfiles = await fetchRegistryProfiles({ force });
  // Static profiles are the fallback layer; registry entries win on name
  // collision since they carry live health data. Distinct slugs (e.g.
  // "default" vs. "kurtcagle-primary") simply appear as separate entries.
  return { ...profiles, ...registryProfiles };
}

// -- Active base URL resolution --------------------------------------------------
//
// PRIOR BUG (present through v1.10.0): every hb* HTTP helper below called the
// module-level HOLONBRIDGE_URL constant directly, ignoring activeProfile
// entirely. set_endpoint updated activeProfile, which only get_endpoint and
// list_endpoints ever read -- so switching profiles never actually redirected
// any query, push, or dataset call. This function is the single source of
// truth for "which bridge do we talk to right now," and every HTTP call
// below must go through it rather than referencing HOLONBRIDGE_URL directly.
//
// Synchronous by design: it reads whatever is already in `profiles` (static)
// and `registryCache.profiles` (last-fetched registry snapshot) without
// triggering a network call on every single query. set_endpoint forces a
// fresh registry pull *before* updating activeProfile, so by the time any
// subsequent call runs, the cache reflects the profile that was just chosen.

function activeBaseUrl() {
  const merged = { ...profiles, ...registryCache.profiles };
  return merged[activeProfile]?.url ?? HOLONBRIDGE_URL;
}

// -- MCP server factory --------------------------------------------------------------
//
// A fresh McpServer is created per /sse connection to avoid the SDK's
// single-transport restriction ("Already connected to a transport").

function createMcpServer(sessionId) {
  const srv = new McpServer({
    name: 'holonbridge-mcp-remote',
    version: '1.19.0',
  });

  srv.tool(
    'list_endpoints',
    'List all known HolonBridge profiles -- static .env profiles plus live results ' +
    'from the federated bridge registry (GET /registry), including reachability.',
    {},
    async () => {
      const merged = await getMergedProfiles();
      const lines = Object.entries(merged).map(([name, p]) => {
        const marker  = name === activeProfile ? '* ' : '  ';
        const health  = p.reachable === true ? ' OK reachable'
                       : p.reachable === false ? ' X unreachable'
                       : '';
        const latency = p.latencyMs != null ? ` (${p.latencyMs}ms)` : '';
        const src     = p.source === 'registry' ? ' [registry]' : ' [static]';
        return `${marker}${name}: ${p.url} (${p.label})${health}${latency}${src}`;
      });
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  srv.tool('get_endpoint', 'Show the currently active HolonBridge profile.', {}, async () => {
    const merged = await getMergedProfiles();
    const p = merged[activeProfile];
    return {
      content: [{
        type: 'text',
        text: `Active profile: ${activeProfile} -> ${p?.url ?? 'unknown (profile no longer present)'}`,
      }],
    };
  });

  srv.tool(
    'set_endpoint',
    'Switch the active HolonBridge profile by name -- static config or any bridge ' +
    'currently in the live federation registry.',
    { name: z.string().describe('Profile name from list_endpoints') },
    async ({ name }) => {
      // Force a fresh registry pull so a bridge registered moments ago is
      // switchable immediately, without waiting out the cache window.
      const merged = await getMergedProfiles({ force: true });
      if (!merged[name]) {
        return {
          content: [{
            type: 'text',
            text: `Unknown profile "${name}". Available: ${Object.keys(merged).join(', ')}`,
          }],
        };
      }
      activeProfile = name;
      return { content: [{ type: 'text', text: `Switched to profile "${name}" -> ${merged[name].url}` }] };
    }
  );

  srv.tool(
    'sparql_select',
    'Execute a SPARQL SELECT or ASK query. Returns JSON bindings.',
    {
      query: z.string().describe('SPARQL SELECT or ASK query string'),
      graph: z.string().optional().describe('Restrict to this named graph IRI'),
    },
    async ({ query, graph }) => {
      requireReadAccess();
      const q = graph
        ? `SELECT * WHERE { GRAPH <${graph}> { ${query.replace(/^SELECT.*?WHERE\s*\{/is, '')}` // naive wrap
        : query;
      const results = await hbQuery(q, 'select');
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );

  srv.tool(
    'sparql_construct',
    'Execute a SPARQL CONSTRUCT or DESCRIBE query. Returns Turtle.',
    { query: z.string().describe('SPARQL CONSTRUCT or DESCRIBE query string') },
    async ({ query }) => {
      requireReadAccess();
      const turtle = await hbQuery(query, 'construct');
      return { content: [{ type: 'text', text: turtle }] };
    }
  );

  srv.tool(
    'sparql_update',
    'Execute a SPARQL UPDATE (INSERT DATA, DELETE DATA, CLEAR, etc.).',
    { update: z.string().describe('SPARQL UPDATE statement') },
    async ({ update }) => {
      requireWriteAccess();
      const result = await hbUpdate(update);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  srv.tool(
    'push_turtle',
    'Push Turtle content into a named graph via HolonBridge REST (/update). ' +
    'Defaults to append mode (POST/merge into existing graph). ' +
    'Use mode="replace" to overwrite the entire named graph. ' +
    'Optionally validates against a SHACL shapes graph before pushing.',
    {
      turtle:       z.string().describe('Valid Turtle 1.1/1.2 payload'),
      graph_iri:    z.string().describe('Target named graph IRI'),
      shapes_graph: z.string().optional().describe('SHACL shapes graph IRI for pre-push validation'),
      mode:         z.enum(['append', 'replace']).optional()
                     .describe('Write mode: append (default -- merges) or replace (overwrites the entire graph)'),
    },
    async ({ turtle, graph_iri, shapes_graph, mode = 'append' }) => {
      requireWriteAccess();
      const result = await hbPushTurtle(turtle, graph_iri, shapes_graph, mode);
      return { content: [{ type: 'text', text: result }] };
    }
  );

  srv.tool(
    'get_holon',
    'Retrieve a holon from Fuseki and return it as a DataBook.',
    {
      holon_iri:       z.string().describe('IRI of the target holon'),
      projection_mode: z.enum(['immersive', 'cinematic', 'active_inference', 'exploded_view'])
                        .optional()
                        .describe('Projection mode (default: immersive)'),
    },
    async ({ holon_iri, projection_mode }) => {
      requireReadAccess();
      const databook = await hbGetHolon(holon_iri, projection_mode);
      return { content: [{ type: 'text', text: databook }] };
    }
  );

  srv.tool(
    'propose_property_update',
    'Propose, validate, and (if valid) apply a delta to a numeric agent property -- ' +
    'e.g. https://schema.org/healthPoints or https://schema.org/currentWealth -- via ' +
    "HolonBridge's proposeAgentPropertyUpdate lifecycle verb (POST /holon/:iri/property). " +
    "Validated against the property's governing SHACL shape (e.g. AgentHealthShape, " +
    'AgentWealthShape) BEFORE anything is written -- a rejected proposal throws with no ' +
    'trace left in either the holons or events graph. On success, writes a ' +
    'holon:ModelUpdateRequest + holon:ModelUpdateApprove event pair plus the new value ' +
    'on the agent. Pass cap_property (e.g. maxHealthPoints) to cap the result at another ' +
    "property's current value, mirroring the existing healthPoints capping behaviour. " +
    'The acting actor is your own logged-in identity -- not a parameter you supply.',
    {
      agent_iri:    z.string().describe('IRI of the agent whose property is changing'),
      property:     z.string().describe('Full IRI of the numeric property, e.g. https://schema.org/currentWealth'),
      delta:        z.number().describe('Signed amount to add (negative to subtract/spend)'),
      rationale:    z.string().describe('Short human-readable reason for this change'),
      cap_property: z.string().optional().describe('Optional IRI of a property to cap the result at, e.g. https://schema.org/maxHealthPoints'),
      floor:        z.number().optional().describe('Optional floor for the result (default 0)'),
    },
    async ({ agent_iri, property, delta, rationale, cap_property, floor }) => {
      requireWriteAccess();
      const result = await hbProposePropertyUpdate(agent_iri, property, delta, rationale, cap_property, floor);
      return { content: [{ type: 'text', text: result }] };
    }
  );

  srv.tool(
    'create_agent',
    "Mint a new Agent holon via HolonBridge's createAgent lifecycle verb (POST /agent). " +
    'Writes a holon:CreationEvent plus one holon:PropertyBaselineEvent per trackable ' +
    "property, closing the provenance gap where an agent's starting healthPoints/" +
    'currentWealth would otherwise be asserted as bare triples with no event-graph record. ' +
    "Each trackable property's governing shape/capProperty/floor resolves from ontology " +
    'metadata (holon:governedByShape/holon:capProperty/holon:floor) unless overridden ' +
    'per-property. A single baseline that violates its shape rejects the ENTIRE creation ' +
    '(no partial agent). extra_turtle is for static, non-tracked properties (species, ' +
    'gender, currentLocation, etc.) that do not need baseline events -- append raw Turtle ' +
    'triples with <agent_iri> as the implied subject. The acting actor is your own ' +
    'logged-in identity -- not a parameter you supply.',
    {
      agent_iri:  z.string().describe('IRI for the new agent'),
      label:      z.string().describe('rdfs:label for the agent, e.g. "Lina"'),
      agent_kind: z.string().describe('holon:agentKind value, e.g. "npc" or "player"'),
      description: z.string().optional().describe('Optional holon:description for the agent'),
      extra_turtle: z.string().optional().describe('Optional raw Turtle for static, non-tracked properties on the agent'),
      trackable_properties: z.array(z.object({
        property:     z.string().describe('Full IRI of the trackable property, e.g. https://schema.org/currentWealth'),
        value:        z.number().describe('Baseline value'),
        cap_property: z.string().optional().describe('Override the ontology-declared cap property'),
        cap_value:    z.number().optional().describe("The cap property's own starting value (e.g. maxHealthPoints), required if this property has a capProperty"),
        floor:        z.number().optional().describe('Override the ontology-declared floor'),
      })).optional().describe('Baseline values for trackable properties (e.g. healthPoints, currentWealth)'),
    },
    async ({ agent_iri, label, agent_kind, description, extra_turtle, trackable_properties }) => {
      requireWriteAccess();
      const mapped = trackable_properties?.map(tp => ({
        property: tp.property,
        value: tp.value,
        ...(tp.cap_property !== undefined ? { capProperty: tp.cap_property } : {}),
        ...(tp.cap_value !== undefined ? { capValue: tp.cap_value } : {}),
        ...(tp.floor !== undefined ? { floor: tp.floor } : {}),
      }));
      const result = await hbCreateAgent(agent_iri, label, agent_kind, description, extra_turtle, mapped);
      return { content: [{ type: 'text', text: result }] };
    }
  );

  srv.tool(
    'navigate_agent',
    "Move an agent to a new holon via HolonBridge's navigateAgent lifecycle verb " +
    '(POST /holon/:iri/navigate). Writes a holon:VisitEvent chained via holon:nextVisit ' +
    "from the agent's current visit-chain tail, then updates holon:currentLocation to " +
    'match. destination_iri must already exist as a holon on the HolonBridge side -- a ' +
    'dangling destination is refused rather than leaving the agent pointed at nothing. ' +
    'Self-service when your logged-in identity equals agent_iri (moving yourself); Write ' +
    "on the dataset anchor is required to move an agent other than yourself. The acting " +
    'actor is your own logged-in identity -- not a parameter you supply. Third lifecycle ' +
    'verb exposed through this MCP remote, after propose_property_update and create_agent.',
    {
      agent_iri:       z.string().describe('IRI of the agent being moved'),
      destination_iri: z.string().describe('IRI of the holon the agent is moving to -- must already exist'),
      note:            z.string().optional().describe('Optional short note recorded on the VisitEvent'),
    },
    async ({ agent_iri, destination_iri, note }) => {
      requireWriteAccess();
      const result = await hbNavigateAgent(agent_iri, destination_iri, note);
      return { content: [{ type: 'text', text: result }] };
    }
  );

  srv.tool(
    'list_graphs',
    'List all named graphs in the Fuseki dataset with triple counts.',
    { filter: z.string().optional().describe('Substring filter on graph IRI') },
    async ({ filter }) => {
      requireReadAccess();
      const graphs = await hbListGraphs(filter);
      const lines = graphs.map(g => `<${g.iri}>  (${g.triples} triples)`);
      return {
        content: [{
          type: 'text',
          text: lines.length ? lines.join('\n') : 'No graphs found.',
        }],
      };
    }
  );

  srv.tool(
    'validate_turtle',
    'Validate a Turtle payload against a SHACL shapes graph.',
    {
      turtle:       z.string().describe('Turtle payload to validate'),
      shapes_graph: z.string().describe('IRI of the SHACL shapes graph in Fuseki'),
    },
    async ({ turtle, shapes_graph }) => {
      requireReadAccess();
      const report = await hbValidate(turtle, shapes_graph);
      return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
    }
  );

  srv.tool(
    'nl_query',
    'Query the triplestore using natural language. HolonBridge translates to SPARQL.',
    {
      question: z.string().describe('Natural language question about the graph data'),
      graph:    z.string().optional().describe('Restrict to this named graph IRI'),
    },
    async ({ question, graph }) => {
      requireReadAccess();
      const result = await hbNlQuery(question, graph);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  srv.tool(
    'list_datasets',
    'List all Fuseki datasets available on this HolonBridge instance, plus which ' +
    'one YOUR session is currently using (see switch_dataset).',
    {},
    async () => {
      const res = await fetch(`${activeBaseUrl()}/datasets`, {
        headers: hbHeaders({ Accept: 'application/json' }),
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(`HolonBridge /datasets: HTTP ${res.status} -- ${msg.slice(0, 200)}`);
      }
      const result = await res.json();
      // Annotate each dataset with the current actor's access level
      const login = requestContext.getStore()?.githubLogin;
      if (datasetAcl && result.datasets) {
        for (const ds of result.datasets) {
          ds.yourAccess = resolveDatasetAccess(login, ds.name);
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify({ ...result, yourActiveDataset: currentDataset() ?? DEFAULT_DATASET }, null, 2) }] };
    }
  );

  srv.tool(
    'list_dataset_acls',
    'List the full multi-user per-dataset access-control table -- which actors ' +
    '(GitHub logins) have read or read-write access to which Fuseki dataset, ' +
    'straight from .dataset-acl.json, merged against the live dataset list so ' +
    'datasets with no explicit ACL entry (falling back to defaultAccess) are ' +
    "also visible. Unlike list_datasets (which only ever reports the calling " +
    "actor's own access), this exposes every other actor's grants too -- " +
    'restricted to the bridge operator.',
    {},
    async () => {
      const login = requestContext.getStore()?.githubLogin;
      if ((login ?? '').toLowerCase() !== 'kurtcagle') {
        throw new Error(`Access denied: the dataset ACL table is only visible to the bridge operator (actor: ${login ?? 'unknown'}).`);
      }
      if (!datasetAcl) {
        return {
          content: [{
            type: 'text',
            text: 'No .dataset-acl.json is loaded on this bridge -- access is currently unrestricted for every dataset (permissive fallback).',
          }],
        };
      }
      // Merge against the live dataset list so datasets with no explicit
      // ACL entry (falling back to defaultAccess) are visible too, not just
      // the ones named in the ACL file -- the file can drift out of sync
      // with what Fuseki actually has.
      let liveDatasets = [];
      try {
        const res = await fetch(`${activeBaseUrl()}/datasets`, {
          headers: hbHeaders({ Accept: 'application/json' }),
        });
        if (res.ok) {
          const j = await res.json();
          liveDatasets = (j.datasets ?? []).map(d => d.name);
        }
      } catch {
        // Best-effort; fall back to the ACL-file-only view below.
      }

      const allNames = new Set([...Object.keys(datasetAcl.datasets ?? {}), ...liveDatasets]);
      const table = [...allNames].sort().map(name => {
        const entry = datasetAcl.datasets?.[name];
        return {
          dataset: name,
          inAclFile: !!entry,
          grants: entry ?? { '(no explicit entry -- falls back to defaultAccess)': datasetAcl.defaultAccess ?? 'none' },
        };
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ defaultAccess: datasetAcl.defaultAccess ?? 'none', datasets: table }, null, 2),
        }],
      };
    }
  );

  srv.tool(
    'switch_dataset',
    'Switch YOUR active Fuseki dataset. Sticky per actor -- persists across ' +
    'reconnects and restarts (stored locally by this MCP remote, keyed by your ' +
    "logged-in identity), and does NOT affect any other connected user's dataset " +
    "selection. Unlike versions before v1.16.0, this no longer calls HolonBridge's " +
    'global POST /dataset at all -- your preference is tracked here and sent as a ' +
    'per-request header (X-Dataset-Override) on every outbound call.',
    { dataset: z.string().describe('Fuseki dataset name (e.g. "chloe", "ds", "storme")') },
    async ({ dataset }) => {
      const actorIri = currentActorIri();
      if (!actorIri) throw new Error('No authenticated actor identity on this session -- log in again.');
      // ACL gate: refuse switching to a dataset the actor can't access at all
      const login = requestContext.getStore()?.githubLogin;
      const access = resolveDatasetAccess(login, dataset);
      if (access === 'none') {
        throw new Error(`Access denied: you (${login ?? 'unknown'}) do not have access to dataset "${dataset}". Ask the bridge operator to add you to .dataset-acl.json.`);
      }
      setActorDataset(actorIri, dataset);
      // Also update the live session so subsequent calls in THIS connection
      // immediately reflect the switch without needing a reconnect.
      const session = sessions.get(sessionId);
      if (session) session.dataset = dataset;
      activeFusekiDataset = dataset;  // keep health reporting current
      return { content: [{ type: 'text', text: `Switched your active dataset to "${dataset}" (sticky -- will persist across reconnects and restarts). Other connected users are unaffected.` }] };
    }
  );

  return srv;
}

// -- Express app -------------------------------------------------------------------

const app = express();

app.use(cors({
  origin: ['https://claude.ai', 'https://api.claude.ai'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'Accept'],
  credentials: false,
}));
app.options('*', cors());

// express.json() intentionally omitted -- /message uses the raw request stream
// via SSEServerTransport.handlePostMessage; parsing the body here would consume
// the stream before the transport can read it, causing 400 errors.

// -- GitHub OAuth + JWT identity implementation ---------------------------------------
//
// Replaces the pre-v1.15.0 shim, which accepted any authorization code or
// client_credentials grant and handed back the same static MCP_REMOTE_TOKEN
// regardless of who -- or whether anyone -- was actually asking. This is a
// real login: /authorize now sends the browser to GitHub, /oauth/github/callback
// verifies the person's GitHub login is on GITHUB_ALLOWED_USERS and mints a
// signed per-user JWT (see signJwt/verifyJwt above), and /token exchanges the
// one-time code from that callback for the JWT. requireAuth below verifies
// that JWT (or, as a legacy fallback, the static MCP_REMOTE_TOKEN, mapped to
// SERVICE_ACTOR_IRI) and resolves the caller's identity once per /sse
// connection -- see the /sse handler and currentActorIri() above for how
// that identity then reaches every lifecycle-verb tool call without the
// caller ever supplying it themselves.
//
// v1.15.1 note: v1.15.0 originally gated access on GitHub Organization
// membership (GET /user/memberships/orgs/:org). That endpoint only exists
// for actual Organizations -- a personal GitHub account (which is what most
// solo/small-team setups, this one included, actually run out of) has no
// memberships to check, so the org-membership call 404s unconditionally
// regardless of who's logging in. Replaced with a static allowlist
// (GITHUB_ALLOWED_USERS) checked locally against the authenticated login --
// works identically whether the account is personal or a real org, needs no
// GitHub scope at all (dropped 'read:org'), and matches what was actually
// asked for: a closed list of specific people, not org-wide membership.
//
// PKCE note: the advertised token_endpoint_auth_methods_supported includes
// 'none' (implying PKCE for public clients per spec), but code_verifier is
// not currently checked against a stored code_challenge -- this carries
// forward a gap that predates this change (the old shim didn't check it
// either) rather than introducing a new one. Worth closing before this is
// exposed beyond a small trusted group, but out of scope for the identity
// substitution this version is about.

const MCP_PUBLIC_URL = process.env.MCP_PUBLIC_URL || 'https://kurtcagle-mcp.ngrok.io';
const GITHUB_CALLBACK_URL = `${MCP_PUBLIC_URL}/oauth/github/callback`;

const registeredClients = new Map();

// pendingAuthFlows: our own flowId -> the ORIGINAL client's redirect_uri/state/
// client_id, captured at /authorize before we ever hand off to GitHub. GitHub's
// own `state` query param carries this flowId through its redirect so we can
// recover the original client's request once the person is back from GitHub.
const pendingAuthFlows = new Map();

// authCodes: our own one-time code (handed to the ORIGINAL client's
// redirect_uri after a successful GitHub login) -> the resolved identity
// (actorIri, githubLogin, name) that /token exchanges for a signed JWT.
const authCodes = new Map();

app.get('/.well-known/oauth-protected-resource', (req, res) => {
  console.log('[OAuth] GET /.well-known/oauth-protected-resource');
  res.json({
    resource:                 MCP_PUBLIC_URL,
    authorization_servers:    [MCP_PUBLIC_URL],
    bearer_methods_supported: ['header'],
  });
});

app.get('/.well-known/oauth-protected-resource/sse', (req, res) => {
  console.log('[OAuth] GET /.well-known/oauth-protected-resource/sse');
  res.json({
    resource:                 MCP_PUBLIC_URL,
    authorization_servers:    [MCP_PUBLIC_URL],
    bearer_methods_supported: ['header'],
  });
});

app.get('/.well-known/oauth-authorization-server', (req, res) => {
  console.log('[OAuth] GET /.well-known/oauth-authorization-server');
  res.json({
    issuer:                                MCP_PUBLIC_URL,
    authorization_endpoint:                `${MCP_PUBLIC_URL}/authorize`,
    token_endpoint:                        `${MCP_PUBLIC_URL}/token`,
    registration_endpoint:                 `${MCP_PUBLIC_URL}/register`,
    grant_types_supported:                 ['authorization_code'],
    response_types_supported:              ['code'],
    code_challenge_methods_supported:      ['S256', 'plain'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
  });
});

app.post('/register', express.json(), (req, res) => {
  console.log('[OAuth] POST /register body:', JSON.stringify(req.body));
  const client_id     = randomUUID();
  const client_secret = randomUUID();
  registeredClients.set(client_id, { ...(req.body ?? {}), client_id, client_secret });
  res.status(201).json({
    client_id,
    client_secret,
    client_id_issued_at:      Math.floor(Date.now() / 1000),
    client_secret_expires_at: 0,
    ...(req.body ?? {}),
  });
});

// GET /authorize -- entry point for the OAuth dance. Stashes the ORIGINAL
// client's redirect_uri/state/client_id under a fresh flowId, then sends the
// browser to GitHub's own authorize endpoint with that flowId riding in
// GitHub's `state` param (GitHub echoes state back verbatim on its own
// redirect, which is how we recover the original request in the callback
// below -- our flowId and the client's own `state` are different things
// living in different places for exactly this reason).
app.get('/authorize', (req, res) => {
  console.log('[OAuth] GET /authorize query:', JSON.stringify(req.query));
  const { redirect_uri, state, client_id } = req.query;
  if (!redirect_uri) {
    return res.status(400).json({ error: 'redirect_uri is required' });
  }

  const flowId = randomUUID();
  pendingAuthFlows.set(flowId, { redirect_uri, state, client_id, createdAt: Date.now() });
  setTimeout(() => pendingAuthFlows.delete(flowId), 10 * 60 * 1000);

  const githubUrl = new URL('https://github.com/login/oauth/authorize');
  githubUrl.searchParams.set('client_id', GITHUB_CLIENT_ID);
  githubUrl.searchParams.set('redirect_uri', GITHUB_CALLBACK_URL);
  githubUrl.searchParams.set('state', flowId);

  console.log(`[OAuth] Redirecting to GitHub for login (flowId=${flowId})`);
  return res.redirect(githubUrl.toString());
});

// GET /oauth/github/callback -- GitHub sends the person back here after they
// approve (or deny) the login. Exchanges the GitHub code for a GitHub access
// token, fetches identity with it, and -- only if their GitHub login is on
// GITHUB_ALLOWED_USERS -- mints our own one-time code and hands them back
// to the ORIGINAL client's redirect_uri from the pending flow. Anyone not
// on the allowlist is rejected here, before any code or token exists for
// them at all.
app.get('/oauth/github/callback', async (req, res) => {
  const { code, state: flowId, error: githubError } = req.query;

  if (githubError) {
    console.warn(`[OAuth] GitHub returned an error: ${githubError}`);
    return res.status(400).send(`GitHub login failed: ${githubError}`);
  }
  if (!code || !flowId || !pendingAuthFlows.has(flowId)) {
    return res.status(400).send('Invalid or expired login attempt -- please try logging in again.');
  }

  const flow = pendingAuthFlows.get(flowId);
  pendingAuthFlows.delete(flowId);

  try {
    // Exchange the GitHub code for a GitHub access token.
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: GITHUB_CALLBACK_URL,
      }),
    });
    const tokenJson = await tokenRes.json();
    if (!tokenJson.access_token) {
      console.warn('[OAuth] GitHub token exchange failed:', JSON.stringify(tokenJson));
      return res.status(502).send('GitHub login failed during token exchange.');
    }
    const githubAccessToken = tokenJson.access_token;

    // Who is this?
    const userRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${githubAccessToken}`, Accept: 'application/vnd.github+json' },
    });
    if (!userRes.ok) {
      console.warn(`[OAuth] GitHub /user returned HTTP ${userRes.status}`);
      return res.status(502).send('GitHub login failed while fetching identity.');
    }
    const githubUser = await userRes.json();
    const githubLogin = githubUser.login;

    // Are they on the allowlist? Case-insensitive against GITHUB_ALLOWED_USERS.
    // No GitHub API call needed here -- unlike org membership, this is a
    // local check against config this process already has, so it can't
    // fail due to the account in question not being an Organization.
    if (!ALLOWED_GITHUB_LOGINS.has(githubLogin.toLowerCase())) {
      console.warn(`[OAuth] ${githubLogin} authenticated with GitHub but is not on the allowlist`);
      return res.status(403).send(`Access denied -- ${githubLogin} is not on the allowed users list.`);
    }

    // Identity confirmed. Mint our own one-time code and send the person
    // back to wherever they actually started (the original client's
    // redirect_uri), carrying the client's OWN state -- not our flowId,
    // which has already served its purpose and is discarded above.
    const actorIri = `https://w3id.org/users/${githubLogin}`;
    const ourCode = randomUUID();
    authCodes.set(ourCode, { actorIri, githubLogin, name: githubUser.name ?? githubLogin });
    setTimeout(() => authCodes.delete(ourCode), 5 * 60 * 1000);

    console.log(`[OAuth] ${githubLogin} (${actorIri}) authenticated -- issuing code for ${flow.redirect_uri}`);

    const redirectUrl = new URL(flow.redirect_uri);
    redirectUrl.searchParams.set('code', ourCode);
    if (flow.state) redirectUrl.searchParams.set('state', flow.state);
    return res.redirect(redirectUrl.toString());

  } catch (err) {
    console.error('[OAuth] /oauth/github/callback error:', err.message);
    return res.status(500).send('GitHub login failed unexpectedly. Please try again.');
  }
});

app.post('/token', express.urlencoded({ extended: false }), express.json(), (req, res) => {
  console.log('[OAuth] POST /token body:', JSON.stringify(req.body));
  const { grant_type, code } = req.body ?? {};

  if (grant_type === 'authorization_code') {
    if (!code || !authCodes.has(code)) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Unknown or expired code.' });
    }
    const { actorIri, githubLogin, name } = authCodes.get(code);
    authCodes.delete(code); // one-time use
    const accessToken = signJwt({ sub: actorIri, githubLogin, name }, JWT_SECRET, JWT_EXPIRES_IN_SECONDS);
    return res.json({ access_token: accessToken, token_type: 'Bearer', expires_in: JWT_EXPIRES_IN_SECONDS });
  }

  // client_credentials (no interactive user) is no longer supported as a
  // primary path -- GitHub login requires a person in the loop by design.
  // Legacy automation should use the static MCP_REMOTE_TOKEN directly as a
  // Bearer header (see requireAuth below) rather than exchanging it here.
  return res.status(400).json({
    error: 'unsupported_grant_type',
    error_description: 'Only authorization_code (GitHub login) is supported. ' +
      'For non-interactive automation, use the static MCP_REMOTE_TOKEN as a Bearer header directly.',
  });
});

app.get('/favicon.ico', (_req, res) => res.status(204).end());

// -- Bearer auth middleware (applied to all remaining routes) ----------------------------
//
// Accepts either a valid signed JWT (the normal path, from a completed
// GitHub login -- see /token above) or, as a legacy fallback, an exact
// match against the static MCP_REMOTE_TOKEN if one is configured. The JWT
// path resolves req.actorIri to the real person who logged in; the legacy
// path resolves it to the single shared SERVICE_ACTOR_IRI, same ambiguity
// as every call before this version. New interactive callers should always
// end up on the JWT path via the GitHub flow above.

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized -- missing Bearer token' });
  }
  const token = auth.slice(7);

  const jwtPayload = verifyJwt(token, JWT_SECRET);
  if (jwtPayload) {
    req.actorIri = jwtPayload.sub;
    req.githubLogin = jwtPayload.githubLogin;
    return next();
  }

  if (MCP_REMOTE_TOKEN && token === MCP_REMOTE_TOKEN) {
    req.actorIri = SERVICE_ACTOR_IRI;
    req.githubLogin = null;
    return next();
  }

  return res.status(401).json({ error: 'Unauthorized -- invalid or expired token' });
}

app.use(requireAuth);

const sessions = new Map();

app.get('/sse', async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');

  const transport = new SSEServerTransport('/message', res);
  const sessionId = transport.sessionId;
  const srv = createMcpServer(sessionId);

  // actorIri is resolved once here, at connection time, from the Bearer
  // token requireAuth already verified -- everything this session's tool
  // calls do downstream reads it back via currentActorIri(), never from a
  // client-supplied parameter. dataset is resolved from the persisted
  // per-actor preference (see setActorDataset / getActorDataset above),
  // defaulting to DEFAULT_DATASET for first-time users.
  const dataset = getActorDataset(req.actorIri);
  sessions.set(sessionId, { server: srv, transport, actorIri: req.actorIri, githubLogin: req.githubLogin, dataset });

  res.on('close', () => {
    sessions.delete(sessionId);
    srv.close().catch(() => {});
  });

  await srv.connect(transport);
});

app.post('/message', async (req, res) => {
  const sessionId = req.query.sessionId;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: `No active session: ${sessionId}` });
  }

  const reqId = randomUUID();
  await requestContext.run({ reqId, actorIri: session.actorIri, githubLogin: session.githubLogin, dataset: session.dataset }, () =>
    timedProcess(`MCP tool call (session=${sessionId}, actor=${session.githubLogin ?? 'service'}, dataset=${session.dataset}) [reqId=${reqId}]`, () =>
      session.transport.handlePostMessage(req, res, req.body)
    )
  );
});

app.get('/health', async (_req, res) => {
  const merged = await getMergedProfiles();
  res.json({
    status: 'ok',
    server: 'holonbridge-mcp-remote',
    version: '1.19.0',
    holonbridge: HOLONBRIDGE_URL,
    activeBridge: activeBaseUrl(),
    jenaBase,
    fusekiGspDataset: activeFusekiDataset,
    fusekiGspEndpoint: `${jenaBase}/${activeFusekiDataset}/data`,
    profiles: Object.keys(merged),
    activeProfile,
    activeSessions: sessions.size,
  });
});

app.listen(parseInt(MCP_PORT), () => {
  console.log(`holonbridge-mcp-remote v1.19.0 listening on :${MCP_PORT}`);
  console.log(`  HolonBridge target  : ${HOLONBRIDGE_URL}`);
  console.log(`  Jena base           : ${jenaBase}`);
  console.log(`  Active GSP dataset  : ${activeFusekiDataset}`);
  console.log(`  Static profiles     : ${Object.keys(profiles).join(', ')}`);
  console.log(`  Registry-backed     : fetched on demand from ${HOLONBRIDGE_URL}/registry (cached ${REGISTRY_CACHE_MAX_AGE_MS / 1000}s)`);
  console.log(`  SSE endpoint        : http://localhost:${MCP_PORT}/sse`);
  console.log(`  Health              : http://localhost:${MCP_PORT}/health`);
});
