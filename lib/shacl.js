/**
 * shacl.js -- SHACL validation delegated to Jena Fuseki
 *
 * Jena 6.0 Fuseki exposes a native SHACL validation endpoint:
 *   POST /{dataset}/shacl?graph=<shapes-graph-iri>
 *   Body: Turtle data to validate
 *   Response: SHACL validation report in Turtle
 *
 * Delegating to Jena avoids all N3 / rdf-validate-shacl compatibility issues
 * with RDF 1.2 triple-term syntax in the shapes graph.  Jena handles SHACL 1.2
 * natively, including rdf:Reifier target shapes.
 *
 * The response report is parsed with a lightweight regex scan rather than a
 * full RDF parser -- we only need sh:conforms and the violation focus/path/message
 * fields, which are reliably present in Jena's Turtle report output.
 */

const SHACL_TIMEOUT_MS = 20_000
const SH = 'http://www.w3.org/ns/shacl#'

// --- Jena SHACL endpoint call -------------------------------------------------

/**
 * Validate turtle data against a shapes graph already loaded in Jena.
 *
 * @param {string} jenaBase       e.g. 'http://localhost:3030'
 * @param {string} dataset        e.g. 'ds'
 * @param {string} shaclGraphIri  Named graph IRI holding the SHACL shapes
 * @param {string} turtle         Turtle data to validate
 * @returns {Promise<{ conforms: boolean, violations: object[] }>}
 */
export async function validateWithShacl(jenaBase, dataset, shaclGraphIri, turtle) {
  const url = `${jenaBase}/${dataset}/shacl?graph=${encodeURIComponent(shaclGraphIri)}`

  const controller = new AbortController()
  const timer      = setTimeout(() => controller.abort(), SHACL_TIMEOUT_MS)

  let response
  try {
    response = await fetch(url, {
      method:  'POST',
      headers: {
        'Content-Type': 'text/turtle',
        'Accept':        'text/turtle'
      },
      body:   turtle,
      signal: controller.signal
    })
  } catch (err) {
    clearTimeout(timer)
    if (err.name === 'AbortError')
      throw new Error(`Jena SHACL validation timed out after ${SHACL_TIMEOUT_MS}ms`)
    throw new Error(`Jena SHACL endpoint unreachable: ${err.message}`)
  } finally {
    clearTimeout(timer)
  }

  const reportTurtle = await response.text()

  if (!response.ok) {
    throw new Error(`Jena SHACL endpoint returned HTTP ${response.status}: ${reportTurtle.slice(0, 300)}`)
  }

  return parseReport(reportTurtle)
}

// --- Report parser ------------------------------------------------------------

/**
 * Parse a SHACL validation report in Turtle.
 *
 * Jena's report format is predictable enough for targeted extraction:
 *   sh:conforms true/false
 *   sh:result [ sh:focusNode ...; sh:resultPath ...; sh:resultMessage ... ]
 *
 * @param {string} turtle  SHACL report Turtle from Jena
 * @returns {{ conforms: boolean, violations: object[] }}
 */
function parseReport(turtle) {
  // sh:conforms
  const conformsMatch = turtle.match(/sh:conforms\s+(true|false)/)
  const conforms      = conformsMatch ? conformsMatch[1] === 'true' : true

  if (conforms) return { conforms: true, violations: [] }

  // Extract result blocks -- each sh:result [...] block
  const violations = []
  const resultBlocks = turtle.match(/sh:result\s*\[[\s\S]*?\]/g) ?? []

  for (const block of resultBlocks) {
    violations.push({
      focusNode:   extractTurtleValue(block, 'sh:focusNode'),
      path:        extractTurtleValue(block, 'sh:resultPath'),
      message:     extractTurtleValue(block, 'sh:resultMessage'),
      severity:    extractTurtleValue(block, 'sh:resultSeverity'),
      sourceShape: extractTurtleValue(block, 'sh:sourceShape')
    })
  }

  return { conforms: false, violations }
}

/**
 * Extract the first value of a predicate from a Turtle snippet.
 * Handles IRIs (<...>), prefixed names, and quoted literals.
 */
function extractTurtleValue(block, predicate) {
  // IRI value: predicate <value>
  const iriMatch = block.match(new RegExp(`${predicate}\\s+<([^>]+)>`))
  if (iriMatch) return iriMatch[1]

  // Quoted literal: predicate "value"
  const litMatch = block.match(new RegExp(`${predicate}\\s+"([^"]*)"(?:@[a-z-]+)?`))
  if (litMatch) return litMatch[1]

  // Prefixed name: predicate prefix:local
  const pfxMatch = block.match(new RegExp(`${predicate}\\s+([\\w-]+:[\\w-]+)`))
  if (pfxMatch) return pfxMatch[1]

  return null
}
