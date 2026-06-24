#!/usr/bin/env node
/**
 * scripts/setup-env.js
 *
 * Interactive setup for HolonBridge environment configuration.
 *
 * Separates CONFIGURATION (safe in .env) from SECRETS (OS env vars).
 *
 * On Windows (elevated shell): directly writes secrets to Machine-scope
 * environment variables via the Windows registry, then prints confirmation.
 *
 * On Windows (non-elevated): outputs PowerShell commands to run manually.
 *
 * On Linux/macOS: outputs export commands for ~/.profile or systemd unit.
 *
 * Usage:
 *   node scripts/setup-env.js
 *   node scripts/setup-env.js --non-interactive   (use existing/defaults)
 *   node scripts/setup-env.js --scope User        (Windows User scope, no admin)
 *   node scripts/setup-env.js --scope Machine     (Windows Machine scope, admin required)
 */

import { createInterface }                         from 'node:readline'
import { readFileSync, writeFileSync, existsSync }  from 'node:fs'
import { join, dirname }                            from 'node:path'
import { fileURLToPath }                            from 'node:url'
import { platform }                                 from 'node:os'
import { execSync }                                 from 'node:child_process'

const __dirname       = dirname(fileURLToPath(import.meta.url))
const ROOT            = join(__dirname, '..')
const ENV_FILE        = join(ROOT, '.env')
const NON_INTERACTIVE = process.argv.includes('--non-interactive')
const IS_WINDOWS      = platform() === 'win32'

// Determine Windows scope — default Machine, override with --scope User
const scopeIdx = process.argv.indexOf('--scope')
const WIN_SCOPE = scopeIdx !== -1 ? process.argv[scopeIdx + 1] : 'Machine'

// ── Variable definitions ─────────────────────────────────────────────────────

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
    description: 'Required for NL query and named query generation. ' +
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
                 'Separate from BEARER_TOKEN. Generate with: openssl rand -hex 32',
  },
  {
    key:         'HB_BEARER_TOKEN',
    label:       'HolonBridge Bearer Token (mcp-remote → bridge)',
    secret:      true,
    description: 'The BEARER_TOKEN value holonbridge-mcp-remote uses when calling the bridge. ' +
                 'Must match BEARER_TOKEN above.',
  },
  {
    key:         'HOLONBRIDGE_PRIVATE_KEY_PATH',
    label:       'Private Key Path (v3.0)',
    secret:      true,
    optional:    true,
    description: 'Path to ES256 private key PEM file for JWT peer auth (v3.0). ' +
                 'Run: node scripts/generate-keys.js  Leave blank to skip.',
  },
  {
    key:         'HOLONBRIDGE_KEY_ID',
    label:       'Key ID (v3.0)',
    secret:      true,
    optional:    true,
    description: 'Key identifier, e.g. kurtcagle-primary-2026-06. Leave blank to skip.',
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
    description: 'Base URL of the local Jena Fuseki instance.',
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
    description: 'Number of times to retry a failed NL→SPARQL query.',
  },
  {
    key:         'LOG_SPARQL',
    label:       'Log SPARQL Queries',
    secret:      false,
    default:     'false',
    description: 'Set true to log all SPARQL queries to console (dev only).',
  },
  {
    key:         'LOG_PROMPTS',
    label:       'Log LLM Prompts',
    secret:      false,
    default:     'false',
    description: 'Set true to log all LLM prompts to console (dev only).',
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
  const lines = [
    '# HolonBridge configuration (non-sensitive)',
    '# Generated by scripts/setup-env.js',
    `# Updated: ${new Date().toISOString()}`,
    '# DO NOT add secrets to this file.',
    '',
  ]
  for (const [k, v] of Object.entries(values)) lines.push(`${k}=${v}`)
  writeFileSync(ENV_FILE, lines.join('\n') + '\n', 'utf8')
}

/**
 * Attempt to set a Windows environment variable directly via PowerShell.
 * Returns true on success, false if it fails (e.g. non-elevated for Machine scope).
 */
