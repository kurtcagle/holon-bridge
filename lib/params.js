/**
 * params.js -- Named-query/rule parameter substitution
 *
 * Extracted verbatim in behaviour from server.js's substituteParams(), which
 * sat inline among the route handlers despite being a pure function with no
 * dependency on any of them. Pulled out so it can be unit-tested, which matters
 * more here than for most helpers -- see the security note below.
 *
 * -- Substitution is raw string replacement --
 *
 * {{name}} placeholders are replaced with String(value) wherever they appear.
 * The query AUTHOR is responsible for placing each placeholder in the correct
 * SPARQL syntactic context:
 *
 *   FILTER(CONTAINS(LCASE(?jobTitle), LCASE("{{role}}")))   -- inside quotes
 *   ?person foaf:gender <{{genderIRI}}> .                    -- inside angle brackets
 *
 * Because the replacement is textual, a caller-supplied value CAN break out of
 * the literal it lands in -- a value containing a double quote closes the string
 * early, and everything after it is parsed as query syntax. Callers of
 * POST /query { queryId, params } are therefore trusted to the same degree as
 * callers of POST /sparql-update. That is the behaviour as designed, not a bug
 * introduced here, and it is preserved exactly; it is written down loudly
 * because it was not written down anywhere before.
 *
 * If that trust boundary ever needs tightening, this is the one place to do it,
 * and escapeSparqlLiteral() below is the piece to reach for. It is exported and
 * unused on purpose.
 */

/** Escape a value for safe inclusion inside a SPARQL string literal. */
const LITERAL_ESCAPES = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t' }

/**
 * Escape backslashes, double quotes, and control characters so a value cannot
 * terminate the SPARQL string literal it is substituted into.
 *
 * Not applied by substituteParams() -- see the module docstring. Provided so
 * that tightening the trust boundary later is a one-line change at the call
 * site rather than a redesign.
 *
 * @param {*} value
 * @returns {string}
 */
export function escapeSparqlLiteral(value) {
  return String(value).replace(/[\\"\n\r\t]/g, ch => LITERAL_ESCAPES[ch])
}

/** Escape regex metacharacters so a parameter NAME is matched literally. */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Substitute {{paramName}} placeholders in a SPARQL string with caller-supplied
 * values.
 *
 * Behavioural note vs. the server.js original: the parameter NAME is now
 * regex-escaped before being compiled into the matcher. Previously a name
 * containing a metacharacter (e.g. "a.b") compiled to a pattern that matched
 * more than the literal placeholder, so it could substitute into the wrong
 * spot or silently fail to match. Every well-formed \w+ name behaves
 * identically to before; only names that were already broken change.
 *
 * The original also compiled the same pattern twice per parameter -- once to
 * test, once to replace. Now compiled once.
 *
 * @param {string} sparql
 * @param {Record<string, unknown>} params
 * @returns {{sparql: string, substituted: string[], missing: string[]}}
 *   sparql      -- the result (may still contain unresolved placeholders)
 *   substituted -- names that were actually replaced
 *   missing     -- {{placeholders}} still present afterwards
 */
export function substituteParams(sparql, params) {
  if (!params || typeof params !== 'object' || Object.keys(params).length === 0)
    return { sparql, substituted: [], missing: [] }

  let result = sparql
  const substituted = []

  for (const [key, value] of Object.entries(params)) {
    const pattern = new RegExp(`\\{\\{${escapeRegExp(key)}\\}\\}`, 'g')
    const next    = result.replace(pattern, String(value))
    if (next !== result) {
      substituted.push(key)
      result = next
    }
  }

  // Anything left is a placeholder the caller did not supply a value for.
  const missing = [...result.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[0])

  return { sparql: result, substituted, missing }
}
