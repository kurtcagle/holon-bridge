/**
 * format.js -- DataBook response formatter
 *
 * Wraps the full pipeline output (NL query, generated SPARQL, raw bindings,
 * pre-formatted results, interpretation) into a self-describing DataBook.
 *
 * Each stage is a separately addressable block, so you can:
 *   - Extract and re-run the SPARQL directly against Jena
 *   - Inspect raw bindings without the interpretation layer
 *   - Feed the DataBook back into the pipeline for regression testing
 *
 * Usage:
 *   import { buildResponseDataBook } from './lib/format.js'
 *   const md = buildResponseDataBook({ nlQuery, sparql, bindings, vars,
 *                                       formattedResults, answer,
 *                                       retries, namedGraphs, model,
 *                                       endpoint, error })
 *   res.type('text/markdown').send(md)
 */

/**
 * @param {object} opts
 * @param {string}   opts.nlQuery          Original NL question
 * @param {string}   opts.sparql           Generated SPARQL (null if unanswerable)
 * @param {object[]} opts.bindings         Raw SPARQL JSON bindings array
 * @param {string[]} opts.vars             SPARQL result variable names
 * @param {string}   opts.formattedResults Pre-formatted binding text
 * @param {string}   opts.answer           Plain English interpretation
 * @param {number}   opts.retries          Number of correction retries
 * @param {string[]} opts.namedGraphs      Named graphs in scope at query time
 * @param {string}   opts.model            Claude model used
 * @param {string}   opts.endpoint         Jena SPARQL endpoint
 * @param {string}   [opts.error]          Jena error message if query failed
 * @returns {string}  DataBook markdown document
 */
export function buildResponseDataBook(opts) {
  const {
    nlQuery,
    sparql,
    bindings     = [],
    vars         = [],
    formattedResults,
    answer,
    retries      = 0,
    namedGraphs  = [],
    model,
    endpoint,
    error
  } = opts

  const ts      = new Date().toISOString()
  const tsDate  = ts.slice(0, 10)
  const queryId = `query-${ts.replace(/[:.]/g, '-').replace('T', '-').slice(0, 19)}`
  const status  = error ? 'error' : sparql === null ? 'unanswerable' : 'ok'

  const frontmatter = [
    '---',
    `id: https://w3id.org/un/ggsc/debug/${queryId}`,
    `title: "GGSC Query Debug -- ${nlQuery.slice(0, 60).replace(/"/g, "'")}"`,
    `type: databook`,
    `subtype: query-debug`,
    `version: 1.0.0`,
    `created: ${tsDate}`,
    `description: >`,
    `  Debug output for NL-to-SPARQL pipeline query.`,
    `  Contains: nl-query, generated-sparql, raw-bindings,`,
    `  formatted-results, interpretation, session-metadata.`,
    `tags:`,
    `  - ggsc`,
    `  - query-debug`,
    `  - nl-to-sparql`,
    `session:`,
    `  id: ${queryId}`,
    `  timestamp: ${ts}`,
    `  status: ${status}`,
    `  retries: ${retries}`,
    `  model: ${model}`,
    `  endpoint: ${endpoint}`,
    namedGraphs.length > 0
      ? `  namedGraphs:\n${namedGraphs.map(g => `    - "${g}"`).join('\n')}`
      : `  namedGraphs: []`,
    '---',
    ''
  ].join('\n')

  const heading = [
    `# GGSC Query Debug`,
    '',
    `**Query:** ${nlQuery}`,
    `**Status:** ${status}  **Retries:** ${retries}  **Timestamp:** ${ts}`,
    '',
    '---',
    ''
  ].join('\n')

  // Block 1 -- nl-query
  const nlBlock = [
    '<!-- databook:id: nl-query -->',
    '```text',
    nlQuery,
    '```',
    ''
  ].join('\n')

  // Block 2 -- generated-sparql
  const sparqlBlock = sparql
    ? [
        '## Generated SPARQL',
        '',
        '<!-- databook:id: generated-sparql -->',
        '```sparql',
        sparql,
        '```',
        ''
      ].join('\n')
    : [
        '## Generated SPARQL',
        '',
        '<!-- databook:id: generated-sparql -->',
        '```text',
        status === 'unanswerable'
          ? 'UNANSWERABLE -- question cannot be answered from the GGSC graph.'
          : `No query generated. Error: ${error ?? 'unknown'}`,
        '```',
        ''
      ].join('\n')

  // Block 3 -- raw-bindings (JSON)
  const bindingsJson = JSON.stringify(
    { vars, bindings },
    null,
    2
  )
  const bindingsBlock = [
    '## Raw Bindings',
    '',
    `_${bindings.length} result${bindings.length !== 1 ? 's' : ''} -- variables: ${vars.length > 0 ? vars.join(', ') : 'none'}_`,
    '',
    '<!-- databook:id: raw-bindings -->',
    '```json',
    bindingsJson,
    '```',
    ''
  ].join('\n')

  // Block 4 -- formatted-results (pre-formatter text output)
  const formattedBlock = [
    '## Formatted Results',
    '',
    '<!-- databook:id: formatted-results -->',
    '```text',
    formattedResults ?? '(no results)',
    '```',
    ''
  ].join('\n')

  // Block 5 -- interpretation
  const interpretationBlock = [
    '## Interpretation',
    '',
    '<!-- databook:id: interpretation -->',
    '```text',
    answer ?? '(no interpretation)',
    '```',
    ''
  ].join('\n')

  // Block 6 -- session-metadata (YAML)
  const metaBlock = [
    '## Session Metadata',
    '',
    '<!-- databook:id: session-metadata -->',
    '```yaml',
    `queryId: ${queryId}`,
    `timestamp: ${ts}`,
    `status: ${status}`,
    `retries: ${retries}`,
    `resultCount: ${bindings.length}`,
    `model: ${model}`,
    `endpoint: ${endpoint}`,
    namedGraphs.length > 0
      ? `namedGraphs:\n${namedGraphs.map(g => `  - "${g}"`).join('\n')}`
      : `namedGraphs: []`,
    error ? `error: |\n  ${error.replace(/\n/g, '\n  ')}` : '',
    '```',
    ''
  ].filter(line => line !== undefined).join('\n')

  return [
    frontmatter,
    heading,
    '## NL Query\n',
    nlBlock,
    sparqlBlock,
    bindingsBlock,
    formattedBlock,
    interpretationBlock,
    metaBlock
  ].join('\n')
}
