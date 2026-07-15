/**
 * scheduler-admin.js -- Administration endpoint for lib/scheduler.js,
 * wired into holonbridge-mcp-remote.js the same way admin.js is.
 *
 * Deliberately mirrors admin.js's structure and validate-then-write
 * discipline rather than inventing a new pattern:
 *   - Its own hbFetch/hbJson pinning X-Dataset-Override to
 *     SCHEDULER_DATASET on every call (same discipline as ADMIN_DATASET
 *     in admin.js -- see that file's header for why this is
 *     non-negotiable rather than cosmetic).
 *   - Whole-graph read-modify-write: GET returns the full Turtle of a
 *     scheduler graph (tasks or personas), PUT replaces it wholesale
 *     after SHACL validation, exactly like admin.js's ACL table GET/PUT.
 *     No partial per-subject editing -- an operator pastes/generates the
 *     full Turtle for the graph they're changing, the same shape of
 *     contract push_turtle already gives any MCP caller, just gated to
 *     operators and validated against PersonaShape/ScheduledTaskShape
 *     specifically rather than left to the caller's judgement.
 *   - requireOperator is imported from admin.js rather than redefined,
 *     so the operator set (ADMIN_OPERATORS) is one fact, not two.
 *
 * What this deliberately does NOT do
 * -----------------------------------
 * No "run task now" route. Actually firing a task requires reaching the
 * live Scheduler instance inside the HolonBridge server.js process --
 * that instance isn't reachable over HTTP today (lib/scheduler.js has no
 * server.js route calling scheduler.fire() directly). Adding one is a
 * small, legitimate follow-on (e.g. POST /scheduler/run/:taskIri on
 * server.js, proxied here), but it's a server.js change, which is outside
 * the scope of "the mcp-remote.js changes" this module was asked to
 * cover. Tracked as a known gap, not silently skipped.
 *
 * Wiring (holonbridge-mcp-remote.js)
 * -----------------------------------
 *   import { registerSchedulerAdmin } from './scheduler-admin.js';
 *   // Immediately after registerAdmin(...), same placement rules apply:
 *   // before app.use(requireAuth), since every route here applies
 *   // requireAuth + requireOperator itself.
 *   registerSchedulerAdmin(app, {
 *     requireAuth,
 *     holonbridgeUrl: () => activeBaseUrl(),
 *     hbBearerToken: HB_BEARER_TOKEN,
 *   });
 *
 * Environment
 * -----------
 *   SCHEDULER_DATASET=admin   # Fuseki dataset every scheduler admin
 *                             # read/write targets, via X-Dataset-Override
 *                             # on every hbFetch call. Defaults to "admin"
 *                             # -- matches lib/scheduler.js's own default
 *                             # adminDataset and server.js's
 *                             # SCHEDULER_ADMIN_DATASET. Keep these three
 *                             # in sync if you ever point the scheduler at
 *                             # a non-default dataset; they are three
 *                             # independent env vars by necessity (three
 *                             # separate processes) but one fact.
 */

import express from 'express';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireOperator } from './admin.js';

const jsonBody = express.json({ limit: '2mb' });

const __dirname = dirname(fileURLToPath(import.meta.url));

const SHAPES_GRAPH    = 'urn:scheduler:shapes';
const TASKS_GRAPH     = 'urn:scheduler:tasks';
const PERSONAS_GRAPH  = 'urn:scheduler:personas';
const PROVENANCE_GRAPH = 'urn:scheduler:provenance';
const QUARANTINE_GRAPH = 'urn:scheduler:quarantine';

const PERSONA_SHAPE = 'https://w3id.org/holon/sched#PersonaShape';
const TASK_SHAPE    = 'https://w3id.org/holon/sched#ScheduledTaskShape';

// See header -- same non-negotiable pinning discipline as ADMIN_DATASET in
// admin.js, and must match lib/scheduler.js's own adminDataset default.
const SCHEDULER_DATASET = process.env.SCHEDULER_DATASET ?? 'admin';

/**
 * Register the scheduler admin API on the given Express app.
 *
 * deps:
 *   requireAuth     -- the existing JWT/Bearer middleware from the main file
 *   holonbridgeUrl  -- () => base URL of the bridge to validate/push through
 *   hbBearerToken   -- HB_BEARER_TOKEN (service-to-service secret)
 */
