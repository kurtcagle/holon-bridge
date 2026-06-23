#!/usr/bin/env node
/**
 * scripts/setup-env.js
 *
 * Interactive setup for HolonBridge environment configuration.
 *
 * Separates CONFIGURATION (safe in .env) from SECRETS (must be OS env vars).
 *
 * What it does:
 *   1. Reads current values from process.env and existing .env
 *   2. Walks you through each variable interactively
 *   3. Writes non-sensitive config to .env (in the project root)
 *   4. Outputs OS commands to set secrets in the system environment
 *      — Linux/macOS: export commands for ~/.profile or systemd unit
 *      — Windows:     PowerShell SetEnvironmentVariable commands
 *
 * What it does NOT do:
 *   — Write secrets to any file on disk
 *   — Commit anything to version control
 *   — Overwrite existing .env without confirmation
 *
 * Usage:
 *   node scripts/setup-env.js
 *   node scripts/setup-env.js --non-interactive   (use existing/defaults, output only)
 */

import { createInterface }  from 'node:readline'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname }    from 'node:path'
import { fileURLToPath }    from 'node:url'
import { platform }         from 'node:os'

const __dirname     = dirname(fileURLToPath(import.meta.url))
const ROOT          = join(__dirname, '..')
const ENV_FILE      = join(ROOT, '.env')
const NON_INTERACTIVE = process.argv.includes('--non-interactive')
const IS_WINDOWS    = platform() === 'win32'

// ── Variable definitions ─────────────────────────────────────────────────────
//
// Each entry:
//   key          env var name
//   label        human-readable name
//   secret       true = must be OS env var, never written to .env
//   default      fallback if not set
//   description  shown during interactive setup

