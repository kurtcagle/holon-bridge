/**
 * scheduler.js -- HolonBridge task scheduler with persona-scoped invocation
 *
 * Implements scheduled-services-safety.databook.md (action classes,
 * propose-validate-apply pipeline, per-task ODRL scoping) and
 * scheduler-personas.databook.md (persona capability layer, push-based
 * aperiodic triggers, admin-dataset placement). Both documents are the
 * authoritative design record; this file is their implementation, not a
 * reinterpretation -- see the two docs for the *why* behind each gate.
 *
 * Nothing in the autonomous path here is trusted that isn't already
 * trusted in the interactive path: an LLMInvocation's output is always a
 * proposal, gated by the same SHACL shape-validation used for interactive
 * writes, never written directly.
 *
 * All scheduler state lives in the `admin` Fuseki dataset (no dataset of
 * its own -- see scheduler-personas.databook.md section 6), as named
 * graphs:
 *   urn:scheduler:tasks       sched:ScheduledTask holons
 *   urn:scheduler:personas    sched:Persona holons
 *   urn:scheduler:policy      ODRL policy documents (top-tier governed)
 *   urn:scheduler:provenance  one record per firing (commit or quarantine)
 *   urn:scheduler:quarantine  rejected proposals, for operator review
 *
 * Every call this module makes against Fuseki pins X-Dataset-Override to
 * ADMIN_DATASET explicitly -- never inherited from whatever the bridge's
 * ambient DATASET happens to be. Direct continuation of the 2026-07-15
 * admin.js fix; the whole reason that incident happened is the reason this
 * discipline is non-negotiable here too.
 */

import { randomUUID } from 'node:crypto'
import Anthropic from '@anthropic-ai/sdk'
import { runQuery, pushToGraph, runUpdate } from './sparql.js'
import { validateWithShacl } from './shacl.js'
import { writeEvents } from './write-events.js'

const SCHED = 'https://w3id.org/holon/sched#'
const HOLON = 'https://w3id.org/holon/'
const ODRL  = 'http://www.w3.org/ns/odrl/2/'

const ACTION_CLASSES = new Set(['ReadOnlyQuery', 'GraphWrite', 'LLMInvocation', 'ExternalCall'])

let _anthropic = null
function anthropicClient() {
  if (!_anthropic) _anthropic = new Anthropic() // reads ANTHROPIC_API_KEY from env
  return _anthropic
}

// --- Rejection classes, mirroring lib/lifecycle.js's CommandRejected/UnauthorisedError pattern ---

export class CapabilityRejected extends Error {
  constructor(reason, taskIri, personaIri, actionClass) {
    super(reason)
    this.name = 'CapabilityRejected'
    this.taskIri = taskIri
    this.personaIri = personaIri
    this.actionClass = actionClass
  }
}

export class PolicyRejected extends Error {
  constructor(reason, taskIri, personaIri) {
    super(reason)
    this.name = 'PolicyRejected'
    this.taskIri = taskIri
    this.personaIri = personaIri
  }
}

// ---------------------------------------------------------------------------
// Scheduler class
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string} opts.jenaBase          e.g. http://localhost:3030
 * @param {string} opts.adminDataset      Fuseki dataset holding scheduler state (default 'admin')
 * @param {number} [opts.tickIntervalMs]  Periodic-trigger check interval (default 30s)
 * @param {boolean} [opts.dryRun]         If true, never actually calls Anthropic or commits --
 *                                        runs the full gate sequence and logs what WOULD happen.
 *                                        Intended for first-deploy verification.
 */
export class Scheduler {
  constructor({ jenaBase, adminDataset = 'admin', tickIntervalMs = 30_000, dryRun = false }) {
    this.jenaBase     = jenaBase
    this.adminDataset = adminDataset
    this.sparqlEndpoint = `${jenaBase}/${adminDataset}/sparql`
    this.gspEndpoint     = `${jenaBase}/${adminDataset}/data`
    this.tickIntervalMs = tickIntervalMs
    this.dryRun = dryRun

    this._tasks = new Map()      // taskIri -> task object
    this._personas = new Map()   // personaIri -> persona object
    this._lastFired = new Map()  // taskIri -> ms timestamp
    this._timer = null
    this._writeListener = null
    this._running = false
    // Reentrancy guard: every write this scheduler makes on its own behalf
    // (provenance records, quarantine records, and commits themselves) goes
    // through the same instrumented pushToGraph()/runUpdate() as everything
    // else, and therefore emits its own 'write' event right back onto the
    // same bus _onWrite listens on. Without this guard a StateTrigger broad
    // enough to match the scheduler's own output (or simply "any write at
    // all", which is a legitimate thing to want to react to) would
    // recursively re-fire itself -- caught empirically as an OOM crash
    // while testing the aperiodic path, not spotted by design review alone.
    // Depth-counted rather than boolean so nested firings (a StateTrigger
    // task whose own commit could theoretically satisfy a second task's
    // trigger) still suppress correctly without needing a stack.
    this._firingDepth = 0
  }

