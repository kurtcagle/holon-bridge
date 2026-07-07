#!/usr/bin/env node
/**
 * bin/holon.js -- CLI wrapper over lib/lifecycle.js
 *
 * Same relationship to lifecycle.js that `databook push/pull` has to
 * push_turtle/get_holon: a thin script importing the shared library
 * directly, no duplicated orchestration logic.
 *
 * Usage:
 *   holon create-root --base <iri> --label <text> --actor <iri>
 *   holon add-schema --holon <iri> --file <path> --actor <iri>
 *   holon add-entity --holon <iri> --file <path> --actor <iri>
 *   holon promote --entity <iri> [--child-base <iri>] --actor <iri>
 *   holon add-projection --holon <iri> --query <iri> --mode eager|lazy --client-mode <mode> --actor <iri>
 *   holon modify-entity --entity <iri> --file <path> --actor <iri>
 *   holon annotate --entity <iri> --property <iri> --value <val> --event-type AssertionEvent|CommandEvent --actor <iri>
 *   holon list --holon <iri> [--type <iri>] --actor <iri>
 *   holon edit-metadata --holon <iri> [--title <t>] [--description <d>] [--status <s>] --actor <iri>
 *   holon delete --holon <iri> --actor <iri>
 *   holon purge --holon <iri> --actor <iri> --confirm
 *   holon designate-agent --holon <iri> --agent-iri <iri> --name <text> --kind Agent|Persona|Actor --capability Read,Write --actor <iri>
 *
 *   # Test-only, double-gated (see test-utils/clear-holarchy.js):
 *   holon test:clear-holarchy --root <iri> --confirm [--dry-run]
 *
 * Connection is read from environment (same convention as holonbridge-mcp):
 *   HOLONBRIDGE_SPARQL_ENDPOINT, HOLONBRIDGE_GSP_ENDPOINT, JENA_BASE, JENA_DATASET
 */

import * as lifecycle from '../lib/lifecycle.js'

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        out[key] = true
      } else {
        out[key] = next
        i++
      }
    } else {
      out._.push(a)
    }
  }
  return out
}

function conn() {
  return {
    sparqlEndpoint: process.env.HOLONBRIDGE_SPARQL_ENDPOINT,
    gspEndpoint: process.env.HOLONBRIDGE_GSP_ENDPOINT,
    jenaBase: process.env.JENA_BASE,
    dataset: process.env.JENA_DATASET
  }
}

async function readFileIfGiven(path) {
  if (!path) return null
  const { readFile } = await import('fs/promises')
  return readFile(path, 'utf-8')
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)
  const actor = { iri: args.actor }

  let result
  switch (cmd) {
    case 'create-root':
      result = await lifecycle.createRootHolon(conn(), { baseIri: args.base, label: args.label, actor })
      break
    case 'add-schema':
      result = await lifecycle.addSchema(conn(), args.holon, { markdown: await readFileIfGiven(args.file) }, actor)
      break
    case 'add-entity':
      result = await lifecycle.addEntity(conn(), args.holon, { markdown: await readFileIfGiven(args.file) }, actor)
      break
    case 'promote':
      result = await lifecycle.promoteEntity(conn(), args.entity, { childBaseIri: args['child-base'], actor })
      break
    case 'add-projection':
      result = await lifecycle.addProjection(conn(), args.holon, {
        queryIri: args.query, promptBlockIri: args['prompt-block'], mode: args.mode, clientMode: args['client-mode']
      }, actor)
      break
    case 'modify-entity':
      result = await lifecycle.modifyEntity(conn(), args.entity, { markdown: await readFileIfGiven(args.file) }, actor)
      break
    case 'annotate':
      result = await lifecycle.annotateProperty(conn(), args.entity, args.property, {
        value: args.value, note: args.note, eventType: args['event-type'] ?? 'AssertionEvent'
      }, actor)
      break
    case 'list':
      result = await lifecycle.listHolonContents(conn(), args.holon, { typeFilter: args.type, actor })
      break
    case 'edit-metadata':
      result = await lifecycle.editMetadata(conn(), args.holon, {
        title: args.title, description: args.description, status: args.status
      }, actor)
      break
    case 'delete':
      result = await lifecycle.deleteHolon(conn(), args.holon, { actor })
      break
    case 'purge':
      result = await lifecycle.purgeHolon(conn(), args.holon, { actor, confirm: args.confirm === true })
      break
    case 'designate-agent':
      result = await lifecycle.designateAgent(conn(), args.holon, {
        iri: args['agent-iri'], name: args.name, kind: args.kind,
        capability: (args.capability ?? '').split(',').filter(Boolean)
      }, actor)
      break
    case 'test:clear-holarchy': {
      const { clearHolarchy } = await import('../test-utils/clear-holarchy.js')
      result = await clearHolarchy(conn(), args.root, { confirm: args.confirm === true, dryRun: args['dry-run'] === true })
      break
    }
    default:
      console.error(`Unknown command: ${cmd}`)
      process.exit(1)
  }

  console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2))
}

main().catch(err => {
  console.error(`[holon] ${err.name ?? 'Error'}: ${err.message}`)
  process.exit(1)
})
