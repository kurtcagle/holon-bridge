/**
 * shacl.js -- SHACL validation delegated to Jena Fuseki
 *
 * Jena 6.0 Fuseki SHACL endpoint API (corrected):
 *   POST /{dataset}/shacl?graph=<data-graph-iri>
 *   Body: Turtle SHAPES graph
 *   Response: SHACL validation report in Turtle
 *
 * The ?graph parameter specifies the DATA graph to validate (a named graph
 * already in the dataset). The request body is the SHAPES graph.
 *
 * This is the OPPOSITE of the original assumption. The fix:
 *   1. Write the submitted data Turtle to a temporary named graph via GSP
 *   2. Fetch the SHACL shapes Turtle from the shapes named graph via GSP
 *   3. POST /shacl?graph=<temp-data-graph> with shapes as body
 *   4. Parse the report and clean up the temp graph
 *
 * Reference: Apache Jena Fuseki SHACL test suite (FusekiSHACL.java)
 *   HttpOp.httpPost(url + "?graph=dataGraph", contentTypeTurtle, shapesStr)
 */

const SHACL_TIMEOUT_MS = 30_000

// --- Jena SHACL endpoint call -------------------------------------------------

/**
 * Validate turtle data against a shapes graph already loaded in Jena.
 *
 * Corrected API: body = SHAPES, ?graph = DATA graph to validate.
 *
 * @param {string} jenaBase       e.g. 'http://localhost:3030'
 * @param {string} dataset        e.g. 'ds'
 * @param {string} shaclGraphIri  Named graph IRI holding the SHACL shapes
 * @param {string} turtle         Turtle data to validate
 * @returns {Promise<{ conforms: boolean, violations: object[], results: object[] }>}
 */
export async function validateWithShacl(jenaBase, dataset, shaclGraphIri, turtle) {
  const gspBase   = `${jenaBase}/${dataset}/data`
  const shaclUrl  = `${jenaBase}/${dataset}/shacl`
  const tempGraph = `urn:holon-bridge:shacl-temp:${Date.now()}`

  // Step 1: Write data Turtle to a temporary named graph via GSP PUT
  const putResp = await fetch(`${gspBase}?graph=${encodeURIComponent(tempGraph)}`, {
    method:  'PUT',
    headers: { 'Content-Type': 'text/turtle' },
    body:    turtle
  })
  if (!putResp.ok) {
    const msg = await putResp.text()
    throw new Error(`GSP PUT to temp graph failed (HTTP ${putResp.status}): ${msg.slice(0, 200)}`)
  }

  // Step 2: Fetch SHACL shapes from the shapes named graph via GSP GET
  let shapesTurtle = ''
  try {
    const getResp = await fetch(`${gspBase}?graph=${encodeURIComponent(shaclGraphIri)}`, {
      headers: { 'Accept': 'text/turtle' }
    })
    if (getResp.ok) {
      shapesTurtle = await getResp.text()
    }
  } catch (_) {
    // shapes not available — will result in conforms:true (no shapes = no violations)
  }

  // Step 3: POST /shacl?graph=<temp-data-graph> with shapes as body
  //         Jena interprets: body = SHAPES, ?graph = DATA to validate
  let reportTurtle = ''
  let shaclStatus  = 0
  const controller = new AbortController()
  const timer      = setTimeout(() => controller.abort(), SHACL_TIMEOUT_MS)

  try {
    const shaclResp = await fetch(
      `${shaclUrl}?graph=${encodeURIComponent(tempGraph)}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'text/turtle', 'Accept': 'text/turtle' },
        body:    shapesTurtle,
        signal:  controller.signal
      }
    )
    shaclStatus   = shaclResp.status
    reportTurtle  = await shaclResp.text()

    if (!shaclResp.ok)
      throw new Error(`Jena SHACL returned HTTP ${shaclStatus}: ${reportTurtle.slice(0, 300)}`)

  } catch (err) {
    if (err.name === 'AbortError')
      throw new Error(`Jena SHACL timed out after ${SHACL_TIMEOUT_MS}ms`)
    throw err
  } finally {
    clearTimeout(timer)
    // Step 4: Clean up temp graph (fire-and-forget, don't await)
    fetch(`${gspBase}?graph=${encodeURIComponent(tempGraph)}`, { method: 'DELETE' })
      .catch(() => {})
  }

  return parseReport(reportTurtle)
}

// --- Report parser ------------------------------------------------------------

/**
 * Parse a SHACL validation report in Turtle.
 *
 * Jena's report format:
 *   sh:conforms true/false
 *   sh:result [ sh:focusNode ...; sh:resultPath ...; sh:resultMessage ... ]
 *
 * @param {string} turtle  SHACL report Turtle from Jena
 * @returns {{ conforms: boolean, violations: object[], results: object[] }}
 */
function parseReport(turtle) {
  const conformsMatch = turtle.match(/sh:conforms\s+(true|false)/)
  const conforms      = conformsMatch ? conformsMatch[1] === 'true' : true

  if (conforms) return { conforms: true, violations: [], results: [] }

  // Extract result blocks — each sh:result [...] block
  const results    = []
  const resultBlocks = turtle.match(/sh:result\s*\[[\s\S]*?\]/g) ?? []

  for (const block of resultBlocks) {
    const severity = extractTurtleValue(block, 'sh:resultSeverity') ?? ''
    const entry = {
      focusNode:   extractTurtleValue(block, 'sh:focusNode'),
      path:        extractTurtleValue(block, 'sh:resultPath'),
      message:     extractTurtleValue(block, 'sh:resultMessage'),
      severity,
      sourceShape: extractTurtleValue(block, 'sh:sourceShape')
    }
    results.push(entry)
  }

  const violations = results.filter(r => r.severity.includes('Violation'))
  return { conforms: false, violations, results }
}

/**
 * Extract the first value of a predicate from a Turtle snippet.
 * Handles IRIs (<...>), prefixed names, and quoted literals.
 */
function extractTurtleValue(block, predicate) {
  const iriMatch = block.match(new RegExp(`${predicate}\\s+<([^>]+)>`))
  if (iriMatch) return iriMatch[1]

  const litMatch = block.match(new RegExp(`${predicate}\\s+"([^"]*)"(?:@[a-z-]+)?`))
  if (litMatch) return litMatch[1]

  const pfxMatch = block.match(new RegExp(`${predicate}\\s+([\\w-]+:[\\w-]+)`))
  if (pfxMatch) return pfxMatch[1]

  return null
}
