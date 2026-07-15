/**
 * write-events.js -- process-wide EventEmitter for successful graph writes.
 *
 * The push side of scheduler.js's aperiodic (StateTrigger) evaluation --
 * see scheduler-personas.databook.md section 5, which took a deliberate
 * position against polling: introducing a poll loop here would reintroduce
 * exactly the kind of per-source special-casing MCP-Postgres-Jena-
 * Analysis-v3.md already argued against for external ingestion.
 *
 * Wired at exactly two call sites, both in lib/sparql.js: pushToGraph()
 * and runUpdate(). Every other write path in this codebase -- server.js's
 * /update and /sparql-update routes, and all eighteen lib/lifecycle.js
 * verbs (directly or via replaceTriples(), which itself calls runUpdate())
 * -- bottoms out through one of those two functions. Instrumenting there
 * gives full write-event coverage without touching lifecycle.js's ~80KB
 * at all, a smaller and lower-risk surface than instrumenting all eighteen
 * verbs individually would have been.
 *
 * Single shared instance: Node ES modules are singletons per process, so
 * every importer (lib/sparql.js emitting, scheduler.js subscribing) sees
 * the same emitter without any explicit wiring beyond the import itself.
 * This module deliberately has no knowledge of what (if anything) is
 * listening -- sparql.js's emitWrite() is a no-op in cost if nothing has
 * subscribed yet (Node's EventEmitter.emit() with zero listeners is just a
 * cheap array-length check).
 */

import { EventEmitter } from 'node:events'

export const writeEvents = new EventEmitter()
writeEvents.setMaxListeners(100) // generous headroom for many subscribed tasks

/**
 * @param {object} detail
 * @param {string|null} detail.graph   Named graph IRI written to (null = default graph)
 * @param {'gsp'|'update'} detail.via  Which primitive performed the write
 * @param {number} [detail.chars]      Rough size signal (turtle/update string length)
 */
export function emitWrite(detail) {
  writeEvents.emit('write', { ...detail, at: Date.now() })
}
