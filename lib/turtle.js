/**
 * turtle.js -- Safe Turtle literal serialisation
 *
 * Exists because the same hand-rolled idiom appeared in three places in
 * lib/scheduler.js and got it wrong in three different ways:
 *
 *     sched:reason "${reason.replace(/"/g, '\\"').slice(0, 1000)}" ;
 *
 * 1. BACKSLASHES ARE NOT ESCAPED. In a Turtle literal '\' introduces an escape
 *    sequence, so a value containing a Windows path -- c:\ProgramData\... --
 *    serialises as "\P" and "\h", neither of which is a valid escape. Jena
 *    rejects the whole document with HTTP 400. This is the one that actually
 *    bit: an LLM persona summarising a session that mentioned file paths took
 *    the scheduler down every 30 seconds.
 *
 * 2. NEWLINES ARE NOT ESCAPED. A short "..." literal may not contain a raw
 *    newline. LLM-generated prose contains them routinely.
 *
 * 3. IT ESCAPES BEFORE TRUNCATING. .replace() then .slice(0, N) can cut between
 *    a backslash and the character it escapes. The literal then ends in a lone
 *    backslash, which escapes the closing quote, and the value runs on into the
 *    rest of the document. Rare, silent, and very hard to read back from a 400.
 *
 * The functions below return the COMPLETE literal including its delimiters, so
 * a caller cannot forget to quote the result -- which is the mistake that makes
 * this class of bug recur. Truncation happens before escaping, and the escape
 * order is fixed: backslash first, or every escape inserted afterwards would be
 * escaped a second time.
 */

/** Length of the ellipsis appended to a truncated value. */
const ELLIPSIS = '...'

/**
 * Serialise a value as a short Turtle literal: "..." with delimiters included.
 *
 * @param {*} value
 * @param {object} [opts]
 * @param {number|null} [opts.maxLength]  Truncate the RAW value to this many
 *   characters (before escaping, so an escape sequence can never be split) and
 *   append an ellipsis. Null for no limit.
 * @param {string|null} [opts.lang]       Language tag, e.g. 'en'. Mutually
 *   exclusive with datatype, per the RDF data model.
 * @param {string|null} [opts.datatype]   Full datatype IRI.
 * @returns {string} e.g. "some \"value\""@en
 */
export function turtleLiteral(value, { maxLength = null, lang = null, datatype = null } = {}) {
  if (lang && datatype)
    throw new Error('turtleLiteral: a literal may carry a language tag or a datatype, not both')

  const escaped = escapeShort(truncate(stringify(value), maxLength))

  if (lang)     return `"${escaped}"@${lang}`
  if (datatype) return `"${escaped}"^^<${datatype}>`
  return `"${escaped}"`
}

/**
 * Serialise a value as a long Turtle literal: """...""" with delimiters
 * included. Newlines are preserved rather than escaped, which is the whole
 * point of the long form -- use this for embedded documents (a quarantined
 * proposal's Turtle, a SPARQL body) where the line structure matters.
 *
 * Double quotes are escaped individually rather than only the """ sequence.
 * That is stricter than Turtle requires, and deliberately so: escaping only
 * """ still leaves a value ending in a quote adjacent to the closing
 * delimiter, which is a parse error.
 *
 * @param {*} value
 * @param {object} [opts]
 * @param {number|null} [opts.maxLength]
 * @returns {string}
 */
export function turtleLongLiteral(value, { maxLength = null } = {}) {
  const escaped = escapeLong(truncate(stringify(value), maxLength))
  return `"""${escaped}"""`
}

/**
 * Serialise a value as an xsd:dateTime literal.
 *
 * Accepts a Date or an ISO string. Rejects anything that isn't a valid instant
 * rather than emitting a literal Jena will refuse -- a bad timestamp should
 * fail where it is created, not three layers away in a GSP push.
 *
 * @param {Date|string} value
 * @returns {string} e.g. "2026-07-25T07:02:28.586Z"^^xsd:dateTime
 */
export function turtleDateTime(value) {
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime()))
    throw new Error(`turtleDateTime: not a valid instant: ${String(value)}`)
  return `"${d.toISOString()}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`
}

// --- internals ----------------------------------------------------------------

function stringify(value) {
  if (value === null || value === undefined) return ''
  return typeof value === 'string' ? value : String(value)
}

function truncate(s, maxLength) {
  if (!maxLength || s.length <= maxLength) return s
  // Truncating the RAW value is what makes escaping safe -- there is no escape
  // sequence to cut in half, because none exist yet.
  return s.slice(0, maxLength) + ELLIPSIS
}

/**
 * Escape for a short "..." literal. Backslash MUST come first: escaping it
 * after the others would double-escape every backslash they introduced.
 */
function escapeShort(s) {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g,  '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    // Remaining C0 controls have no Turtle escape and are not legal raw. \u
    // escapes are, so map them rather than dropping them -- a control character
    // in the input is usually a symptom worth preserving in the record.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,
             ch => `\\u${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
}

/** Escape for a long """...""" literal. Newlines and tabs stay raw. */
function escapeLong(s) {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g,  '\\"')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,
             ch => `\\u${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
}
