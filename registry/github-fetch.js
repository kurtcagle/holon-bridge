/**
 * registry/github-fetch.js
 *
 * Fetches HolonBridge registry DataBooks from a GitHub repository.
 * Extracts turtle/turtle12 fenced blocks from each DataBook for loading
 * into the Jena registry named graphs.
 *
 * Repo layout expected:
 *   data/holon/registry/hb-registry-ontology.databook.md
 *   data/holon/registry/hb-content-types.databook.md
 *   data/holon/registry/bridges/<name>.databook.md   (one per bridge)
 *   data/holon/registry/endpoints/current.databook.md
 */

const REGISTRY_PATHS = [
  'data/holon/registry/hb-registry-ontology.databook.md',
  'data/holon/registry/hb-content-types.databook.md',
  'data/holon/registry/endpoints/current.databook.md',
]

const BRIDGES_DIR = 'data/holon/registry/bridges'

/**
 * Fetch a single file from the GitHub Contents API.
 * Returns decoded UTF-8 string.
 */
async function fetchGitHubFile(owner, repo, path, token) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`
  const res = await fetch(url, {
    headers: {
      // .trim() defends against CRLF line endings in .env on Windows
      // which would append \r to the token and cause a 401
      'Authorization':        `token ${token.trim()}`,
      'Accept':               'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
  if (!res.ok)
    throw new Error(`GitHub fetch failed [${res.status}] ${path}: ${await res.text()}`)

  const data = await res.json()
  return Buffer.from(data.content, 'base64').toString('utf-8')
}

/**
 * List .databook.md files in a GitHub directory.
 * Returns [] gracefully if the directory does not exist yet.
 */
async function listGitHubDir(owner, repo, dir, token) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${dir}`
  const res = await fetch(url, {
    headers: {
      'Authorization':        `token ${token.trim()}`,
      'Accept':               'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
  if (!res.ok) {
    if (res.status === 404) return []
    throw new Error(`GitHub dir list failed [${res.status}] ${dir}`)
  }
  const items = await res.json()
  return items
    .filter(i => i.type === 'file' && i.name.endsWith('.databook.md'))
    .map(i => ({ name: i.name, path: i.path }))
}

/**
 * Extract turtle/turtle12 fenced blocks from a DataBook markdown string.
 * Returns concatenated Turtle string.
 */
export function extractTurtleBlocks(markdown) {
  const blocks = []
  const RE = /```turtle(?:12)?\s*\n([\s\S]*?)```/g
  let m
  while ((m = RE.exec(markdown)) !== null)
    blocks.push(m[1].trim())
  return blocks.join('\n\n')
}

/**
 * Fetch all registry DataBooks from GitHub and return their Turtle content.
 *
 * Returns:
 *   { ontology, contentTypes, bridges, endpoints }  -- all strings of Turtle
 */
export async function fetchRegistryDataBooks({ owner, repo, token }) {
  const tok = token.trim()
  console.log(`[registry] Fetching DataBooks from ${owner}/${repo}...`)

  const [ontologyMd, contentTypesMd, endpointsMd] = await Promise.all([
    fetchGitHubFile(owner, repo, REGISTRY_PATHS[0], tok),
    fetchGitHubFile(owner, repo, REGISTRY_PATHS[1], tok),
    fetchGitHubFile(owner, repo, REGISTRY_PATHS[2], tok),
  ])

  const bridgeFiles = await listGitHubDir(owner, repo, BRIDGES_DIR, tok)
  console.log(`[registry] Found ${bridgeFiles.length} bridge DataBook(s)`)

  const bridgeMds = await Promise.all(
    bridgeFiles.map(f => fetchGitHubFile(owner, repo, f.path, tok))
  )

  return {
    ontology:     extractTurtleBlocks(ontologyMd),
    contentTypes: extractTurtleBlocks(contentTypesMd),
    bridges:      bridgeMds.map(extractTurtleBlocks).join('\n\n'),
    endpoints:    extractTurtleBlocks(endpointsMd),
  }
}
