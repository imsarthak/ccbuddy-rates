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
//   --dry-run                             print the alert and the channel posts
//                                         instead of sending them (also BLINKDEAL_DRY_RUN=1)

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { notify, composeAlert, postWindow } from './notify.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ARGS = process.argv.slice(2)
const flag = (name) => {
  const i = ARGS.indexOf(name)
  return i === -1 ? null : ARGS[i + 1] ?? true
}
const PROBE = ARGS.includes('--probe')
// --quick: only ask the known filter URLs (≈400 KB each); skip the full
// listing scan (≈700 KB) that finds a renamed code or a new coupon id. A
// tight loop runs quick ticks and a full one every so often.
const QUICK = ARGS.includes('--quick')
// Alerting is for the live watcher only. Any run pointed at a test URL or a
// scratch output file stays silent, so replaying a captured window cannot
// text him at 3am.
const NO_NOTIFY = ARGS.includes('--no-notify') || !!flag('--url') || !!flag('--out')
// --dry-run prints every alert and post instead of sending it. It wins over
// NO_NOTIFY: printing is safe anywhere, and it is how a replayed window shows
// what it would have said.
const DRY_RUN = ARGS.includes('--dry-run') || process.env.BLINKDEAL_DRY_RUN === '1'
const SILENT = NO_NOTIFY && !DRY_RUN
const OUT = flag('--out') ?? join(ROOT, 'docs', 'blinkdeal.json')
const HISTORY = join(dirname(OUT), 'blinkdeal-history.json')

const ORIGIN = 'https://www.myntra.com'
const LISTING = `${ORIGIN}/gold-coins`
const CODE_RE = /BLINK/i
// The coupon id is NOT stable — Myntra mints a new one per campaign, so a
// single seeded id would miss most windows. These three were recovered on
// 2026-09-14 from the branded share links deal accounts post, which carry
// `f=Coupons:<CODE>_<ID>` in their redirect target:
//   123190  BLINKDEAL   (Google's index)
//   129356  BLINKDEAL   (an Admitad link)
//   132202  BLINKDEAL6  (an AppsFlyer OneLink)
// The full-listing scan in detect() is what finds an id we have never seen;
// these only make the quick path likely to hit without it.
const SEED_IDS = ['123190', '129356', '132202']
// Rewrite an unchanged file this often, so `checkedAt` doubles as a liveness
// signal. At an hour a healthy quiet watcher was indistinguishable from a dead
// one, which is the failure nobody would notice.
const HEARTBEAT_MS = 20 * 60 * 1000
// While a window is open the stakes invert: if the watcher dies mid-window the
// feed keeps saying live, and a dead coupon shown as live is worse than
// showing nothing at all. Publishing every couple of minutes bounds how long
// that lie can survive, and lets the app demand tight freshness when it counts.
const LIVE_HEARTBEAT_MS = 2 * 60 * 1000
const PAGE_SIZE = 50 // what the server-rendered listing returns, always
const EXTRA_SORTS = ['price_desc', 'price_asc', 'discount', 'new']
const MAX_BRANDS = 25 // brand passes per window — a safety bound on proxy cost
const MAX_COLLECT = 2000 // above this the filter is too broad to enumerate
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

// Myntra serves its real listing to residential connections only: every
// datacenter egress measured (GitHub runners, Cloudflare, Oracle/Akamai/DO in
// India) gets a 483-byte "Site Maintenance" page with HTTP 200. `--via
// firecrawl` routes the fetch through Firecrawl's proxy pool instead.
const VIA = flag('--via') ?? process.env.BLINKDEAL_VIA ?? 'direct'

async function firecrawlGet(url) {
  const key = (process.env.FIRECRAWL_API_KEY ?? '').replace(/^﻿/, '').trim()
  if (!key) throw new Error('FIRECRAWL_API_KEY not set')
  const res = await fetch('https://api.firecrawl.dev/v2/scrape', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url,
      formats: ['rawHtml'],
      proxy: 'auto', // basic first, stealth only if the basic pool is refused
      location: { country: 'IN', languages: ['en-IN'] },
      timeout: 60000,
    }),
    signal: AbortSignal.timeout(90000),
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok || !j.success) throw new Error(`firecrawl ${res.status}: ${String(j.error ?? '').slice(0, 80)}`)
  return j.data?.rawHtml ?? ''
}