const VARIABLES = [
  // ── Secrets (OS environment only) ─────────────────────────────────────────
  {
    key:         'BEARER_TOKEN',
    label:       'HolonBridge Bearer Token',
    secret:      true,
    description: 'Master access token for HolonBridge REST API. ' +
                 'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
  },
  {
    key:         'ANTHROPIC_API_KEY',
    label:       'Anthropic API Key',
    secret:      true,
    description: 'Required for NL query (nl_query endpoint) and named query generation. ' +
                 'Obtain from https://console.anthropic.com',
  },
  {
    key:         'REGISTRY_GITHUB_TOKEN',
    label:       'GitHub Token (registry access)',
    secret:      true,
    description: 'Classic PAT with repo read scope. Used to fetch bridge registry DataBooks. ' +
                 'Generate at https://github.com/settings/tokens',
  },
  {
    key:         'MCP_REMOTE_TOKEN',
    label:       'MCP Remote Token',
    secret:      true,
    description: 'Bearer token for holonbridge-mcp-remote SSE endpoint. ' +
                 'Separate from BEARER_TOKEN. Generate with openssl rand -hex 32',
  },
  {
    key:         'HB_BEARER_TOKEN',
    label:       'HolonBridge Bearer Token (mcp-remote → bridge)',
    secret:      true,
    description: 'The BEARER_TOKEN value that holonbridge-mcp-remote uses when calling ' +
                 'the HolonBridge REST API. Must match BEARER_TOKEN above.',
  },
  // ── v3.0 key paths (set now, used later) ──────────────────────────────────
  {
    key:         'HOLONBRIDGE_PRIVATE_KEY_PATH',
    label:       'Private Key Path (v3.0)',
    secret:      true,
    description: 'Path to ES256 private key PEM file for JWT peer auth (v3.0). ' +
                 'Generate with: node scripts/generate-keys.js  Leave blank to skip for now.',
    optional:    true,
  },
  {
    key:         'HOLONBRIDGE_KEY_ID',
    label:       'Key ID (v3.0)',
    secret:      true,
    description: 'Key identifier for the bridge keypair, e.g. kurtcagle-primary-2026-06. ' +
                 'Leave blank to skip for now.',
    optional:    true,
  },

  // ── Configuration (safe in .env) ──────────────────────────────────────────
  {
    key:         'PORT',
    label:       'HolonBridge Port',
    secret:      false,
    default:     '3031',
    description: 'TCP port HolonBridge REST API listens on.',
  },
  {
    key:         'JENA_BASE',
    label:       'Jena Fuseki Base URL',
    secret:      false,
    default:     'http://localhost:3030',
    description: 'Base URL of the local Jena Fuseki instance. Never expose this publicly.',
  },
  {
    key:         'JENA_DATASET',
    label:       'Default Fuseki Dataset',
    secret:      false,
    default:     'ds',
    description: 'Default dataset name on Fuseki. Overridable at runtime via POST /dataset.',
  },
  {
    key:         'CLAUDE_MODEL',
    label:       'Claude Model',
    secret:      false,
    default:     'claude-sonnet-4-6',
    description: 'Anthropic model used for NL query generation and interpretation.',
  },
  {
    key:         'MAX_RETRIES',
    label:       'Max Query Retries',
    secret:      false,
    default:     '2',
    description: 'Number of times to retry a failed NL→SPARQL query before giving up.',
  },
  {
    key:         'LOG_SPARQL',
    label:       'Log SPARQL Queries',
    secret:      false,
    default:     'false',
    description: 'Set true to log all SPARQL queries to console (verbose, dev only).',
  },
  {
    key:         'LOG_PROMPTS',
    label:       'Log LLM Prompts',
    secret:      false,
    default:     'false',
    description: 'Set true to log all LLM prompts to console (verbose, dev only).',
  },
  {
    key:         'SHACL_REQUIRED',
    label:       'SHACL Validation Required',
    secret:      false,
    default:     'false',
    description: 'Set true to require SHACL validation on all /update pushes at startup.',
  },
  {
    key:         'REGISTRY_GITHUB_OWNER',
    label:       'Registry GitHub Owner',
    secret:      false,
    default:     'colossalhop',
    description: 'GitHub org/user owning the HolonBridge registry repository.',
  },
  {
    key:         'REGISTRY_GITHUB_REPO',
    label:       'Registry GitHub Repo',
    secret:      false,
    default:     'un-ggce-supply-chain',
    description: 'GitHub repository containing bridge registry DataBooks.',
  },
  {
    key:         'REGISTRY_CACHE_MAX_AGE',
    label:       'Registry Cache Max Age (ms)',
    secret:      false,
    default:     '86400000',
    description: 'How long to cache registry DataBooks before refreshing (default: 24h).',
  },
  {
    key:         'MCP_PORT',
    label:       'MCP Remote Port',
    secret:      false,
    default:     '3032',
    description: 'TCP port for holonbridge-mcp-remote SSE endpoint.',
  },
]

// ── Helpers ──────────────────────────────────────────────────────────────────

function mask(val) {
  if (!val) return '(not set)'
  if (val.length <= 8) return '•'.repeat(val.length)
  return val.slice(0, 4) + '•'.repeat(Math.min(val.length - 8, 20)) + val.slice(-4)
}

function loadDotenv() {
  const values = {}
  if (!existsSync(ENV_FILE)) return values
  const lines = readFileSync(ENV_FILE, 'utf8').split('\n')
  for (const line of lines) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m) values[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return values
}

function writeDotenv(values) {
  const lines = ['# HolonBridge configuration (non-sensitive)',
                 '# Generated by scripts/setup-env.js',
                 `# Updated: ${new Date().toISOString()}`,
                 '# DO NOT add secrets to this file.',
                 '']
  for (const [k, v] of Object.entries(values)) {
    lines.push(`${k}=${v}`)
  }
  writeFileSync(ENV_FILE, lines.join('\n') + '\n', 'utf8')
}

// ── Interactive prompt ────────────────────────────────────────────────────────

async function prompt(rl, question) {
  return new Promise(resolve => rl.question(question, resolve))
}

async function promptVar(rl, v, current) {
  const display = v.secret ? mask(current) : (current || v.default || '(not set)')
  console.log()
  console.log(`  ${v.label}`)
  console.log(`  ${v.description}`)
  console.log(`  Current: ${display}`)
  if (v.optional) console.log('  (optional — press Enter to skip)')

  const input = await prompt(rl, '  New value (Enter to keep): ')
  return input.trim() || current || v.default || ''
}