  // -- Lifecycle --------------------------------------------------------------

  async start() {
    if (this._running) return
    await this.reload()
    this._timer = setInterval(() => this._tick().catch(err =>
      console.error('[scheduler] tick error:', err.message)), this.tickIntervalMs)
    this._writeListener = (detail) => this._onWrite(detail).catch(err =>
      console.error('[scheduler] write-event handler error:', err.message))
    writeEvents.on('write', this._writeListener)
    this._running = true
    console.log(`[scheduler] started -- dataset=${this.adminDataset}, ` +
      `${this._tasks.size} task(s), ${this._personas.size} persona(s), ` +
      `tick=${this.tickIntervalMs}ms${this.dryRun ? ' [DRY RUN]' : ''}`)
  }

  stop() {
    if (this._timer) clearInterval(this._timer)
    if (this._writeListener) writeEvents.off('write', this._writeListener)
    this._running = false
    console.log('[scheduler] stopped')
  }

  /** Reload tasks and personas from Fuseki. Safe to call while running. */
  async reload() {
    this._personas = await this._loadPersonas()
    this._tasks = await this._loadTasks()
  }

  // -- Loading state from Fuseki -----------------------------------------------

  async _loadPersonas() {
    const q = `
PREFIX sched: <${SCHED}>
PREFIX holon: <${HOLON}>
PREFIX odrl:  <${ODRL}>
SELECT ?p ?label ?remit ?model ?promptBlock ?datasetScope ?policy WHERE {
  GRAPH <urn:scheduler:personas> {
    ?p a sched:Persona .
    OPTIONAL { ?p holon:label ?label }
    OPTIONAL { ?p sched:remit ?remit }
    OPTIONAL { ?p sched:model ?model }
    OPTIONAL { ?p sched:systemPromptBlock ?promptBlock }
    OPTIONAL { ?p sched:datasetScope ?datasetScope }
    OPTIONAL { ?p odrl:hasPolicy ?policy }
  }
}`
    const { bindings } = await runQuery(this.sparqlEndpoint, q)
    const personas = new Map()
    for (const b of bindings) {
      const iri = b.p.value
      if (!personas.has(iri)) {
        personas.set(iri, {
          iri,
          label: b.label?.value ?? iri,
          remit: b.remit?.value ?? '',
          model: b.model?.value ?? 'claude-sonnet-4-6',
          promptBlock: b.promptBlock?.value ?? null,
          datasetScope: b.datasetScope?.value ?? null,
          policy: b.policy?.value ?? null,
          capability: new Set(),
        })
      }
    }
    // Capability sets fetched separately -- multi-valued property, avoid the
    // cartesian-product-with-other-optionals problem the single query above
    // would otherwise hit.
    for (const [iri, persona] of personas) {
      const capQ = `
PREFIX sched: <${SCHED}>
SELECT ?cap WHERE { GRAPH <urn:scheduler:personas> { <${iri}> sched:capability ?cap } }`
      const { bindings: capBindings } = await runQuery(this.sparqlEndpoint, capQ)
      for (const cb of capBindings) {
        persona.capability.add(cb.cap.value.split(/[/#]/).pop())
      }
    }
    return personas
  }

  async _loadTasks() {
    const q = `
PREFIX sched: <${SCHED}>
PREFIX odrl:  <${ODRL}>
SELECT ?t ?actionClass ?triggerType ?intervalMs ?triggerSelect ?persona ?sparql
       ?targetDataset ?targetGraph ?policy WHERE {
  GRAPH <urn:scheduler:tasks> {
    ?t a sched:ScheduledTask ;
       sched:actionClass ?actionClass .
    OPTIONAL { ?t sched:trigger [ a ?triggerType ] }
    OPTIONAL { ?t sched:trigger [ sched:intervalMs ?intervalMs ] }
    OPTIONAL { ?t sched:trigger [ sched:triggerSelect ?triggerSelect ] }
    OPTIONAL { ?t sched:invokesPersona ?persona }
    OPTIONAL { ?t sched:sparql ?sparql }
    OPTIONAL { ?t sched:targetDataset ?targetDataset }
    OPTIONAL { ?t sched:targetGraph ?targetGraph }
    OPTIONAL { ?t odrl:hasPolicy ?policy }
  }
}`
    const { bindings } = await runQuery(this.sparqlEndpoint, q)
    const tasks = new Map()
    for (const b of bindings) {
      const iri = b.t.value
      tasks.set(iri, {
        iri,
        actionClass: (b.actionClass?.value ?? '').split(/[/#]/).pop(),
        triggerType: (b.triggerType?.value ?? '').split(/[/#]/).pop(),
        intervalMs: b.intervalMs?.value ? parseInt(b.intervalMs.value, 10) : null,
        triggerSelect: b.triggerSelect?.value ?? null,
        personaIri: b.persona?.value ?? null,
        sparql: b.sparql?.value ?? null,
        targetDataset: b.targetDataset?.value ?? this.adminDataset,
        targetGraph: b.targetGraph?.value ?? null,
        policyIri: b.policy?.value ?? null,
      })
    }
    return tasks
  }

  // -- Trigger evaluation -------------------------------------------------------

  async _tick() {
    const now = Date.now()
    for (const task of this._tasks.values()) {
      if (task.triggerType !== 'TemporalTrigger' || !task.intervalMs) continue
      const last = this._lastFired.get(task.iri) ?? 0
      if (now - last >= task.intervalMs) {
        this._lastFired.set(task.iri, now)
        await this.fire(task, { triggerType: 'TemporalTrigger', at: now })
      }
    }
  }

  async _onWrite(detail) {
    if (this._firingDepth > 0) return // see constructor comment -- avoid self-triggering feedback loops
    for (const task of this._tasks.values()) {
      if (task.triggerType !== 'StateTrigger' || !task.triggerSelect) continue
      let fires = false
      try {
        // NOTE: this codebase's runQuery() (lib/sparql.js) parses
        // application/sparql-results+json's `results.bindings` and has no
        // handling for ASK's `{ boolean: ... }` response shape -- rather
        // than extend that shared primitive just for this one caller,
        // sched:triggerSelect is a SELECT query; the task fires if it returns
        // one or more rows. Equivalent expressive power to ASK for this
        // purpose (wrap any condition in `SELECT * WHERE { FILTER(...) }`),
        // zero changes needed to sparql.js beyond the write-event wiring
        // already added.
        const { bindings } = await runQuery(this.sparqlEndpoint, task.triggerSelect)
        fires = bindings.length > 0
      } catch (err) {
        console.warn(`[scheduler] StateTrigger query failed for ${task.iri}: ${err.message}`)
        continue
      }
      if (fires) await this.fire(task, { triggerType: 'StateTrigger', causedBy: detail })
    }
  }

  /** Manual firing -- used by admin API's run-now endpoint and by tests. */
  async fire(task, triggerContext) {
    console.log(`[scheduler] firing ${task.iri} (${triggerContext.triggerType})`)
    this._firingDepth++
    try {
      const result = await this._execute(task, triggerContext)
      return result
    } catch (err) {
      console.error(`[scheduler] ${task.iri} firing failed: ${err.message}`)
      throw err
    } finally {
      this._firingDepth--
    }
  }

  // -- Execution pipeline (scheduler-personas.databook.md section 7) -----------

  async _execute(task, triggerContext) {
    const persona = task.personaIri ? this._personas.get(task.personaIri) : null
    if (task.personaIri && !persona) {
      throw new CapabilityRejected(
        `Task <${task.iri}> names persona <${task.personaIri}>, which is not registered`,
        task.iri, task.personaIri, task.actionClass)
    }

    // Step 2: persona capability gate -- pure set-membership, before Fuseki is touched again.
    if (persona && !persona.capability.has(task.actionClass)) {
      const reason = `Persona <${persona.iri}> (${persona.label}) lacks capability ` +
        `"${task.actionClass}" -- has {${[...persona.capability].join(', ')}}`
      await this._recordProvenance(task, persona, triggerContext, { outcome: 'rejected-capability', reason })
      throw new CapabilityRejected(reason, task.iri, persona?.iri ?? null, task.actionClass)
    }

    // Step 3: pre-action policy gate -- rate limit, persona ∩ task intersection.
    // v0 implementation: count today's commits/quarantines for this task
    // (and, if a persona is named, for that persona too) against each
    // policy's odrl:count constraint. Narrower of the two wins.
    const rateCheck = await this._checkRateLimit(task, persona)
    if (!rateCheck.ok) {
      await this._recordProvenance(task, persona, triggerContext, { outcome: 'rejected-policy', reason: rateCheck.reason })
      throw new PolicyRejected(rateCheck.reason, task.iri, persona?.iri ?? null)
    }

    if (this.dryRun) {
      console.log(`[scheduler] [DRY RUN] ${task.iri} passed capability + policy gates -- not executing`)
      return { outcome: 'dry-run', task: task.iri, persona: persona?.iri ?? null }
    }

    // Step 4: execution -- produces a PROPOSAL, never a direct write.
    const proposal = await this._runAction(task, persona)

    if (task.actionClass === 'ReadOnlyQuery') {
      // No write to gate -- record and return.
      await this._recordProvenance(task, persona, triggerContext, { outcome: 'read-only', result: proposal })
      return { outcome: 'read-only', task: task.iri, result: proposal }
    }

    // Steps 5-6: shape + policy gate on the concrete proposed delta.
    const targetSparql = `${this.jenaBase}/${task.targetDataset}/sparql`
    const shapesGraph = `urn:${task.targetDataset}:shacl`
    let report
    try {
      report = await validateWithShacl(this.jenaBase, task.targetDataset, shapesGraph,
        proposal.turtle, task.targetGraph)
    } catch (err) {
      await this._recordProvenance(task, persona, triggerContext,
        { outcome: 'quarantined', reason: `SHACL validation could not run: ${err.message}`, proposal })
      return this._quarantine(task, persona, triggerContext, proposal,
        `SHACL validation could not run: ${err.message}`)
    }

    if (report.conforms === false) {
      const reason = `SHACL violations: ${(report.violations ?? []).map(v => v.message).join('; ')}`
      return this._quarantine(task, persona, triggerContext, proposal, reason)
    }

    // Step 7: commit.
    const targetGsp = `${this.jenaBase}/${task.targetDataset}/data`
    await pushToGraph(targetGsp, task.targetGraph, proposal.turtle, 'append')
    await this._recordProvenance(task, persona, triggerContext, { outcome: 'committed', proposal })
    return { outcome: 'committed', task: task.iri, persona: persona?.iri ?? null, graph: task.targetGraph }
  }

  async _runAction(task, persona) {
    if (task.actionClass === 'ReadOnlyQuery' || task.actionClass === 'GraphWrite') {
      if (!task.sparql) throw new Error(`Task <${task.iri}> has no sched:sparql to execute`)
      if (task.actionClass === 'ReadOnlyQuery') {
        const targetSparql = `${this.jenaBase}/${task.targetDataset}/sparql`
        const { bindings } = await runQuery(targetSparql, task.sparql)
        return { bindings }
      }
      // GraphWrite without a persona: the task's own SPARQL IS the proposal
      // turtle (a CONSTRUCT result, or literal turtle stored on the task).
      return { turtle: task.sparql }
    }

    if (task.actionClass === 'LLMInvocation') {
      const systemPrompt = await this._resolvePromptBlock(persona?.promptBlock) ??
        `You are an autonomous HolonBridge scheduled task. Produce a Turtle proposal only.`
      const model = persona?.model ?? 'claude-sonnet-4-6'
      const response = await anthropicClient().messages.create({
        model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: task.sparql ?? 'Describe what you would do. Return only Turtle.' }],
      })
      const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim()
      const turtle = text.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '').trim()
      return { turtle, model, promptHash: _hashString(systemPrompt) }
    }

    throw new Error(`Action class "${task.actionClass}" is not yet implemented (ExternalCall reserved)`)
  }

  async _resolvePromptBlock(promptBlockIri) {
    if (!promptBlockIri) return null
    const q = `
PREFIX holon: <${HOLON}>
SELECT ?text WHERE { <${promptBlockIri}> holon:promptText ?text }`
    try {
      const { bindings } = await runQuery(this.sparqlEndpoint, q)
      return bindings[0]?.text?.value ?? null
    } catch {
      return null
    }
  }

  // -- Policy: rate limiting via provenance count ------------------------------

  async _checkRateLimit(task, persona) {
    const today = new Date().toISOString().slice(0, 10)
    const countQ = (subjectIri, prop) => `
PREFIX sched: <${SCHED}>
SELECT (COUNT(?rec) AS ?c) WHERE {
  GRAPH <urn:scheduler:provenance> {
    ?rec sched:${prop} <${subjectIri}> ;
         sched:firedAt ?ts ;
         sched:outcome ?outcome .
    FILTER(STRSTARTS(STR(?ts), "${today}"))
    FILTER(?outcome IN ("committed", "read-only"))
  }
}`
    const taskLimit = await this._resolvePolicyCount(task.policyIri)
    if (taskLimit !== null) {
      const { bindings } = await runQuery(this.sparqlEndpoint, countQ(task.iri, 'task'))
      const count = parseInt(bindings[0]?.c?.value ?? '0', 10)
      if (count >= taskLimit) {
        return { ok: false, reason: `Task <${task.iri}> has reached its daily firing limit (${taskLimit})` }
      }
    }
    if (persona) {
      const personaLimit = await this._resolvePolicyCount(persona.policy)
      if (personaLimit !== null) {
        const { bindings } = await runQuery(this.sparqlEndpoint, countQ(persona.iri, 'persona'))
        const count = parseInt(bindings[0]?.c?.value ?? '0', 10)
        if (count >= personaLimit) {
          return { ok: false, reason: `Persona <${persona.iri}> has reached its daily firing limit (${personaLimit})` }
        }
      }
    }
    return { ok: true }
  }

  async _resolvePolicyCount(policyIri) {
    if (!policyIri) return null
    const q = `
PREFIX odrl: <${ODRL}>
SELECT ?count WHERE {
  <${policyIri}> odrl:permission ?perm .
  ?perm odrl:constraint ?c .
  ?c odrl:leftOperand odrl:count ;
     odrl:rightOperand ?count .
}`
    try {
      const { bindings } = await runQuery(this.sparqlEndpoint, q)
      return bindings[0]?.count?.value !== undefined ? parseInt(bindings[0].count.value, 10) : null
    } catch {
      return null
    }
  }

  // -- Quarantine and provenance ------------------------------------------------

  async _quarantine(task, persona, triggerContext, proposal, reason) {
    const recordIri = `urn:scheduler:quarantine:${randomUUID()}`
    const turtle = `
@prefix sched: <${SCHED}> .
@prefix xsd:   <http://www.w3.org/2001/XMLSchema#> .

<${recordIri}> a sched:QuarantinedProposal ;
    sched:task <${task.iri}> ;
    ${persona ? `sched:persona <${persona.iri}> ;` : ''}
    sched:reason "${reason.replace(/"/g, '\\"').slice(0, 1000)}" ;
    sched:quarantinedAt "${new Date().toISOString()}"^^xsd:dateTime ;
    sched:proposedTurtle """${(proposal.turtle ?? '').replace(/"""/g, '\\"\\"\\"')}""" .
`.trim()
    await pushToGraph(this.gspEndpoint, 'urn:scheduler:quarantine', turtle, 'append')
    await this._recordProvenance(task, persona, triggerContext, { outcome: 'quarantined', reason, proposal })
    console.warn(`[scheduler] QUARANTINED ${task.iri}: ${reason}`)
    return { outcome: 'quarantined', task: task.iri, persona: persona?.iri ?? null, reason, record: recordIri }
  }

  async _recordProvenance(task, persona, triggerContext, { outcome, reason, proposal }) {
    const recordIri = `urn:scheduler:provenance:${randomUUID()}`
    const now = new Date().toISOString()
    const turtle = `
@prefix sched: <${SCHED}> .
@prefix xsd:   <http://www.w3.org/2001/XMLSchema#> .

<${recordIri}> a sched:FiringRecord ;
    sched:task <${task.iri}> ;
    ${persona ? `sched:persona <${persona.iri}> ;` : ''}
    ${persona?.policy ? `sched:personaPolicyVersion <${persona.policy}> ;` : ''}
    ${task.policyIri ? `sched:taskPolicyVersion <${task.policyIri}> ;` : ''}
    sched:triggerType "${triggerContext.triggerType}" ;
    sched:outcome "${outcome}" ;
    ${reason ? `sched:reason "${reason.replace(/"/g, '\\"').slice(0, 1000)}" ;` : ''}
    ${proposal?.model ? `sched:model "${proposal.model}" ;` : ''}
    ${proposal?.promptHash ? `sched:promptHash "${proposal.promptHash}" ;` : ''}
    sched:firedAt "${now}"^^xsd:dateTime .
`.trim()
    // Provenance writes are best-effort logged but not allowed to mask the
    // real outcome of the firing itself -- a provenance-write failure is a
    // console warning, not a thrown error up through fire()/_execute().
    try {
      await pushToGraph(this.gspEndpoint, 'urn:scheduler:provenance', turtle, 'append')
    } catch (err) {
      console.warn(`[scheduler] provenance write failed for ${task.iri}: ${err.message}`)
    }
  }
}

function _hashString(s) {
  // Cheap non-cryptographic hash for provenance display only -- not a
  // security boundary, just enough to tell "same prompt" from "different
  // prompt" at a glance in the provenance graph.
  let h = 0
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0 }
  return (h >>> 0).toString(16)
}
