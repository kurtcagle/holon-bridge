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
 *
 * Changelog
 * ─────────
 *   2026-07-07 FIX: parseReport()'s result-block splitter used
 *                      turtle.match(/sh:result\s*\[[\s\S]*?\]/g) — a
 *                      non-greedy regex that stops at the first literal
 *                      ']' character, not the actual matching close
 *                      bracket. Jena's own cardinality violation messages
 *                      embed bracketed indices in the text itself, e.g.
 *                      sh:resultMessage "minCount[1]: Invalid cardinality:
 *                      expected min 1: Got count = 0" — the ']' inside
 *                      "minCount[1]" satisfied the regex and truncated
 *                      every block right after the partial message string,
 *                      before resultPath/resultSeverity/sourceShape were
 *                      ever reached. Silent failure mode: conforms:false
 *                      was still detected correctly (top-level sh:conforms
 *                      match was unaffected), but every individual
 *                      violation came back with path:null, message:null,
 *                      severity:'sh:', severityIri:'' — and since
 *                      violations is filtered on severityIri.includes
 *                      ('Violation'), violationCount was always 0
 *                      regardless of how many real violations existed.
 *                      This reproduces on essentially any minCount/
 *                      maxCount violation, since "minCount[N]"/
 *                      "maxCount[N]" is Jena's own message convention —
 *                      not a rare edge case.
 *                      Fix: replaced the regex block splitter with
 *                      extractResultBlocks(), a small bracket-depth-aware
 *                      scanner that walks the report character by
 *                      character, tracks nesting depth for [ ... ],
 *                      and treats characters inside "..." string
 *                      literals (with backslash-escape handling) as
 *                      inert so literal brackets in message text can
 *                      never be mistaken for structural brackets. Also
 *                      hardened extractTurtleValue()'s quoted-literal
 *                      regex to tolerate escaped quotes within the
 *                      literal (\\" no longer terminates the match
 *                      early), for the same class of reason.
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
 * Returns parsed violations plus the raw Turtle for debugging/audit.
 */
function parseReport(turtle) {
  const conformsMatch = turtle.match(/sh:conforms\s+(true|false)/)
  const conforms      = conformsMatch ? conformsMatch[1] === 'true' : true

  if (conforms) return { conforms: true, violations: [], results: [], rawReport: turtle }

  const results      = []
  const resultBlocks = extractResultBlocks(turtle)

  for (const block of resultBlocks) {
    const severityIri = extractTurtleValue(block, 'sh:resultSeverity') ?? ''
    const severity    = severityIri.split('#').pop().split('/').pop() || severityIri
    const entry = {
      focusNode:   extractTurtleValue(block, 'sh:focusNode'),
      path:        extractTurtleValue(block, 'sh:resultPath'),
      message:     extractTurtleValue(block, 'sh:resultMessage'),
      severity:    `sh:${severity}`,
      severityIri,
      sourceShape: extractTurtleValue(block, 'sh:sourceShape')
    }
    results.push(entry)
  }

  const violations = results.filter(r => r.severityIri.includes('Violation'))
  return { conforms: false, violations, results, rawReport: turtle }
}

/**
 * Extract every `sh:result [ ... ]` block from a SHACL validation report,
 * respecting bracket nesting and string-literal boundaries.
 *
 * A plain non-greedy regex (the previous approach) stops at the first
 * literal ']' character, which breaks the moment any property inside the
 * block — most commonly sh:resultMessage — contains a ']' in its own text.
 * Jena's cardinality messages always do: "minCount[1]: ...". This scanner
 * walks the report character by character instead, tracking bracket depth
 * and treating everything inside "..." (including backslash-escaped
 * characters) as inert, so it can never mistake a bracket inside a string
 * for a structural one.
 *
 * @param {string} turtle  Full SHACL validation report in Turtle
 * @returns {string[]}     Each element is one complete `[ ... ]` block,
 *                          brackets included, for sh:result's object.
 */
function extractResultBlocks(turtle) {
  const blocks = []
  const marker = 'sh:result'
  let searchFrom = 0

  while (true) {
    const markerIdx = turtle.indexOf(marker, searchFrom)
    if (markerIdx === -1) break

    const openIdx = turtle.indexOf('[', markerIdx + marker.length)
    if (openIdx === -1) break

    const closeIdx = findMatchingBracket(turtle, openIdx)
    if (closeIdx === -1) {
      // Malformed/truncated report — stop rather than loop forever.
      break
    }

    blocks.push(turtle.slice(openIdx, closeIdx + 1))
    searchFrom = closeIdx + 1
  }

  return blocks
}

/**
 * Given the index of an opening '[' in `text`, return the index of its
 * matching closing ']', accounting for nested brackets and skipping over
 * characters inside "..." or '...' string literals (backslash-escaped
 * characters inside a literal never end it early or count as brackets).
 *
 * @param {string} text
 * @param {number} openIndex  Index of the opening '[' character
 * @returns {number}          Index of the matching ']', or -1 if unbalanced
 */
function findMatchingBracket(text, openIndex) {
  let depth = 0
  let inString = false
  let stringChar = null

  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i]

    if (inString) {
      if (ch === '\\') { i++; continue } // skip escaped char, including \" and \\
      if (ch === stringChar) inString = false
      continue
    }

    if (ch === '"' || ch === "'") {
      inString = true
      stringChar = ch
      continue
    }

    if (ch === '[') {
      depth++
    } else if (ch === ']') {
      depth--
      if (depth === 0) return i
    }
  }

  return -1
}

/**
 * Extract the first value of a predicate from a Turtle snippet.
 * Handles IRIs (<...>), prefixed names, and quoted literals.
 * Returns full IRI strings for IRI values, raw strings for literals.
 */
function extractTurtleValue(block, predicate) {
  // IRI value: predicate <value>
  const iriMatch = block.match(new RegExp(`${predicate}\\s+<([^>]+)>`))
  if (iriMatch) return iriMatch[1]

  // Quoted literal: predicate "value" — tolerate escaped quotes (\") inside
  // the literal so a message like "say \"hi\"" doesn't truncate early.
  const litMatch = block.match(new RegExp(`${predicate}\\s+"((?:[^"\\\\]|\\\\.)*)"(?:@[a-z-]+)?`))
  if (litMatch) return litMatch[1]

  // Prefixed name: predicate prefix:local — expand to full IRI
  const pfxMatch = block.match(new RegExp(`${predicate}\\s+([\\w-]+:[\\w.-]+)`))
  if (pfxMatch) {
    const prefixed = pfxMatch[1]
    const prefixMap = {
      'sh:':     'http://www.w3.org/ns/shacl#',
      'rdf:':    'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
      'rdfs:':   'http://www.w3.org/2000/01/rdf-schema#',
      'xsd:':    'http://www.w3.org/2001/XMLSchema#',
      'foaf:':   'http://xmlns.com/foaf/0.1/',
      'schema:': 'https://schema.org/',
      'owl:':    'http://www.w3.org/2002/07/owl#'
    }
    for (const [pfx, ns] of Object.entries(prefixMap)) {
      if (prefixed.startsWith(pfx)) return ns + prefixed.slice(pfx.length)
    }
    return prefixed // return as-is if prefix unknown
  }

  return null
}