export function registerSchedulerAdmin(app, { requireAuth, holonbridgeUrl, hbBearerToken }) {

  const hbFetch = async (path, init = {}) => {
    const res = await fetch(`${holonbridgeUrl()}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${hbBearerToken}`,
        'X-Dataset-Override': SCHEDULER_DATASET,
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

  const hbText = async (path, init) => {
    const res = await hbFetch(path, init);
    const text = await res.text();
    if (!res.ok) throw new Error(`HolonBridge ${path}: HTTP ${res.status} -- ${text.slice(0, 300)}`);
    return text;
  };

  /** Temp-graph SHACL validation of a Turtle payload -- same pattern as
   *  admin.js's validateTurtle() and lib/scheduler.js's own shape gate. */
  async function validateTurtle(turtle, shapesGraph) {
    const tempGraph = `urn:scheduler-admin:validate-temp:${Date.now()}`;
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

  /** Fetch a named graph's Turtle via GSP, for the "current state" side of
   *  a GET. Returns '' (not an error) if the graph doesn't exist yet --
   *  an empty scheduler graph is a legitimate starting state, not a fault. */
  async function readGraphTurtle(graphIri) {
    const res = await hbFetch(`/graph?iri=${encodeURIComponent(graphIri)}`, {
      headers: { Accept: 'text/turtle' },
    });
    if (res.status === 404) return '';
    const text = await res.text();
    if (!res.ok) throw new Error(`HolonBridge /graph: HTTP ${res.status} -- ${text.slice(0, 300)}`);
    return text;
  }

  /**
   * Validate-then-write a whole named graph. Mirrors admin.js's PUT
   * /admin/api/acl exactly: precheck-free here (Turtle has no cheap
   * structural precheck the way flat JSON does), SHACL validate against
   * shapesGraph, 422 with violations on failure, replace the whole graph
   * on success. Returns the response payload to send.
   */
  async function validateThenReplaceGraph(turtle, graphIri, shapesGraph) {
    let report;
    try {
      report = await validateTurtle(turtle, shapesGraph);
    } catch (err) {
      return {
        status: 502,
        body: {
          error: `SHACL validation could not run: ${err.message}`,
          hint: `Are the shapes installed? POST /admin/api/scheduler/shapes/install pushes scheduler-shapes.ttl to <${SHAPES_GRAPH}>.`,
        },
      };
    }
    if (report?.conforms === false) {
      return {
        status: 422,
        body: {
          error: 'SHACL validation failed -- nothing written.',
          conforms: false,
          violations: report.violations ?? report.results ?? [],
          rawReport: report.rawReport ?? null,
        },
      };
    }
    await hbJson('/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turtle, graph: graphIri, mode: 'replace' }),
    });
    return { status: 200, body: { ok: true, conforms: true, graph: graphIri } };
  }

  // -- GET /admin/api/scheduler/status -- counts + whether it's running --------

  app.get('/admin/api/scheduler/status', requireAuth, requireOperator, async (_req, res) => {
    const countQuery = (graphIri) => `SELECT (COUNT(*) AS ?c) WHERE { GRAPH <${graphIri}> { ?s ?p ?o } }`;
    const count = async (graphIri) => {
      try {
        const { bindings } = await hbJson('/sparql-select', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ sparql: countQuery(graphIri) }),
        });
        return parseInt(bindings?.[0]?.c?.value ?? '0', 10);
      } catch {
        return null; // graph or dataset unreachable -- report null, not a crash
      }
    };

    const [taskTriples, personaTriples, provenanceTriples, quarantineTriples] = await Promise.all([
      count(TASKS_GRAPH), count(PERSONAS_GRAPH), count(PROVENANCE_GRAPH), count(QUARANTINE_GRAPH),
    ]);

    // Best-effort: ask the bridge's own GET /scheduler whether the
    // in-process Scheduler is actually running (SCHEDULER_ENABLED). This
    // reflects live process state, distinct from the Fuseki data above,
    // which exists whether or not the scheduler is currently enabled.
    let liveStatus = null;
    try {
      liveStatus = await hbJson('/scheduler', { headers: { Accept: 'application/json' } });
    } catch {
      // non-fatal -- older HolonBridge instances or a transient error
    }

    res.json({
      dataset: SCHEDULER_DATASET,
      graphs: {
        tasks:       { iri: TASKS_GRAPH, triples: taskTriples },
        personas:    { iri: PERSONAS_GRAPH, triples: personaTriples },
        provenance:  { iri: PROVENANCE_GRAPH, triples: provenanceTriples },
        quarantine:  { iri: QUARANTINE_GRAPH, triples: quarantineTriples },
      },
      liveScheduler: liveStatus,
    });
  });

  // -- GET/PUT /admin/api/scheduler/tasks -- whole-graph read-modify-write -----

  app.get('/admin/api/scheduler/tasks', requireAuth, requireOperator, async (_req, res) => {
    try {
      const turtle = await readGraphTurtle(TASKS_GRAPH);
      res.json({ graph: TASKS_GRAPH, turtle });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/admin/api/scheduler/tasks', jsonBody, requireAuth, requireOperator, async (req, res) => {
    const { turtle } = req.body ?? {};
    if (!turtle || typeof turtle !== 'string' || !turtle.trim()) {
      return res.status(400).json({ error: 'Request body must include a non-empty "turtle" string.' });
    }
    try {
      const result = await validateThenReplaceGraph(turtle, TASKS_GRAPH, TASK_SHAPE);
      console.log(`[scheduler-admin] tasks graph ${result.status === 200 ? 'saved' : 'rejected'} by ${req.githubLogin}`);
      return res.status(result.status).json(result.body);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // -- GET/PUT /admin/api/scheduler/personas -- whole-graph read-modify-write --

  app.get('/admin/api/scheduler/personas', requireAuth, requireOperator, async (_req, res) => {
    try {
      const turtle = await readGraphTurtle(PERSONAS_GRAPH);
      res.json({ graph: PERSONAS_GRAPH, turtle });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/admin/api/scheduler/personas', jsonBody, requireAuth, requireOperator, async (req, res) => {
    const { turtle } = req.body ?? {};
    if (!turtle || typeof turtle !== 'string' || !turtle.trim()) {
      return res.status(400).json({ error: 'Request body must include a non-empty "turtle" string.' });
    }
    try {
      const result = await validateThenReplaceGraph(turtle, PERSONAS_GRAPH, PERSONA_SHAPE);
      console.log(`[scheduler-admin] personas graph ${result.status === 200 ? 'saved' : 'rejected'} by ${req.githubLogin}`);
      return res.status(result.status).json(result.body);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // -- GET /admin/api/scheduler/provenance -- recent firing records, read-only -

  app.get('/admin/api/scheduler/provenance', requireAuth, requireOperator, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const sparql = `
PREFIX sched: <https://w3id.org/holon/sched#>
SELECT ?rec ?task ?persona ?triggerType ?outcome ?reason ?firedAt WHERE {
  GRAPH <${PROVENANCE_GRAPH}> {
    ?rec a sched:FiringRecord ;
         sched:task ?task ;
         sched:triggerType ?triggerType ;
         sched:outcome ?outcome ;
         sched:firedAt ?firedAt .
    OPTIONAL { ?rec sched:persona ?persona }
    OPTIONAL { ?rec sched:reason ?reason }
  }
} ORDER BY DESC(?firedAt) LIMIT ${limit}`;
    try {
      const { bindings } = await hbJson('/sparql-select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ sparql }),
      });
      const records = bindings.map(b => ({
        record: b.rec?.value, task: b.task?.value, persona: b.persona?.value ?? null,
        triggerType: b.triggerType?.value, outcome: b.outcome?.value,
        reason: b.reason?.value ?? null, firedAt: b.firedAt?.value,
      }));
      res.json({ graph: PROVENANCE_GRAPH, count: records.length, records });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // -- GET /admin/api/scheduler/quarantine -- rejected proposals, read-only ----

  app.get('/admin/api/scheduler/quarantine', requireAuth, requireOperator, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const sparql = `
PREFIX sched: <https://w3id.org/holon/sched#>
SELECT ?rec ?task ?persona ?reason ?quarantinedAt WHERE {
  GRAPH <${QUARANTINE_GRAPH}> {
    ?rec a sched:QuarantinedProposal ;
         sched:task ?task ;
         sched:reason ?reason ;
         sched:quarantinedAt ?quarantinedAt .
    OPTIONAL { ?rec sched:persona ?persona }
  }
} ORDER BY DESC(?quarantinedAt) LIMIT ${limit}`;
    try {
      const { bindings } = await hbJson('/sparql-select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ sparql }),
      });
      const records = bindings.map(b => ({
        record: b.rec?.value, task: b.task?.value, persona: b.persona?.value ?? null,
        reason: b.reason?.value, quarantinedAt: b.quarantinedAt?.value,
      }));
      res.json({ graph: QUARANTINE_GRAPH, count: records.length, records });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // -- POST /admin/api/scheduler/shapes/install -- one-time shapes push --------

  app.post('/admin/api/scheduler/shapes/install', requireAuth, requireOperator, async (_req, res) => {
    try {
      const shapes = readFileSync(join(__dirname, 'scheduler-shapes.ttl'), 'utf8');
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

  console.log(`[scheduler-admin] Routes registered under /admin/api/scheduler/* -- dataset: ${SCHEDULER_DATASET} (override via SCHEDULER_DATASET env var)`);
}
