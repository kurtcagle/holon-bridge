/**
 * llm.js -- Two-stage LLM pipeline for NL-to-SPARQL bridge
 *
 * Stage 1: Query builder
 *   System: schema context (prefix-registry + class-index + property-index +
 *           query-templates + nl-hints)
 *   User:   natural language question  ->  SPARQL query
 *   Retry:  on Jena error, feed error message back for correction
 *
 * Stage 2: Interpreter
 *   System: domain expert persona
 *   User:   original NL question + pre-formatted bindings  ->  plain English answer
 */

import Anthropic from '@anthropic-ai/sdk'
import { timedProcess } from './timing.js'

let _client = null

function client() {
  if (!_client) _client = new Anthropic()  // reads ANTHROPIC_API_KEY from env
  return _client
}

// --- Prompt templates --------------------------------------------------------

const BUILDER_SYSTEM = (schemaContext, namedGraphs = []) => {
  const graphSection = namedGraphs.length > 0
    ? `\nNAMED GRAPHS IN THIS JENA DATASET:\n${namedGraphs.map(g => `  <${g}>`).join('\n')}\n`
    : '\nNAMED GRAPHS: None discovered -- target the default graph.\n'

  return `\
You are a SPARQL query generator for the UN Global Geodesy Supply Chain (GGSC) \
knowledge graph, served by Apache Jena 6.0 Fuseki (SPARQL 1.2).

Your task is to generate a single valid SPARQL SELECT query that answers the user's question.

SCHEMA CONTEXT:
${schemaContext}
${graphSection}
NAMED GRAPH RULES:
- Always use FROM <graphIRI> to scope queries to the relevant named graph.
- If the question clearly targets one graph, use a single FROM clause.
- If the question spans multiple graphs (e.g. comparing scenarios), use multiple FROM clauses or GRAPH ?g { } patterns.
- Use GRAPH <graphIRI> { ... } inside WHERE for graph-scoped triple patterns.
- Only omit FROM/GRAPH when explicitly querying across all graphs (rare).

GENERAL RULES:
1. Return ONLY the raw SPARQL query -- no explanation, no markdown fences, no preamble.
2. Always include PREFIX declarations at the top (use the prefix registry above).
3. Prefer the query templates for known question types; slot-fill rather than free-form.
4. For unknown entities (organisation names, observatory names), use rdfs:label FILTER \
with CONTAINS() or LCASE() matching rather than assuming IRIs.
5. Always add FILTER(LANG(?label) = "en") when binding rdfs:label variables.
6. Use OPTIONAL for properties that may be absent (operational status, coordinates, etc.).
7. Jena 6.0 supports SPARQL 1.2 -- standard T03 annotation syntax is valid.
8. If the question cannot be answered from the GGSC graph, return the single word: UNANSWERABLE`
}

const BUILDER_USER = (nlQuery) =>
  `Generate a SPARQL query to answer this question:\n${nlQuery}`

const BUILDER_RETRY = (nlQuery, prevQuery, jenaError) =>
  `The previous SPARQL query failed with this error from Jena:

ERROR:
${jenaError}

FAILED QUERY:
${prevQuery}

ORIGINAL QUESTION:
${nlQuery}

Generate a corrected SPARQL query. Return ONLY the raw SPARQL, no explanation.`

const INTERPRETER_SYSTEM = `\
You are a geodetic domain expert helping users understand the UN Global Geodesy \
Supply Chain (GGSC) -- a global framework for coordinating geodetic infrastructure, \
capabilities, and organisations.

Your task is to interpret SPARQL query results and provide a clear, direct answer \
to the user's question in plain English.

RULES:
1. Answer the question directly and concisely.
2. Do not mention SPARQL, IRIs, triples, or graph terms.
3. Use geodetic domain terminology naturally (VLBI, SLR, GNSS, PPTD scores, etc.).
4. If results are empty, say so clearly and suggest what might explain the absence.
5. For numerical scores (PPTD maturity), contextualise them: 0-2 = initial/developing, \
2-3 = defined, 3-4 = managed, 4-5 = optimising.
6. Keep answers concise -- 2-5 sentences unless a list is genuinely the right form.`

const INTERPRETER_USER = (nlQuery, formattedResults) =>
  `Original question: ${nlQuery}

Query results:
${formattedResults}

Provide a clear, direct answer to the question based on these results.`

// --- Stage 1: Query builder ---------------------------------------------------

/**
 * Generate a SPARQL query from a natural language question.
 * Returns the raw query string (or 'UNANSWERABLE').
 *
 * @param {string} nlQuery        Natural language question
 * @param {string} schemaContext  Pre-built schema context string from DataBook
 * @param {string} model          Claude model string
 * @param {boolean} log           Log prompts to console
 */
export async function buildQuery(nlQuery, schemaContext, namedGraphs, model, log = false) {
  const messages = [{ role: 'user', content: BUILDER_USER(nlQuery) }]
  return _callBuilder(messages, schemaContext, namedGraphs, model, log)
}

/**
 * Retry query generation after a Jena error.
 */
export async function retryQuery(nlQuery, prevQuery, jenaError, schemaContext, namedGraphs, model, log = false) {
  const messages = [
    { role: 'user',      content: BUILDER_USER(nlQuery) },
    { role: 'assistant', content: prevQuery },
    { role: 'user',      content: BUILDER_RETRY(nlQuery, prevQuery, jenaError) }
  ]
  return _callBuilder(messages, schemaContext, namedGraphs, model, log)
}

async function _callBuilder(messages, schemaContext, namedGraphs, model, log) {
  if (log) console.log('[LLM] Builder call -- messages:', messages.length)

  return timedProcess(`LLM builder call (${model}, ${messages.length} msg)`, async () => {
    const response = await client().messages.create({
      model,
      max_tokens: 1024,
      system:     BUILDER_SYSTEM(schemaContext, namedGraphs),
      messages
    })

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim()

    // Strip any accidental markdown fences the model slipped in
    return text
      .replace(/^```[^\n]*\n?/, '')
      .replace(/\n?```$/, '')
      .trim()
  })
}

// --- Stage 2: Interpreter -----------------------------------------------------

/**
 * Interpret pre-formatted SPARQL results as a plain English answer.
 *
 * @param {string} nlQuery         Original natural language question
 * @param {string} formattedResults  Output of formatBindings()
 * @param {string} model             Claude model string
 * @param {boolean} log
 */
export async function interpretResults(nlQuery, formattedResults, model, log = false) {
  if (log) console.log('[LLM] Interpreter call')

  return timedProcess(`LLM interpreter call (${model})`, async () => {
    const response = await client().messages.create({
      model,
      max_tokens: 512,
      system:     INTERPRETER_SYSTEM,
      messages: [{
        role:    'user',
        content: INTERPRETER_USER(nlQuery, formattedResults)
      }]
    })

    return response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim()
  })
}
