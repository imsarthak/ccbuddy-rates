// CCBuddy Myntra BLINKDEAL watcher.
// Myntra's listing pages are server-rendered with a `window.__myx` blob in
// which every product carries the best coupon that applies to it. When a
// SKU-level coupon such as BLINKDEAL is live, that field flips from the
// generic new-user code to the live one and its tagLink points at a filter
// URL (`/gold-coins?f=Coupons:CODE_ID`) that lists exactly the SKUs it covers.
// This script asks those two questions and publishes docs/blinkdeal.json.
//
//   node scraper/blinkdeal.mjs            normal run (writes docs/blinkdeal.json)
//   node scraper/blinkdeal.mjs --probe    fetch only, print what came back, write nothing
//   --url <filterUrl>                     treat this filter URL as live (end-to-end test)
//   --out <path>                          write somewhere else (tests)

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ARGS = process.argv.slice(2)
const flag = (name) => {
  const i = ARGS.indexOf(name)
  return i === -1 ? null : ARGS[i + 1] ?? true
}
const PROBE = ARGS.includes('--probe')
const OUT = flag('--out') ?? join(ROOT, 'docs', 'blinkdeal.json')
const HISTORY = join(dirname(OUT), 'blinkdeal-history.json')

const ORIGIN = 'https://www.myntra.com'
const LISTING = `${ORIGIN}/gold-coins`
const CODE_RE = /BLINK/i
const SEED_IDS = ['123190'] // BLINKDEAL's coupon id as Google last indexed it
const HEARTBEAT_MS = 60 * 60 * 1000 // rewrite an unchanged file at most hourly
const MAX_PAGES = 3
const TIMEOUT_MS = 20000

// The page is served to browsers; ask for it the way Chrome would.
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

async function get(url) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  const started = Date.now()
  try {
    const res = await fetch(url, { headers: HEADERS, signal: ctrl.signal })
    const text = await res.text()
    return { status: res.status, text, ms: Date.now() - started }
  } finally {
    clearTimeout(t)
  }
}

// Pull the `window.__myx = {...}` object out of the HTML by balancing braces
// (the blob holds strings that contain `</script>` and `};`, so no regex).
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

export function summarize(myx) {
  const results = myx?.searchData?.results ?? {}
  const products = results.products ?? []
  const codes = new Map()
  const links = new Set()
  for (const p of products) {
    const code = p.couponData?.couponDescription?.couponCode
    if (code) codes.set(code, (codes.get(code) ?? 0) + 1)
    if (p.couponData?.tagLink) links.add(p.couponData.tagLink)
  }
  // `filters` is a facet map on real pages; keep only the names, for the probe.
  const raw = results.filters ?? {}
  const facets = Array.isArray(raw)
    ? raw.map((f) => f?.id ?? f?.filterId ?? f?.name).filter(Boolean)
    : Object.keys(raw)
  return { totalCount: results.totalCount ?? null, products, codes, links, facets }
}

export function toSku(p) {
  return {
    id: p.productId,
    name: p.productName,
    brand: p.brand,
    info: p.additionalInfo || undefined,
    price: p.price,
    mrp: p.mrp,
    discount: p.couponData?.couponDiscount ?? null,
    bestPrice: p.couponData?.couponDescription?.bestPrice ?? null,
    code: p.couponData?.couponDescription?.couponCode ?? null,
    url: `${ORIGIN}/${p.landingPageUrl}`,
  }
}

const filterUrl = (code, id) => `${LISTING}?f=Coupons:${code}_${id}`
const parseTagLink = (link) => /f=Coupons:([A-Z0-9]+)_(\d+)/i.exec(link ?? '')

async function fetchListing(url) {
  const r = await get(url)
  if (r.status !== 200) throw new Error(`HTTP ${r.status} for ${url}`)
  return { ...summarize(extractMyx(r.text)), ms: r.ms, bytes: r.text.length }
}

async function probe() {
  let bad = 0
  for (const url of [LISTING, filterUrl('BLINKDEAL', SEED_IDS[0])]) {
    try {
      const r = await get(url)
      const line = [`${r.status}`, `${r.text.length} bytes`, `${r.ms} ms`]
      let s
      try {
        s = summarize(extractMyx(r.text))
        line.push('__myx ok', `products ${s.products.length}`, `totalCount ${s.totalCount}`)
        line.push(`codes ${JSON.stringify([...s.codes])}`, `facets ${JSON.stringify(s.facets)}`)
        line.push(`links ${JSON.stringify([...s.links])}`)
        if (r.status !== 200 || (url === LISTING && s.products.length === 0)) bad++
      } catch (e) {
        bad++
        line.push(`__myx MISSING (${e.message})`, `head: ${r.text.slice(0, 200).replace(/\s+/g, ' ')}`)
      }
      console.log(`${url}\n  ${line.join(' | ')}`)
    } catch (e) {
      bad++
      console.log(`${url}\n  FAIL ${e.message}`)
    }
  }
  process.exitCode = bad ? 1 : 0
}

