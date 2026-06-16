/**
 * databook.js -- DataBook block extractor
 *
 * Parses a .databook.md file (or directory of .databook.md files) and extracts
 * named fenced code blocks.  Block markers use the form:
 *   <!-- databook:id: blockname -->
 *   ```lang
 *   ...content...
 *   ```
 *
 * Usage (single file):
 *   import { loadDataBook } from './lib/databook.js'
 *   const db = await loadDataBook('./context/ds-schema-summary.databook.md')
 *
 * Usage (directory -- merges all .databook.md files in sorted order):
 *   import { loadDataBookFromDir } from './lib/databook.js'
 *   const db = await loadDataBookFromDir('./context/localhost-3030/ds')
 */

import { readFile, readdir } from 'fs/promises'
import { join }              from 'path'

const MARKER_RE = /<!--\s*databook:id:\s*(\S+)\s*-->/g
const FENCE_RE  = /^```[^\n]*\n([\s\S]*?)^```/m

export class DataBook {
  #blocks = new Map()
  #raw    = ''
  #path   = ''

  constructor(raw, path) {
    this.#raw  = raw
    this.#path = path
    this.#parse()
  }

  #parse() {
    const text = this.#raw
    let match

    MARKER_RE.lastIndex = 0
    while ((match = MARKER_RE.exec(text)) !== null) {
      const id     = match[1]
      const after  = text.slice(match.index + match[0].length)
      const fenced = FENCE_RE.exec(after)
      if (fenced) {
        const nextMarker = text.indexOf('<!-- databook:id:', match.index + match[0].length + 1)
        const segment    = nextMarker > -1
          ? text.slice(match.index + match[0].length, nextMarker)
          : text.slice(match.index + match[0].length)

        const blocks    = []
        const allFences = /^```[^\n]*\n([\s\S]*?)^```/gm
        let fb
        while ((fb = allFences.exec(segment)) !== null) {
          blocks.push(fb[1].trimEnd())
        }
        this.#blocks.set(id, blocks.join('\n\n'))
      }
    }
  }

  block(id)       { return this.#blocks.get(id) ?? null }
  ids()           { return [...this.#blocks.keys()] }
  get path()      { return this.#path }
  get size()      { return this.#raw.length }

  context(...ids) {
    return ids
      .map(id => {
        const content = this.block(id)
        if (!content) console.warn(`[DataBook] Block "${id}" not found in ${this.#path}`)
        return content ? `# --- ${id} ---\n${content}` : ''
      })
      .filter(Boolean)
      .join('\n\n')
  }
}

/**
 * Load a single .databook.md file.
 */
export async function loadDataBook(filePath) {
  const raw = await readFile(filePath, 'utf-8')
  const db  = new DataBook(raw, filePath)
  console.log(`[DataBook] Loaded ${filePath} -- blocks: ${db.ids().join(', ')}`)
  return db
}

/**
 * Load all .databook.md files from a directory, merging them into a single
 * DataBook in alphabetical filename order.
 *
 * Splitting context across multiple files is encouraged:
 *   01-prefixes.databook.md
 *   02-classes.databook.md
 *   03-named-queries.databook.md
 *   04-nl-hints.databook.md
 *
 * All blocks from all files are available as one DataBook to the caller.
 * Returns an empty DataBook (no blocks) if the directory does not exist or
 * contains no .databook.md files -- the bridge degrades gracefully.
 *
 * @param {string} dirPath  e.g. ./context/localhost-3030/ds
 * @returns {Promise<DataBook>}
 */
export async function loadDataBookFromDir(dirPath) {
  let entries
  try {
    entries = await readdir(dirPath)
  } catch (_) {
    console.warn(`[DataBook] Context directory not found: ${dirPath} -- using empty context`)
    return new DataBook('', dirPath)
  }

  const files = entries
    .filter(f => f.endsWith('.databook.md'))
    .sort()

  if (files.length === 0) {
    console.warn(`[DataBook] No .databook.md files in ${dirPath} -- using empty context`)
    return new DataBook('', dirPath)
  }

  const parts = await Promise.all(
    files.map(f => readFile(join(dirPath, f), 'utf-8'))
  )

  const combined = parts.join('\n\n')
  const db       = new DataBook(combined, dirPath)
  console.log(`[DataBook] Merged ${files.length} file(s) from ${dirPath} -- blocks: ${db.ids().join(', ')}`)
  return db
}
