'use strict';

/**
 * registry/github-fetch.js
 *
 * Fetches HolonBridge registry DataBooks from a GitHub repository.
 * Extracts the turtle12 fenced blocks from each DataBook for loading
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
];

const BRIDGES_DIR = 'data/holon/registry/bridges';

/**
 * Fetch a single file from GitHub contents API.
 * Returns decoded UTF-8 string.
 */
async function fetchGitHubFile(owner, repo, path, token) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `token ${token}`,
      'Accept':        'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!res.ok) {
    throw new Error(`GitHub fetch failed [${res.status}] ${path}: ${await res.text()}`);
  }

  const data = await res.json();
  return Buffer.from(data.content, 'base64').toString('utf-8');
}

/**
 * List files in a GitHub directory.
 * Returns array of { name, path } objects.
 */
async function listGitHubDir(owner, repo, dir, token) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${dir}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `token ${token}`,
      'Accept':        'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!res.ok) {
    if (res.status === 404) return [];   // directory doesn't exist yet
    throw new Error(`GitHub dir list failed [${res.status}] ${dir}`);
  }

  const items = await res.json();
  return items
    .filter(i => i.type === 'file' && i.name.endsWith('.databook.md'))
    .map(i => ({ name: i.name, path: i.path }));
}

/**
 * Extract turtle/turtle12 fenced blocks from a DataBook markdown string.
 * Returns concatenated Turtle string.
 */
function extractTurtleBlocks(markdown) {
  const blocks = [];
  // Match ```turtle12 or ```turtle fenced blocks
  const RE = /```turtle(?:12)?\s*\n([\s\S]*?)```/g;
  let m;
  while ((m = RE.exec(markdown)) !== null) {
    blocks.push(m[1].trim());
  }
  return blocks.join('\n\n');
}

/**
 * Fetch all registry DataBooks from GitHub and extract their Turtle.
 *
 * Returns an object:
 * {
 *   ontology:     string,   # Turtle for urn:holon:graph:registry:ontology
 *   contentTypes: string,   # Turtle for urn:holon:graph:registry:content-types
 *   bridges:      string,   # Turtle for urn:holon:graph:registry:bridges (all merged)
 *   endpoints:    string,   # Turtle for urn:holon:graph:registry:endpoints
 * }
 */
async function fetchRegistryDataBooks(config) {
  const { owner, repo, token } = config;

  console.log(`  Fetching registry DataBooks from ${owner}/${repo}...`);

  // Fixed-path files
  const [ontologyMd, contentTypesMd, endpointsMd] = await Promise.all([
    fetchGitHubFile(owner, repo, REGISTRY_PATHS[0], token),
    fetchGitHubFile(owner, repo, REGISTRY_PATHS[1], token),
    fetchGitHubFile(owner, repo, REGISTRY_PATHS[2], token),
  ]);

  // Bridge entries — discover dynamically from the bridges/ directory
  const bridgeFiles = await listGitHubDir(owner, repo, BRIDGES_DIR, token);
  console.log(`  Found ${bridgeFiles.length} bridge DataBook(s)`);

  const bridgeMds = await Promise.all(
    bridgeFiles.map(f => fetchGitHubFile(owner, repo, f.path, token))
  );

  return {
    ontology:     extractTurtleBlocks(ontologyMd),
    contentTypes: extractTurtleBlocks(contentTypesMd),
    bridges:      bridgeMds.map(extractTurtleBlocks).join('\n\n'),
    endpoints:    extractTurtleBlocks(endpointsMd),
  };
}

module.exports = { fetchRegistryDataBooks, extractTurtleBlocks };
