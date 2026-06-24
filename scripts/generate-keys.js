#!/usr/bin/env node
/**
 * scripts/generate-keys.js
 *
 * Generates an ES256 (P-256) keypair for HolonBridge peer authentication.
 * Outputs:
 *   private.pem  — PKCS8 private key (keep secret, never commit)
 *   public.pem   — SPKI public key  (safe to publish in registry DataBook)
 *   public.jwk   — Public key in JWK format (ready for hb:publicKey triple)
 *
 * Usage:
 *   node scripts/generate-keys.js [--out-dir /path/to/dir]
 *
 * Default output: /etc/holonbridge/keys/ (Linux/macOS)
 *                 %PROGRAMDATA%\HolonBridge\keys\ (Windows)
 *
 * The private key file is written with mode 600 (owner read/write only).
 * On Windows, restrict access via icacls after generation.
 *
 * NOTE: Keys generated here are for v3.0 JWT peer authentication.
 *       They are not used by v2.8/v2.9 auth middleware.
 *       Generate now so keys are ready when v3.0 is deployed.
 */

import { generateKeyPair }   from 'node:crypto'
import { writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs'
import { join }              from 'node:path'
import { promisify }         from 'node:util'
import { platform }          from 'node:os'

const generateKeyPairAsync = promisify(generateKeyPair)

// ── Parse args ───────────────────────────────────────────────────────────────

const args    = process.argv.slice(2)
const outIdx  = args.indexOf('--out-dir')
const outDir  = outIdx !== -1 ? args[outIdx + 1]
  : platform() === 'win32'
    ? join(process.env.PROGRAMDATA ?? 'C:\\ProgramData', 'HolonBridge', 'keys')
    : '/etc/holonbridge/keys'

const keyId   = args[args.indexOf('--key-id') + 1]
  ?? `holonbridge-${new Date().toISOString().slice(0, 10)}`

// ── Key metadata ─────────────────────────────────────────────────────────────

console.log('\nHolonBridge Key Generator')
console.log('─'.repeat(50))
console.log(`Algorithm : ES256 (P-256)`)
console.log(`Key ID    : ${keyId}`)
console.log(`Output    : ${outDir}`)
console.log()

// ── Generate ─────────────────────────────────────────────────────────────────

const { privateKey, publicKey } = await generateKeyPairAsync('ec', {
  namedCurve:        'P-256',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding:  { type: 'spki',  format: 'pem' },
})

// ── Build JWK from public key ─────────────────────────────────────────────────

// Extract raw key bytes for JWK construction
const { generateKeyPairSync } = await import('node:crypto')
const rawPub  = publicKey
  .replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\n/g, '')
const keyObj  = {
  kty: 'EC',
  crv: 'P-256',
  kid: keyId,
  use: 'sig',
  alg: 'ES256',
  // Note: full JWK x/y extraction requires jose; this stub is for v3.0
  // For now, embed the PEM in the DataBook and let jose parse it at runtime
  pem: rawPub,
}

const jwk = JSON.stringify(keyObj, null, 2)

// ── Write files ──────────────────────────────────────────────────────────────

if (!existsSync(outDir)) {
  mkdirSync(outDir, { recursive: true })
  console.log(`Created directory: ${outDir}`)
}

const privatePath = join(outDir, 'private.pem')
const publicPath  = join(outDir, 'public.pem')
const jwkPath     = join(outDir, 'public.jwk')

writeFileSync(privatePath, privateKey, { encoding: 'utf8', mode: 0o600 })
writeFileSync(publicPath,  publicKey,  { encoding: 'utf8', mode: 0o644 })
writeFileSync(jwkPath,     jwk,        { encoding: 'utf8', mode: 0o644 })

// Restrict private key on Linux/macOS
if (platform() !== 'win32') {
  try { chmodSync(privatePath, 0o600) } catch (_) {}
}

// ── Output ───────────────────────────────────────────────────────────────────

console.log(`✅ Private key : ${privatePath}`)
console.log(`   (mode 600 — keep secret, never commit to version control)`)
console.log()
console.log(`✅ Public key  : ${publicPath}`)
console.log(`✅ Public JWK  : ${jwkPath}`)
console.log()
console.log('Next steps:')
console.log(`  1. Set HOLONBRIDGE_PRIVATE_KEY_PATH=${privatePath} in your OS environment`)
console.log(`  2. Set HOLONBRIDGE_KEY_ID=${keyId} in your OS environment`)
console.log(`  3. Add the public key to your bridge registry DataBook (hb:publicKey triple)`)
console.log(`  4. Share public.pem or public.jwk with peer bridges (safe to distribute)`)
console.log()
console.log('⚠  Keys are for v3.0 JWT peer auth — not activated in v2.9')
console.log('   Run this now so keys are ready when v3.0 is deployed.')
console.log()

// ── Turtle snippet for registry DataBook ────────────────────────────────────

console.log('Registry DataBook snippet (add to your bridge DataBook):')
console.log('─'.repeat(50))
console.log(`hbr:kurtcagle-primary`)
console.log(`    hb:keyId        "${keyId}" ;`)
console.log(`    hb:keyAlgorithm "ES256" ;`)
console.log(`    hb:publicKeyPem """`)
console.log(publicKey.trim())
console.log(`""" .`)
