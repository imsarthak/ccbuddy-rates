// One-shot capture: does Myntra's gold-coins listing carry a per-coin stock
// count, and under what name? Nothing committed can say. Every feed and
// fixture in this repo was written after toSku (scraper/blinkdeal.mjs), which
// keeps ten fields per coin and has never kept a stock field. The phone is
// the only machine Myntra serves a real listing to, so the phone reads one
// page, once.
//
// NOT part of the watcher. Never imported by it, never merged to master. It
// lives on feature/bd-stock-capture only and runs from its own clone:
//
//   cd ~ && git clone -q --depth 1 -b feature/bd-stock-capture \
//     https://github.com/imsarthak/ccbuddy-rates bd-capture \
//     && node bd-capture/capture/listing.mjs
//
// What it does, in order:
//   1. One GET of https://www.myntra.com/gold-coins with the watcher's own
//      headers (the same single request a quiet watcher tick makes).
//   2. Stops, saving nothing, if the page has no window.__myx (the
//      maintenance stub every blocked address gets).
//   3. Keeps searchData.results.totalCount and .products ONLY. This repo is
//      public, so nothing else from the page is saved.
//   4. Prints a short verdict: every product field whose name looks like
//      stock, how many products carry it, and its smallest and largest value.
//   5. Commits the file in THIS clone and pushes it to the branch
//      capture/bd-stock, using the push address the watcher's clone already
//      has (~/ccbuddy-rates). The address holds a token, so it is read
//      once, passed to git, and never printed. The watcher's clone is only
//      read (`git remote get-url`), never changed.
//
// Flags (for tests on a PC, which must never fetch Myntra):
//   --html <file>    read a saved page instead of fetching
//   --no-push        write and print, but do not commit or push

import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLONE = process.env.CAPTURE_CLONE ?? join(HERE, '..')
const WATCHER = process.env.WATCHER_CLONE ?? join(homedir(), 'ccbuddy-rates')
const LISTING = 'https://www.myntra.com/gold-coins'
const BRANCH = 'capture/bd-stock'

// Copied from scraper/blinkdeal.mjs as of 2026-10-29. The watcher's fetch
// identity is load-bearing (Myntra gates on it), so this asks exactly as the
// watcher does.
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-IN,en;q=0.9',
  'sec-ch-ua': '"Not;A=Brand";v="99", "Google Chrome";v="139", "Chromium";v="139"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
}

