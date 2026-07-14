/**
 * admin.js -- Administration endpoint for holonbridge-mcp-remote (v1.20.0+)
 *
 * Adds an HTML admin console and a small /admin/api surface for managing
 * .dataset-acl.json, gated on the operator's GitHub identity and validated
 * against SHACL shapes in Fuseki (via HolonBridge) before anything is
 * written to disk.
 *
 * Why this lives in mcp-remote and not HolonBridge server.js
 * ----------------------------------------------------------
 * Identity lives here. server.js authenticates one shared HB_BEARER_TOKEN
 * and has no concept of *who* is calling; this process resolves a per-user
 * GitHub login via OAuth + JWT (see requireAuth in holonbridge-mcp-remote.js)
 * and owns both .dataset-acl.json and resolveDatasetAccess(). An admin gate
 * keyed on a person therefore has exactly one natural home: here.
 *
 * Validation pipeline for a PUT (validate-then-write)
 * ---------------------------------------------------
 *   1. Structural precheck of the JSON body (cheap, catches shape-of-JSON
 *      errors before any network call).
 *   2. Project JSON -> Turtle (aclToTurtle) using the hb: ACL vocabulary.
 *   3. Push to a short-lived temp graph via HolonBridge /update, call
 *      POST /validate { dataGraph: temp, shapesGraph: urn:admin:acl-shapes },
 *      drop the temp graph -- the same temp-graph pattern hbValidate()
 *      adopted in v1.10.2, reimplemented here so this module has no import
 *      coupling to the main file.
 *   4. conforms:false -> 422 with the full violation list; nothing written.
 *   5. conforms:true  -> replace urn:admin:acl in Fuseki with the conforming
 *      table (audit/current-state graph, SPARQL-queryable), then write
 *      .dataset-acl.json atomically (temp file + rename).
 *
 * Restart semantics (v1.19.0 interaction -- deliberate)
 * -----------------------------------------------------
 * holonbridge-mcp-remote.js watches .dataset-acl.json and exits (debounced
 * 500ms) when it changes, expecting a process supervisor to restart it with
 * fresh config. Step 5's write therefore *is* the reload mechanism: the 200
 * response flushes immediately, the watcher fires, the process exits, the
 * supervisor brings it back with the new ACL loaded. Active SSE sessions
 * drop and reconnect. The response body carries restartScheduled:true so
 * the console can tell the operator what's about to happen. If this process
 * is ever run bare (no NSSM/pm2/systemd), a successful ACL save kills it
 * permanently -- same caveat as v1.19.0 itself.
 *
 * Wiring (holonbridge-mcp-remote.js)
 * ----------------------------------
 *   import { registerAdmin } from './admin.js';
 *   // AFTER the OAuth routes are registered, BEFORE app.use(requireAuth):
 *   registerAdmin(app, {
 *     requireAuth,                 // the existing middleware -- reused per-route
 *     aclFilePath: DATASET_ACL_FILE,
 *     holonbridgeUrl: () => activeBaseUrl(),   // or () => HOLONBRIDGE_URL to pin admin ops to the local bridge
 *     hbBearerToken: HB_BEARER_TOKEN,
 *   });
 *
 * Placement matters: GET /admin serves the HTML shell unauthenticated (a
 * browser's first hit has no Bearer header -- the page performs the OAuth
 * dance itself against the /authorize + /token routes that already exist),
 * while every /admin/api route applies requireAuth + requireOperator
 * explicitly. Registering the whole module before app.use(requireAuth)
 * keeps that split unambiguous. CORS is a non-issue: the console is served
 * from the same origin it calls.
 *
 * Environment
 * -----------
 *   ADMIN_OPERATORS=kurtcagle        # comma-separated GitHub logins allowed
 *                                    # into /admin/api. Defaults to "kurtcagle"
 *                                    # to match list_dataset_acls' existing
 *                                    # hardcoded check -- which should migrate
 *                                    # to isOperator() from this module so the
 *                                    # operator set is defined once.
 */

