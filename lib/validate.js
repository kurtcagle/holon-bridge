/**
 * lib/validate.js -- POST /validate route handler
 * HolonBridge v2.9.1+
 *
 * Validates an existing named graph against an existing shapes graph,
 * both already loaded in the active Fuseki dataset.
 *
 * Request body:
 *   {
 *     dataGraph:   "<named graph IRI to validate>"          // required
 *     shapesGraph: "<named graph IRI containing shapes>"    // optional; defaults to SHACL_GRAPH
 *   }
 *
 * Response:
 *   {
 *     conforms:       true | false,
 *     dataGraph:      "<IRI>",
 *     shapesGraph:    "<IRI>",
 *     dataset:        "<name>",
 *     violationCount: N,
 *     violations: [
 *       {
 *         focusNode:   "<IRI>",
 *         path:        "<IRI> | null",
 *         message:     "<string> | null",
 *         severity:    "sh:Violation | sh:Warning | sh:Info",
 *         sourceShape: "<IRI> | null"
 *       }
 *     ],
 *     rawReport: "<Turtle validation report>"
 *   }
 */

'use strict'

import { validateWithShacl } from './shacl.js'

const SHACL_TIMEOUT_MS = 30_000

/**
 * Fetch a named graph from Fuseki as Turtle via GSP.
 * Returns empty string if the graph is absent (no shapes = no violations).
 */
async function fetchGraphAsTurtle (gspBase, graphIri) {
  const url = `${gspBase}?graph=${encodeURIComponent(graphIri)}`
  const resp = await fetch(url, { headers: { Accept: 'text/turtle' } })
  if (!resp.ok) {
    if (resp.status === 404) return ''          // graph absent — treat as empty
    throw new Error(`GSP GET <${graphIri}> failed: HTTP ${resp.status}`)
  }
  return resp.text()
}

/**
 * POST /validate handler.
 *
 * Called from server.js as:
 *   app.post('/validate', authMiddleware, (req, res) =>
 *     validateHandler(req, res, { JENA_BASE, DATASET, SHACL_GRAPH }))
 */
export async function validateHandler (req, res, { JENA_BASE, DATASET, SHACL_GRAPH }) {
  const { dataGraph, shapesGraph: requestedShapesGraph } = req.body ?? {}

  if (!dataGraph) {
    return res.status(400).json({
      error: '"dataGraph" is required — provide the IRI of the named graph to validate.'
    })
  }

  const shapesGraph = requestedShapesGraph || SHACL_GRAPH

  if (!shapesGraph) {
    return res.status(400).json({
      error: '"shapesGraph" not provided and no default SHACL_GRAPH configured for this dataset.'
    })
  }

  const gspBase = `${JENA_BASE}/${DATASET}/data`

  try {
    // Fetch data graph as Turtle
    const dataTurtle = await fetchGraphAsTurtle(gspBase, dataGraph)

    if (!dataTurtle.trim()) {
      return res.status(404).json({
        error: `Named graph <${dataGraph}> is absent or empty in dataset '${DATASET}'.`
      })
    }

    // Delegate to the existing validateWithShacl (temp graph + shapes GSP + Fuseki SHACL)
    const report = await validateWithShacl(JENA_BASE, DATASET, shapesGraph, dataTurtle)

    return res.json({
      conforms:       report.conforms,
      dataGraph,
      shapesGraph,
      dataset:        DATASET,
      violationCount: report.violations.length,
      violations:     report.violations,
      results:        report.results,      // includes warnings + info, not just violations
      rawReport:      report.rawReport
    })
  } catch (err) {
    console.error('[validate]', err.message)
    return res.status(500).json({ error: err.message })
  }
}