// ── Main ─────────────────────────────────────────────────────────────────────

console.log()
console.log('╔══════════════════════════════════════════════════════╗')
console.log('║      HolonBridge v2.9.0 — Environment Setup         ║')
console.log('╚══════════════════════════════════════════════════════╝')
console.log()
console.log('CONFIGURATION  → written to .env (safe, non-sensitive)')
console.log('SECRETS        → output as OS commands (never written to disk)')
console.log()

const dotenvValues  = loadDotenv()
const configValues  = {}   // will be written to .env
const secretValues  = {}   // will be output as OS commands

const rl = NON_INTERACTIVE ? null : createInterface({
  input:  process.stdin,
  output: process.stdout,
})

for (const v of VARIABLES) {
  const current = process.env[v.key] || dotenvValues[v.key] || v.default || ''

  let value
  if (NON_INTERACTIVE) {
    value = current
  } else {
    value = await promptVar(rl, v, current)
  }

  if (!value && !v.optional) {
    console.warn(`  ⚠  ${v.key} is required but not set — leaving blank`)
  }

  if (v.secret) {
    if (value) secretValues[v.key] = value
  } else {
    if (value) configValues[v.key] = value
  }
}

if (rl) rl.close()

// ── Write .env ────────────────────────────────────────────────────────────────

console.log()
console.log('Writing non-sensitive configuration to .env...')
writeDotenv(configValues)
console.log(`✅ .env written (${Object.keys(configValues).length} values)`)

// ── Output secret commands ────────────────────────────────────────────────────

console.log()
if (Object.keys(secretValues).length === 0) {
  console.log('No secrets to set.')
} else {
  console.log('══════════════════════════════════════════════════════')
  console.log('RUN THESE COMMANDS TO SET SECRETS IN YOUR ENVIRONMENT')
  console.log('══════════════════════════════════════════════════════')
  console.log()

  if (IS_WINDOWS) {
    console.log('# PowerShell — run as Administrator for Machine scope')
    console.log('# Or remove [Machine] for User scope (no admin required)')
    console.log()
    for (const [k, v] of Object.entries(secretValues)) {
      console.log(`[System.Environment]::SetEnvironmentVariable('${k}', '${v}', 'Machine')`)
    }
    console.log()
    console.log('# After setting, restart HolonBridge for changes to take effect.')
    console.log()
    console.log('# For Windows service, also set in service environment:')
    console.log('# sc.exe config HolonBridge start= auto')
    for (const k of Object.keys(secretValues)) {
      console.log(`# sc.exe config HolonBridge obj= LocalSystem password= ""`)
    }
  } else {
    console.log('# Bash/Zsh — add to ~/.profile or ~/.zshrc for persistence')
    console.log('# Or add to systemd service unit [Service] section')
    console.log()
    for (const [k, v] of Object.entries(secretValues)) {
      console.log(`export ${k}='${v}'`)
    }
    console.log()
    console.log('# For systemd service, add to unit file:')
    console.log('# [Service]')
    for (const k of Object.keys(secretValues)) {
      console.log(`# Environment="${k}=<value>"`)
    }
  }

  console.log()
  console.log('══════════════════════════════════════════════════════')
  console.log()
  console.log('⚠  SECURITY NOTES:')
  console.log('   — Do not paste the above output into any file that')
  console.log('     gets committed to version control.')
  console.log('   — After running, clear your terminal history:')
  if (IS_WINDOWS) {
    console.log('     Clear-History  (PowerShell)')
  } else {
    console.log('     history -c  (bash)  or  fc -p  (zsh)')
  }
  console.log('   — Consider using a password manager to store these')
  console.log('     values rather than leaving them in shell history.')
}

console.log()
console.log('Setup complete.')
console.log()
console.log('Next steps:')
console.log('  1. Run the secret commands above in your terminal')
console.log('  2. Restart HolonBridge:  npm start')
console.log('  3. Generate keypair for v3.0:  node scripts/generate-keys.js')
console.log()