import express from 'express';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// NOTE: holonbridge-mcp-remote.js deliberately has no global express.json()
// (removed in v1.2 -- it broke SSE handlePostMessage). Body parsing is
// therefore applied per-route below, never app-wide.
const jsonBody = express.json({ limit: '1mb' });

const __dirname = dirname(fileURLToPath(import.meta.url));

const SHAPES_GRAPH = 'urn:admin:acl-shapes';
const ACL_GRAPH    = 'urn:admin:acl';
const TABLE_IRI    = 'urn:admin:acl:table';
const HB           = 'https://w3id.org/holonbridge/';

const ACCESS_LEVELS = new Set(['none', 'r', 'rw']);
const DATASET_RE    = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const LOGIN_RE      = /^(\*|[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?)$/;

const OPERATORS = new Set(
  (process.env.ADMIN_OPERATORS ?? 'kurtcagle')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);

/** Is this GitHub login a bridge operator? Exported so list_dataset_acls
 *  can share the definition instead of hardcoding 'kurtcagle'. */
export function isOperator(githubLogin) {
  return OPERATORS.has((githubLogin ?? '').toLowerCase());
}

/**
 * Express middleware: require an operator identity. Assumes requireAuth has
 * already run and set req.githubLogin. Deliberately rejects the legacy
 * MCP_REMOTE_TOKEN path (githubLogin === null): the service account is a
 * process, not a person, and ACL edits need an accountable identity.
 */
export function requireOperator(req, res, next) {
  if (!req.githubLogin) {
    return res.status(403).json({
      error: 'Admin routes require a GitHub-authenticated person -- the service-account token is not accepted here.',
    });
  }
  if (!isOperator(req.githubLogin)) {
    return res.status(403).json({
      error: `Access denied: ${req.githubLogin} is not a bridge operator. Operators are set via ADMIN_OPERATORS.`,
    });
  }
  next();
}

// ---------------------------------------------------------------------------
// JSON <-> Turtle projection
// ---------------------------------------------------------------------------

function turtleEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function grantIri(dataset, login) {
  return `urn:admin:acl:grant:${encodeURIComponent(dataset)}:${encodeURIComponent(login)}`;
}

/**
 * Project the .dataset-acl.json structure into Turtle using the hb: ACL
 * vocabulary (see admin-acl-shapes.ttl). Logins are lowercased on the way
 * in -- resolveDatasetAccess() matches case-insensitively, so the stored
 * form may as well be canonical.
 */
export function aclToTurtle(acl) {
  const lines = [
    `@prefix hb: <${HB}> .`,
    '',
    `<${TABLE_IRI}> a hb:DatasetAclTable ;`,
    `    hb:defaultAccess "${turtleEscape(acl.defaultAccess ?? 'none')}"`,
  ];
  const grants = [];
  for (const [dataset, actorMap] of Object.entries(acl.datasets ?? {})) {
    for (const [login, level] of Object.entries(actorMap ?? {})) {
      grants.push({ dataset, login: login === '*' ? '*' : login.toLowerCase(), level });
    }
  }
  if (grants.length > 0) {
    lines[lines.length - 1] += ' ;';
    lines.push(`    hb:grant ${grants.map(g => `<${grantIri(g.dataset, g.login)}>`).join(' ,\n             ')} .`);
  } else {
    lines[lines.length - 1] += ' .';
  }
  for (const g of grants) {
    lines.push('');
    lines.push(`<${grantIri(g.dataset, g.login)}> a hb:AccessGrant ;`);
    lines.push(`    hb:dataset     "${turtleEscape(g.dataset)}" ;`);
    lines.push(`    hb:actorLogin  "${turtleEscape(g.login)}" ;`);
    lines.push(`    hb:accessLevel "${turtleEscape(g.level)}" .`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Cheap structural precheck before any network round-trip. Returns an array
 * of problem strings (empty = structurally sound). The SHACL pass remains
 * authoritative -- this exists so a malformed body fails in microseconds
 * with a targeted message instead of a generic Turtle parse error.
 */
export function precheckAcl(acl) {
  const problems = [];
  if (acl === null || typeof acl !== 'object' || Array.isArray(acl)) {
    return ['Body must be a JSON object: { defaultAccess, datasets }.'];
  }
  if (!ACCESS_LEVELS.has(acl.defaultAccess)) {
    problems.push(`defaultAccess must be one of none|r|rw (got: ${JSON.stringify(acl.defaultAccess)}).`);
  }
  if (acl.datasets === null || typeof acl.datasets !== 'object' || Array.isArray(acl.datasets)) {
    problems.push('"datasets" must be an object mapping dataset names to actor maps.');
    return problems;
  }
  for (const [dataset, actorMap] of Object.entries(acl.datasets)) {
    if (!DATASET_RE.test(dataset)) {
      problems.push(`Dataset name "${dataset}" is not a valid Fuseki dataset name.`);
    }
    if (actorMap === null || typeof actorMap !== 'object' || Array.isArray(actorMap)) {
      problems.push(`Dataset "${dataset}": actor map must be an object of login -> access.`);
      continue;
    }
    const seen = new Set();
    for (const [login, level] of Object.entries(actorMap)) {
      if (!LOGIN_RE.test(login)) {
        problems.push(`Dataset "${dataset}": "${login}" is not a valid GitHub login or "*".`);
      }
      const canon = login.toLowerCase();
      if (seen.has(canon)) {
        problems.push(`Dataset "${dataset}": duplicate actor "${login}" (case-insensitive collision).`);
      }
      seen.add(canon);
      if (!ACCESS_LEVELS.has(level)) {
        problems.push(`Dataset "${dataset}" / "${login}": access must be none|r|rw (got: ${JSON.stringify(level)}).`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the admin console and API on the given Express app.
 *
 * deps:
 *   requireAuth     -- the existing JWT/Bearer middleware from the main file
 *   aclFilePath     -- absolute path to .dataset-acl.json
 *   holonbridgeUrl  -- () => base URL of the bridge to validate/push through
 *   hbBearerToken   -- HB_BEARER_TOKEN (service-to-service secret)
 */
export function registerAdmin(app, { requireAuth, aclFilePath, holonbridgeUrl, hbBearerToken }) {

  const hbFetch = async (path, init = {}) => {
    const res = await fetch(`${holonbridgeUrl()}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${hbBearerToken}`,
        ...(init.headers ?? {}),
      },
    });
    return res;
  };

  const hbJson = async (path, init) => {
    const res = await hbFetch(path, init);
    const text = await res.text();
    if (!res.ok) throw new Error(`HolonBridge ${path}: HTTP ${res.status} -- ${text.slice(0, 300)}`);
    try { return JSON.parse(text); } catch { return text; }
  };

  /** Temp-graph SHACL validation of a Turtle payload (hbValidate pattern). */
  async function validateTurtle(turtle, shapesGraph) {
    const tempGraph = `urn:admin:validate-temp:${Date.now()}`;
    await hbJson('/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turtle, graph: tempGraph, mode: 'replace' }),
    });
    try {
      return await hbJson('/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ dataGraph: tempGraph, shapesGraph }),
      });
    } finally {
      await hbJson('/sparql-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ update: `DROP SILENT GRAPH <${tempGraph}>` }),
      }).catch(() => {});
    }
  }

  function readAclFile() {
    if (!existsSync(aclFilePath)) return null;
    return JSON.parse(readFileSync(aclFilePath, 'utf8'));
  }

  /** Atomic write: temp file + rename, so the v1.19.0 watcher sees exactly
   *  one complete file, never a half-written one. */
  function writeAclFile(acl) {
    const tmp = `${aclFilePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(acl, null, 2) + '\n');
    renameSync(tmp, aclFilePath);
  }

  // -- GET /admin -- HTML shell (unauthenticated; page does the OAuth dance) --

  app.get('/admin', (_req, res) => {
    res.type('html').send(readFileSync(join(__dirname, 'admin.html'), 'utf8'));
  });

  // -- GET /admin/api/acl -- current table + live dataset merge ----------------

  app.get('/admin/api/acl', requireAuth, requireOperator, async (_req, res) => {
    try {
      const acl = readAclFile();
      let liveDatasets = [];
      try {
        const j = await hbJson('/datasets', { headers: { Accept: 'application/json' } });
        liveDatasets = (j.datasets ?? []).map(d => d.name);
      } catch { /* best-effort -- ACL file view still useful with Fuseki down */ }
      return res.json({
        aclLoaded: acl !== null,
        defaultAccess: acl?.defaultAccess ?? null,
        datasets: acl?.datasets ?? {},
        liveDatasets,
        operators: [...OPERATORS],
        note: acl === null
          ? 'No .dataset-acl.json exists -- the bridge is running in permissive fallback (every dataset resolves to rw for every authenticated user). Saving from this console creates the file and ends permissive mode.'
          : null,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // -- PUT /admin/api/acl -- validate-then-write --------------------------------

  app.put('/admin/api/acl', jsonBody, requireAuth, requireOperator, async (req, res) => {
    const acl = req.body;

    const problems = precheckAcl(acl);
    if (problems.length > 0) {
      return res.status(400).json({ error: 'Structural precheck failed.', problems });
    }

    const turtle = aclToTurtle(acl);

    let report;
    try {
      report = await validateTurtle(turtle, SHAPES_GRAPH);
    } catch (err) {
      return res.status(502).json({
        error: `SHACL validation could not run: ${err.message}`,
        hint: `Are the shapes installed? POST /admin/api/shapes/install pushes admin-acl-shapes.ttl to <${SHAPES_GRAPH}>.`,
      });
    }

    if (report?.conforms === false) {
      return res.status(422).json({
        error: 'SHACL validation failed -- nothing written.',
        conforms: false,
        violations: report.violations ?? report.results ?? [],
        rawReport: report.rawReport ?? null,
      });
    }

    // Conforming: mirror to the audit graph, then write the file. Audit
    // failure is non-fatal (the JSON file is the enforcement artifact);
    // it is reported in the response instead of blocking the save.
    let auditWarning = null;
    try {
      await hbJson('/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ turtle, graph: ACL_GRAPH, mode: 'replace' }),
      });
    } catch (err) {
      auditWarning = `Audit graph <${ACL_GRAPH}> update failed (non-fatal): ${err.message}`;
    }

    try {
      writeAclFile(acl);
    } catch (err) {
      return res.status(500).json({ error: `ACL file write failed: ${err.message}` });
    }

    console.log(`[admin] ACL saved by ${req.githubLogin} -- ${Object.keys(acl.datasets).length} dataset(s). Restart imminent (v1.19.0 watcher).`);
    return res.json({
      ok: true,
      conforms: true,
      savedBy: req.githubLogin,
      restartScheduled: true,
      note: 'The config watcher will exit this process (~500ms) so the supervisor restarts it with the new ACL. Active MCP sessions will drop and reconnect.',
      ...(auditWarning ? { auditWarning } : {}),
    });
  });

  // -- POST /admin/api/shapes/install -- one-time shapes push -------------------

  app.post('/admin/api/shapes/install', requireAuth, requireOperator, async (_req, res) => {
    try {
      const shapes = readFileSync(join(__dirname, 'admin-acl-shapes.ttl'), 'utf8');
      await hbJson('/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ turtle: shapes, graph: SHAPES_GRAPH, mode: 'replace' }),
      });
      return res.json({ ok: true, shapesGraph: SHAPES_GRAPH });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // -- GET /admin/api/whoami -- lets the console show who is signed in ---------

  app.get('/admin/api/whoami', requireAuth, (req, res) => {
    res.json({
      githubLogin: req.githubLogin,
      actorIri: req.actorIri,
      operator: isOperator(req.githubLogin),
    });
  });

  console.log(`[admin] Console at /admin -- operators: ${[...OPERATORS].join(', ')}`);
}
