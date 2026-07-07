/**
 * session-state.js -- Local file-backed persistence for bridge session state
 *
 * Problem: DATASET, JENA_BASE, SHACL_REQUIRED, etc. are module-level
 * mutable state, hot-swappable at runtime via POST /dataset, POST
 * /fuseki-url, POST /shacl-mode -- but every one of them resets to its
 * hardcoded/env-var default on any bridge restart (crash, deploy, manual
 * kill), silently. An operator who switched datasets an hour ago has no
 * way to know the bridge quietly reverted underneath them -- and because
 * graph IRIs are absolute strings independent of which Fuseki dataset is
 * active, a write issued against the wrong (stale-default) dataset does
 * NOT error: it silently creates a fresh, empty, identically-named graph
 * in the wrong place. See the July 2026 "IcyBody" incident for a worked
 * example of exactly this failure mode.
 *
 * This module makes the *last known* values durable across restarts by
 * writing them to a local JSON file next to server.js, outside Fuseki --
 * deliberately outside Fuseki, because state needed to figure out how to
 * reach Fuseki shouldn't itself require reaching Fuseki to read. That
 * also means it degrades gracefully (falls through to CLI/env/hardcoded
 * defaults) if Fuseki happens to be briefly unreachable at boot.
 *
 * Write-through, not reset-detection: every call that actually changes
 * one of these values calls saveSessionState() synchronously as part of
 * handling that request, so the file is never more than one write behind
 * reality regardless of how the process later dies (clean shutdown,
 * crash, OOM kill, kill -9 -- none of these get a chance to run cleanup
 * code, so there is nothing to "detect" reliably; the file must already
 * be correct going in).
 *
 * Scope: per-bridge-instance, not per-user. This bridge currently has no
 * per-request actor identity (one shared BEARER_TOKEN, no session/user
 * concept at the HTTP layer) -- this file is a durable version of the
 * existing module-level DATASET/JENA_BASE/SHACL_REQUIRED lets, nothing
 * more. If per-actor concurrent state is ever wanted, that's a distinct,
 * larger change (actor identity threaded through every request) and
 * should not be bolted onto this file silently.
 *
 * Storage shape is an open bag, not a fixed schema, so future session
 * variables can be added without a migration:
 *   { dataset, jenaBase, shaclRequired, updatedAt, ...future fields }
 */

import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const STATE_FILE = join(process.cwd(), '.bridge-session-state.json')

/**
 * Read persisted session state. Tolerant of a missing or corrupt file --
 * returns {} rather than throwing, since this is a fallback layer below
 * CLI args and env vars, never a required input.
 *
 * @returns {object}
 */
export function loadSessionState() {
  try {
    const raw = readFileSync(STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    console.warn(`[SessionState] ${STATE_FILE} did not contain a JSON object -- ignoring`)
    return {}
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[SessionState] Could not read ${STATE_FILE}: ${err.message} -- ignoring`)
    }
    return {}
  }
}

/**
 * Merge new fields into persisted session state and write synchronously.
 * Called inline from the request handlers that change state (POST
 * /dataset, POST /fuseki-url, POST /shacl-mode) -- not fire-and-forget --
 * so the file is guaranteed durable before the HTTP response for the
 * change that caused it is sent.
 *
 * Writes to a temp file and renames over the target (atomic on both
 * POSIX and NTFS) rather than writing STATE_FILE directly, so a crash
 * mid-write can't leave a half-written, unparseable state file behind
 * for the next boot to choke on.
 *
 * @param {object} patch  Fields to merge into existing state
 * @returns {object}      The full merged state that was written
 */
export function saveSessionState(patch) {
  const current = loadSessionState()
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() }
  const tmpFile = `${STATE_FILE}.tmp`
  try {
    writeFileSync(tmpFile, JSON.stringify(next, null, 2))
    renameSync(tmpFile, STATE_FILE)
  } catch (err) {
    console.warn(`[SessionState] Could not persist to ${STATE_FILE}: ${err.message}`)
  }
  return next
}

export { STATE_FILE }