async function get(url) {
  const started = Date.now()
  if (VIA === 'firecrawl') {
    const text = await firecrawlGet(url)
    return { status: 200, text, ms: Date.now() - started }
  }
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
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
  return { totalCount: results.totalCount ?? null, products, codes, links, facets, brands: brandFacet(results) }
}

/**
 * The Brand facet and its per-brand counts. Myntra's server-rendered page
 * always returns the first 50 products and ignores every pagination param
 * (`p`, `page`, `o`, `rows` — all measured inert on 2026-09-15), so brand is
 * how a set larger than 50 gets collected: the counts sum exactly to
 * totalCount, giving a complete partition.
 */
export function brandFacet(results) {
  const pools = results?.filters ?? {}
  for (const pool of Object.values(pools)) {
    if (!Array.isArray(pool)) continue
    for (const f of pool) {
      const id = String(f?.filterId ?? f?.id ?? f?.name ?? '').toLowerCase()
      if (id !== 'brand') continue
      const values = f.values ?? f.filterValues ?? f.options ?? []
      return values
        .map((v) => ({ name: v.value ?? v.name ?? v.id, count: v.count ?? v.docCount ?? 0 }))
        .filter((b) => b.name)
    }
  }
  return []
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

/**
 * The headline discount. Rounding makes per-SKU percentages disagree by a
 * point across a couple of hundred coins, so demanding unanimity published
 * null on the 2026-09-16 window and the alert could not state the discount at
 * all. Take the most common value instead, and fall back to the digits in the
 * code itself — BLINKDEAL6 means 6%, which Myntra is telling us outright.
 */
export function inferDiscountPct(code, skus) {
  const tally = new Map()
  for (const s of skus) {
    if (!s.discount || !s.price) continue
    const p = Math.round((s.discount / s.price) * 100)
    tally.set(p, (tally.get(p) ?? 0) + 1)
  }
  const modal = [...tally].sort((a, b) => b[1] - a[1])[0]
  if (modal) return modal[0]
  const fromCode = /(\d+)\s*$/.exec(code ?? '')
  return fromCode ? Number(fromCode[1]) : null
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
  console.log(`via ${VIA}`)
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

// onLive fires the moment the plain listing shows a live code — before the
// coupon's own filter fetch and the brand crawl. On the phone that crawl is
// ~23 s over mobile data, and on 16 Sep it was the difference between seeing
// the code at 17:00:43 and the alert leaving at 17:01:10.
// onFirstPage fires one fetch later, from the coupon's own filter page: the
// first read that knows how many coins the code covers (totalCount) and has
// fifty real prices for a cheapest ₹/g. That is what the public post wants,
// and it costs ~3 s on mobile data against ~25 s for the whole brand crawl.
async function detect(previous, onLive = async () => {}, onFirstPage = async () => {}) {
  const knownIds = [...new Set([...(previous.knownIds ?? []), ...SEED_IDS])]
  const override = flag('--url')
  let live = null // { code, couponId, source, first }

  if (typeof override === 'string') {
    const m = parseTagLink(override)
    live = { code: m?.[1] ?? 'OVERRIDE', couponId: m?.[2] ?? null, source: override, first: await fetchListing(override) }
  } else {
    // One fetch settles it. The plain listing carries, on each product, the
    // best coupon that applies to it, plus a tagLink holding that coupon's
    // id — so a single read answers "is anything live" AND "which code and
    // id", including a code we have never seen. A quiet tick therefore costs
    // exactly one request (~124 KB gzipped), which is what makes polling
    // through a metered residential proxy affordable.
    //
    // Note what we deliberately do NOT trust: the coupon's own filter URL
    // reports a stale product count. Measured 2026-09-15, minutes after
    // BLINKDEAL6 was withdrawn, it still claimed 199 products while every one
    // of them carried only the generic MYNTRA300. Liveness lives on the
    // products, never in the count.
    const plain = await fetchListing(LISTING)
    const viaLink = [...plain.links].map(parseTagLink).find((m) => m && CODE_RE.test(m[1]))
    const viaCode = [...plain.codes.keys()].find((c) => CODE_RE.test(c))
    if (viaLink || viaCode) {
      const code = viaLink ? viaLink[1] : viaCode
      const id = viaLink ? viaLink[2] : null
      if (id && !knownIds.includes(id)) knownIds.push(id)
      // Scope to the coupon's own filter URL when we have an id, so the SKU
      // list is exactly what the code covers rather than the whole category.
      const url = id ? filterUrl(code, id) : LISTING
      const early = plain.products.filter((p) => CODE_RE.test(p.couponData?.couponDescription?.couponCode ?? '')).map(toSku)
      await onLive({ code, couponId: id, source: url, skus: early })
      live = { code, couponId: id, source: url, first: id ? await fetchListing(url) : plain }
      // Without an id the "first page" is the whole category, so its count
      // is not the coupon's; pass only the coins that carry the code.
      const onPage = live.first.products.filter((p) => CODE_RE.test(p.couponData?.couponDescription?.couponCode ?? ''))
      await onFirstPage({ code, couponId: id, source: url, totalCount: id ? live.first.totalCount : null, skus: onPage.map(toSku) })
    }
  }

  if (!live) return { live: false, knownIds }

  // Collect the whole set. The page yields 50 at a time and ignores every
  // pagination param, so the Brand facet is the partition: its counts sum to
  // totalCount. A brand holding more than a page gets extra passes under
  // different sort orders, which do change which 50 come back.
  const products = [...live.first.products]
  const total = live.first.totalCount ?? products.length
  const seen = new Set(products.map((p) => p.productId))
  const add = (list) => {
    for (const p of list) {
      if (seen.has(p.productId)) continue
      seen.add(p.productId)
      products.push(p)
    }
  }
  const sep = live.source.includes('?') ? '&' : '?'
  // Gold coins is a small category (9 brands, ~200 SKUs). If a filter ever
  // matches a whole department the enumeration would cost hundreds of
  // requests through a metered proxy, so cap it and keep the first page.
  const brands = (live.first.brands ?? []).slice(0, MAX_BRANDS)
  for (const brand of total <= MAX_COLLECT ? brands : []) {
    if (seen.size >= total) break
    const scoped = `${live.source}%3A%3ABrand%3A${encodeURIComponent(brand.name)}`
    try {
      const page = await fetchListing(scoped)
      add(page.products)
      for (const sort of brand.count > PAGE_SIZE ? EXTRA_SORTS : []) {
        if (page.products.length === 0) break
        add((await fetchListing(`${scoped}&sort=${sort}`)).products)
      }
    } catch {
      // one brand failing must not lose the rest of the window
    }
  }
  // Last resort for anything the brand partition missed.
  for (const sort of seen.size < total ? EXTRA_SORTS : []) {
    try {
      add((await fetchListing(`${live.source}${sep}sort=${sort}`)).products)
    } catch {
      /* ignore */
    }
  }
  const skus = products.map(toSku)
  const discountPct = inferDiscountPct(live.code, skus)
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

const fmtResults = (res) => Object.entries(res).map(([k, v]) => `${k}:${v}`).join(' ') || '(no channels configured)'

/**
 * One watcher step, host-agnostic: given the previous feed, return what to
 * publish now (null when nothing material changed and the hourly heartbeat
 * is not yet due) plus a closed window to append to the history, if any.
 * `deps` lets a test stand in for the network: { detect, notify, post }.
 */
export async function step(previous, deps = {}) {
  const detectFn = deps.detect ?? detect
  const notifyFn = deps.notify ?? notify
  const postFn = deps.post ?? postWindow
  const now = new Date().toISOString()
  let next
  try {
    // Alert on the OPENING EDGE only — a window starting, or the code
    // changing mid-window. Firing every tick would mean a text every twenty
    // seconds for the life of the window. It goes out from inside detect,
    // on the first page, with the discount inferred from the coins on it;
    // the full SKU set is published afterwards.
    //
    // Both edges are keyed on what the PREVIOUS feed said, which is what
    // makes them fire once per window: a heartbeat rewrite, a failed read
    // mid-window and a restart all see `previous.live` already true.
    const opening = (code) => !(previous.live && previous.code === code) && !SILENT
    let alerted = false
    let posted = false
    const d = await detectFn(
      previous,
      async (early) => {
        if (!opening(early.code)) return
        const feed = { ...early, discountPct: inferDiscountPct(early.code, early.skus), partial: true }
        try {
          const text = composeAlert(feed)
          const res = DRY_RUN ? (console.log(`DRY-RUN alert:\n${text}`), { dryRun: 'printed' }) : await notifyFn(text)
          console.log(`ALERT ${fmtResults(res)} at ${new Date().toISOString()}`)
          alerted = true
        } catch (e) {
          // A channel failing must never cost the window its crawl and publish.
          console.error(`ALERT failed: ${e.message}`)
        }
      },
      async (page) => {
        if (!opening(page.code)) return
        const feed = { ...page, discountPct: inferDiscountPct(page.code, page.skus) }
        try {
          const res = await postFn('open', feed, { dryRun: DRY_RUN })
          console.log(`POST open ${fmtResults(res)} at ${new Date().toISOString()}`)
          posted = true
        } catch (e) {
          console.error(`POST open failed: ${e.message}`)
        }
      },
    )
    // heartbeatMs makes the feed self-describing: a consumer knows how stale
    // checkedAt can get while still healthy, instead of hardcoding a guess.
    next = { generated: now, checkedAt: now, ok: true, heartbeatMs: HEARTBEAT_MS, ...d }
    if (d.live) {
      const from = previous.live && previous.code === d.code ? previous.lastLive?.from ?? now : now
      next.lastLive = { code: d.code, couponId: d.couponId, from, skuCount: d.skus.length }
    } else if (previous.lastLive) {
      next.lastLive = previous.lastLive.to ? previous.lastLive : { ...previous.lastLive, to: now }
    }
    console.log(d.live ? `LIVE  ${d.code} — ${d.skus.length}/${d.totalCount} SKUs` : 'quiet — no BLINK* coupon on gold coins')
    if (alerted) next.alertedAt = now
    if (posted) next.postedAt = now
  } catch (e) {
    // A failed read never ends a window: keep what we knew, mark it stale.
    next = { ...previous, generated: now, checkedAt: now, ok: false, stale: true, error: String(e.message ?? e) }
    console.error(`FAIL  ${e.message}`)
  }

  let closedWindow = null
  if (previous.live && !next.live && next.ok) {
    const w = previous.lastLive ?? { code: previous.code, from: previous.checkedAt }
    closedWindow = { ...w, to: now, maxSkus: previous.skus?.length ?? 0 }
    // The CLOSING EDGE: exactly one tick sees live→quiet, so this posts once.
    if (!SILENT) {
      try {
        const res = await postFn('close', closedWindow, { dryRun: DRY_RUN })
        console.log(`POST close ${fmtResults(res)} at ${new Date().toISOString()}`)
        closedWindow.postedAt = now
      } catch (e) {
        console.error(`POST close failed: ${e.message}`)
      }
    }
  }

  const material =
    !!previous.live !== !!next.live || previous.code !== next.code || !!previous.ok !== !!next.ok ||
    skuKey(previous) !== skuKey(next) || (next.knownIds ?? []).length !== (previous.knownIds ?? []).length
  const beat = next.live ? LIVE_HEARTBEAT_MS : HEARTBEAT_MS
  next.heartbeatMs = beat
  const heartbeatDue = !previous.checkedAt || Date.now() - Date.parse(previous.checkedAt) > beat
  return { next: material || heartbeatDue ? next : null, closedWindow }
}

/**
 * Add a closed window to the history file.
 *
 * `generated` is stamped on every write. The app ranks the copies of this
 * file it can see — the snapshot bundled with the build, the one in
 * localStorage, the one off the wire — by that field, and falls back to the
 * last window's close when it is absent. The fallback works, but it makes a
 * file's age a guess derived from its contents: two files written days apart
 * carrying the same last window rank equal, and a hand-edited one (the 15 Sep
 * backfill, 2026-09-21) can be beaten by an older file that happens to end
 * later. Stamping it makes the ranking a fact instead of an inference.
 *
 * The time is a parameter rather than a call inside, so the function stays
 * pure and a test can pin it.
 */
export function appendWindow(history, w, generated = new Date().toISOString()) {
  return { generated, windows: [...(history?.windows ?? []), w].slice(-100) }
}

async function main() {
  if (PROBE) return probe()

  const readJson = async (p, fallback) => {
    try {
      return JSON.parse(await readFile(p, 'utf8'))
    } catch {
      return fallback
    }
  }
  const previous = await readJson(OUT, {})
  const { next, closedWindow } = await step(previous)
  if (closedWindow) {
    const history = appendWindow(await readJson(HISTORY, null), closedWindow, new Date().toISOString())
    await writeFile(HISTORY, JSON.stringify(history, null, 1) + '\n')
  }
  if (!next) {
    console.log('unchanged — not rewriting')
    return
  }
  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(OUT, JSON.stringify(next, null, 1) + '\n')
  console.log(`wrote ${OUT}`)
}

// Run as a script; stay quiet when a host adapter imports `step`.
const entry = process.argv[1] ? process.argv[1].replace(/\\/g, '/').toLowerCase() : ''
if (entry.endsWith('/blinkdeal.mjs')) main()