function setWindowsEnvVar(key, value, scope) {
  try {
    const escaped = value.replace(/'/g, "''")  // escape single quotes for PowerShell
    execSync(
      `powershell -NoProfile -Command "[System.Environment]::SetEnvironmentVariable('${key}', '${escaped}', '${scope}')"`,
      { stdio: 'pipe' }
    )
    return true
  } catch (_) {
    return false
  }
}

/**
 * Check whether the current process is elevated (Windows admin).
 */
function isElevated() {
  if (!IS_WINDOWS) return false
  try {
    execSync('net session', { stdio: 'pipe' })
    return true
  } catch (_) {
    return false
  }
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

const elevated = isElevated()

console.log()
console.log('╔══════════════════════════════════════════════════════╗')
console.log('║      HolonBridge v2.9.0 — Environment Setup         ║')
console.log('╚══════════════════════════════════════════════════════╝')
console.log()
console.log('CONFIGURATION  → written to .env (safe, non-sensitive)')
if (IS_WINDOWS) {
  console.log(`SECRETS        → written to Windows ${WIN_SCOPE} environment`)
  if (WIN_SCOPE === 'Machine' && !elevated) {
    console.log()
    console.log('⚠  WARNING: Machine scope requires Administrator rights.')
    console.log('   Direct write will be attempted but may fail.')
    console.log('   Re-run from an elevated PowerShell, or use --scope User.')
  }
} else {
  console.log('SECRETS        → output as export commands for your shell profile')
}
console.log()

const dotenvValues = loadDotenv()
const configValues = {}
const secretValues = {}

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

// ── Set / output secrets ──────────────────────────────────────────────────────

console.log()

if (Object.keys(secretValues).length === 0) {
  console.log('No secrets to set.')
} else if (IS_WINDOWS) {
  // Attempt direct write via PowerShell
  console.log(`Setting ${Object.keys(secretValues).length} secret(s) in Windows ${WIN_SCOPE} environment...`)
  console.log()

  const failed = []
  for (const [k, v] of Object.entries(secretValues)) {
    const ok = setWindowsEnvVar(k, v, WIN_SCOPE)
    if (ok) {
      console.log(`  ✅ ${k}`)
    } else {
      console.log(`  ❌ ${k}  (failed — may need elevated shell)`)
      failed.push([k, v])
    }
  }

  if (failed.length > 0) {
    console.log()
    console.log('══════════════════════════════════════════════════════')
    console.log('FAILED VARIABLES — run these manually as Administrator:')
    console.log('══════════════════════════════════════════════════════')
    console.log()
    for (const [k, v] of failed) {
      console.log(`[System.Environment]::SetEnvironmentVariable('${k}', '${v}', '${WIN_SCOPE}')`)
    }
    console.log()
  } else {
    console.log()
    console.log('All secrets set successfully.')
    console.log('Open a new terminal for the changes to take effect.')
  }

} else {
  // Linux/macOS — output export commands
  console.log('══════════════════════════════════════════════════════')
  console.log('ADD THESE TO ~/.profile, ~/.zshrc, OR systemd unit:')
  console.log('══════════════════════════════════════════════════════')
  console.log()
  for (const [k, v] of Object.entries(secretValues)) {
    console.log(`export ${k}='${v}'`)
  }
  console.log()
  console.log('Then run: source ~/.profile  (or open a new terminal)')
}

console.log()
console.log('⚠  Security: clear terminal history after running.')
if (IS_WINDOWS) {
  console.log('   PowerShell: Clear-History')
} else {
  console.log('   Bash: history -c   Zsh: fc -p')
}

console.log()
console.log('Setup complete.')
console.log()
console.log('Next steps:')
console.log('  1. Open a new terminal (for env vars to take effect)')
console.log('  2. Restart HolonBridge:  npm start')
console.log('  3. Generate keypair for v3.0:  node scripts/generate-keys.js')
console.log()