/** scraper/blinkdeal.mjs extractMyx, copied so this file imports nothing of the watcher's. */
export function extractMyx(html) {
  const at = html.indexOf('window.__myx')
  if (at === -1) throw new Error('no window.__myx in page')
  const start = html.indexOf('{', at)
  let depth = 0
  let inStr = false
  for (let i = start; i < html.length; i++) {
    const c = html[i]
    if (inStr) {
      if (c === '\\') i++
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return JSON.parse(html.slice(start, i + 1))
  }
  throw new Error('unbalanced window.__myx')
}

/** The only part of the page that is kept. */
export function keep(myx) {
  const results = myx?.searchData?.results ?? {}
  return {
    totalCount: results.totalCount ?? null,
    products: Array.isArray(results.products) ? results.products : [],
  }
}

const STOCKISH = /inventor|stock|avail|quantit|qty|units?left|left/i

/**
 * Every path inside a product whose last key looks like stock, with how many
 * products carry it and what values it takes. Arrays are walked as `[]`, so
 * `inventoryInfo[].inventory` is one path however many entries a coin has.
 */
export function stockPaths(products) {
  const seen = new Map() // path -> { products: Set<index>, numbers: number[], other: Set<string>, perProduct: number[] }
  const visit = (v, path, i, depth) => {
    if (depth > 4 || v == null) return
    if (Array.isArray(v)) {
      for (const x of v) visit(x, `${path}[]`, i, depth + 1)
      return
    }
    if (typeof v !== 'object') return
    for (const [k, x] of Object.entries(v)) {
      const p = path ? `${path}.${k}` : k
      const leafy = x == null || typeof x !== 'object'
        || (Array.isArray(x) && x.every((e) => e == null || typeof e !== 'object'))
      if (STOCKISH.test(k) && leafy) {
        let s = seen.get(p)
        if (!s) seen.set(p, (s = { products: new Set(), numbers: [], other: new Set(), perProduct: new Map() }))
        s.products.add(i)
        s.perProduct.set(i, (s.perProduct.get(i) ?? 0) + 1)
        const leaves = Array.isArray(x) ? x : [x]
        for (const leaf of leaves) {
          if (typeof leaf === 'number' && Number.isFinite(leaf)) s.numbers.push(leaf)
          else if (s.other.size < 6) s.other.add(String(JSON.stringify(leaf)).slice(0, 40))
        }
      }
      visit(x, p, i, depth + 1)
    }
  }
  products.forEach((p, i) => visit(p, '', i, 0))
  return [...seen.entries()]
    .map(([path, s]) => ({
      path,
      products: s.products.size,
      min: s.numbers.length ? Math.min(...s.numbers) : null,
      max: s.numbers.length ? Math.max(...s.numbers) : null,
      distinct: new Set(s.numbers).size,
      maxPerProduct: Math.max(0, ...s.perProduct.values()),
      other: [...s.other],
    }))
    .sort((a, b) => b.products - a.products || a.path.localeCompare(b.path))
}

/** The lines printed on the phone's screen. */
export function verdict(kept, paths) {
  const n = kept.products.length
  const lines = [`${n} products read (totalCount ${kept.totalCount}).`]
  if (!paths.length) {
    lines.push('No field that looks like stock. The idea stops here.')
    return lines
  }
  for (const p of paths.slice(0, 6)) {
    const range = p.min == null ? `values ${p.other.join(' ') || 'none'}` : `min ${p.min}, max ${p.max}, ${p.distinct} distinct`
    lines.push(`${p.path}: ${p.products}/${n} products, ${range}, up to ${p.maxPerProduct} per product`)
  }
  return lines
}

/** Any error text from git, with the push address (and so its token) cut out. */
export function redact(text, secret) {
  let out = String(text ?? '')
  if (secret) out = out.split(secret).join('<push address>')
  return out.replace(/https:\/\/[^@\s/]+@/g, 'https://<token>@')
}

async function readPage() {
  const i = process.argv.indexOf('--html')
  if (i !== -1) return { status: 200, text: await readFile(process.argv[i + 1], 'utf8') }
  const res = await fetch(LISTING, { headers: HEADERS, signal: AbortSignal.timeout(30000) })
  return { status: res.status, text: await res.text() }
}

function git(args, secret) {
  try {
    return execFileSync('git', ['-C', CLONE, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }).trim()
  } catch (e) {
    throw new Error(redact(`git ${args[0]} failed: ${e.stderr || e.message}`, secret))
  }
}

async function main() {
  const page = await readPage()
  let myx
  try {
    myx = extractMyx(page.text)
  } catch (e) {
    console.log(`HTTP ${page.status}, ${page.text.length} bytes, ${e.message}. Nothing saved.`)
    process.exitCode = 1
    return
  }
  const kept = keep(myx)
  if (!kept.products.length) {
    console.log(`HTTP ${page.status}, no products on the page. Nothing saved.`)
    process.exitCode = 1
    return
  }
  const capturedAt = new Date().toISOString()
  const file = join('captures', `listing-products-${capturedAt.slice(0, 10)}.json`)
  await mkdir(join(CLONE, 'captures'), { recursive: true })
  await writeFile(join(CLONE, file), JSON.stringify({ capturedAt, url: LISTING, status: page.status, bytes: page.text.length, ...kept }, null, 1) + '\n')

  for (const line of verdict(kept, stockPaths(kept.products))) console.log(line)
  if (process.argv.includes('--no-push')) {
    console.log(`Saved ${file}. Not pushed (--no-push).`)
    return
  }

  // The watcher's push address, read and never echoed. A clone with no token
  // in it fails the push below (no prompt: GIT_TERMINAL_PROMPT=0), and the
  // verdict above has already been printed.
  let remote = ''
  try {
    remote = execFileSync('git', ['-C', WATCHER, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    console.log(`Saved ${file}. Could not read the watcher clone at ${WATCHER}, so nothing was pushed.`)
    process.exitCode = 1
    return
  }
  try {
    git(['add', file], remote)
    git(['-c', 'user.name=ccbuddy-rates-bot', '-c', 'user.email=actions@users.noreply.github.com',
      'commit', '-q', '-m', `capture: gold-coins listing products ${capturedAt}`], remote)
    git(['push', '-q', '--force', remote, `HEAD:refs/heads/${BRANCH}`], remote)
    console.log(`Pushed to ${BRANCH}. Done; the watcher was not touched.`)
  } catch (e) {
    console.log(`Saved ${file}. Push failed: ${e.message}`)
    process.exitCode = 1
  }
}

const entry = process.argv[1] ? process.argv[1].replace(/\\/g, '/').toLowerCase() : ''
if (entry.endsWith('/capture/listing.mjs')) main()