async function detect(previous) {
  const knownIds = [...new Set([...(previous.knownIds ?? []), ...SEED_IDS])]
  const override = flag('--url')
  let live = null // { code, couponId, source, first }

  if (typeof override === 'string') {
    const m = parseTagLink(override)
    live = { code: m?.[1] ?? 'OVERRIDE', couponId: m?.[2] ?? null, source: override, first: await fetchListing(override) }
  } else {
    // 1. Ask the coupon's own filter page for every id we have seen.
    for (const id of knownIds) {
      const url = filterUrl('BLINKDEAL', id)
      const first = await fetchListing(url)
      if (first.totalCount > 0) {
        const code = [...first.codes.keys()].find((c) => CODE_RE.test(c)) ?? 'BLINKDEAL'
        live = { code, couponId: id, source: url, first }
        break
      }
    }
    // 2. Otherwise read the plain listing and look for any BLINK* coupon
    //    on any product — that is how a renamed code or a new id is found.
    if (!live) {
      const plain = await fetchListing(LISTING)
      const hit = [...plain.links].map(parseTagLink).find((m) => m && CODE_RE.test(m[1]))
        ?? [...plain.codes.keys()].filter((c) => CODE_RE.test(c)).map((c) => [null, c, null])[0]
      if (hit) {
        const [, code, id] = hit
        if (id && !knownIds.includes(id)) knownIds.push(id)
        const url = id ? filterUrl(code, id) : LISTING
        live = { code, couponId: id, source: url, first: id ? await fetchListing(url) : plain }
      }
    }
  }

  if (!live) return { live: false, knownIds }

  const products = [...live.first.products]
  const total = live.first.totalCount ?? products.length
  for (let p = 2; p <= MAX_PAGES && products.length < total; p++) {
    const page = await fetchListing(`${live.source}${live.source.includes('?') ? '&' : '?'}p=${p}`)
    if (page.products.length === 0) break
    products.push(...page.products)
  }
  const skus = products.map(toSku)
  const pcts = skus.filter((s) => s.discount && s.price).map((s) => Math.round((s.discount / s.price) * 100))
  const discountPct = pcts.length && pcts.every((x) => x === pcts[0]) ? pcts[0] : null
  return {
    live: true,
    code: live.code,
    couponId: live.couponId,
    discountPct,
    source: live.source,
    totalCount: total,
    skus,
    knownIds,
  }
}

const skuKey = (f) => (f.skus ?? []).map((s) => s.id).sort().join(',')

async function main() {
  if (PROBE) return probe()

  let previous = {}
  try {
    previous = JSON.parse(await readFile(OUT, 'utf8'))
  } catch {
    // first run
  }

  const now = new Date().toISOString()
  let next
  try {
    const d = await detect(previous)
    next = { generated: now, checkedAt: now, ok: true, ...d }
    if (d.live) {
      const from = previous.live && previous.code === d.code ? previous.lastLive?.from ?? now : now
      next.lastLive = { code: d.code, couponId: d.couponId, from, skuCount: d.skus.length }
    } else if (previous.lastLive) {
      next.lastLive = previous.lastLive.to ? previous.lastLive : { ...previous.lastLive, to: now }
    }
    console.log(d.live ? `LIVE  ${d.code} — ${d.skus.length}/${d.totalCount} SKUs` : 'quiet — no BLINK* coupon on gold coins')
  } catch (e) {
    // A failed read never ends a window: keep what we knew, mark it stale.
    next = { ...previous, generated: now, checkedAt: now, ok: false, stale: true, error: String(e.message ?? e) }
    console.error(`FAIL  ${e.message}`)
  }

  const ended = previous.live && !next.live && next.ok
  if (ended) {
    let history = { windows: [] }
    try {
      history = JSON.parse(await readFile(HISTORY, 'utf8'))
    } catch {
      // first window
    }
    const w = previous.lastLive ?? { code: previous.code, from: previous.checkedAt }
    history.windows = [...history.windows, { ...w, to: now, maxSkus: previous.skus?.length ?? 0 }].slice(-100)
    await writeFile(HISTORY, JSON.stringify(history, null, 1) + '\n')
  }

  const material =
    !!previous.live !== !!next.live || previous.code !== next.code || !!previous.ok !== !!next.ok ||
    skuKey(previous) !== skuKey(next) || (next.knownIds ?? []).length !== (previous.knownIds ?? []).length
  const heartbeatDue = !previous.checkedAt || Date.now() - Date.parse(previous.checkedAt) > HEARTBEAT_MS
  if (!material && !heartbeatDue) {
    console.log('unchanged — not rewriting')
    return
  }
  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(OUT, JSON.stringify(next, null, 1) + '\n')
  console.log(`wrote ${OUT}`)
}

main()
