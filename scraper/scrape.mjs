// CCBuddy gold rates scraper.
// Reads public gold rates from Indian jewellers/refiners and publishes
// docs/rates.json for the CCBuddy app. Run on a schedule (~every 2 hours);
// a failed adapter keeps the previous rate marked stale.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'docs', 'rates.json')

const UA = 'CCBuddyRates/1.0 (+https://github.com/imsarthak/ccbuddy-rates; public rate comparison; ~12 reads/day)'
const TIMEOUT_MS = 20000
const SPARK_MAX = 30

async function get(url, headers = {}) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } finally {
    clearTimeout(t)
  }
}

const num = (s) => parseFloat(String(s).replace(/,/g, ''))

function sane(r) {
  return (
    Number.isFinite(r.buy24) && Number.isFinite(r.buy22) &&
    r.buy24 > 8000 && r.buy24 < 60000 &&
    r.buy22 > 6000 && r.buy22 < r.buy24
  )
}

const MERCHANTS = [
  {
    id: 'malabar',
    name: 'Malabar Gold & Diamonds',
    short: 'Malabar',
    site: 'https://www.malabargoldanddiamonds.com/in/pan-india/en/live-gold-rate.html',
    note: 'One India One Gold Rate, from the getMetalRate GraphQL call their live-rate page makes.',
    async fetchRate() {
      const q =
        'query getMetalRate($filter: MetalRateFilterInput) { getMetalRate(filter: $filter) { items { entry_date entry_time purity unit rate country state } } }'
      const vars = '{"filter":{"metal_type":"gold","country":"India"}}'
      const url =
        'https://www.malabargoldanddiamonds.com/graphql-magento?query=' +
        encodeURIComponent(q) +
        '&variables=' +
        encodeURIComponent(vars)
      const j = JSON.parse(await get(url))
      const items = j?.data?.getMetalRate?.items ?? []
      const pick = (p) => items.find((i) => String(i.purity).toLowerCase() === p && i.unit === 'G')
      const g24 = pick('24k')
      const g22 = pick('22k')
      if (!g24 || !g22) throw new Error('22k/24k entries missing')
      return { buy24: num(g24.rate), buy22: num(g22.rate) }
    },
  },
  {
    id: 'kalyan',
    name: 'Kalyan Jewellers (Candere)',
    short: 'Kalyan',
    site: 'https://www.candere.com/gold-rate-today/hyderabad',
    note: 'Candere Hyderabad board — swap the city in the URL for another market. Page prints per-10g.',
    async fetchRate() {
      const html = await get(this.site)
      const grab = (karat) => {
        const re = new RegExp(
          `goldCard--rate">(?:₹|&#8377;)([\\d,]+)<span>\\/10gm</span></p><p class="goldCard--karat">${karat} Karat`,
        )
        const m = html.match(re)
        if (!m) throw new Error(`${karat}K pattern not found`)
        return num(m[1]) / 10
      }
      return { buy24: grab(24), buy22: grab(22) }
    },
  },
  {
    id: 'brpl',
    name: 'Bangalore Refinery',
    short: 'BRPL',
    site: 'https://bangalorerefinery.com/pages/todays-rates',
    note: 'Wholesale, 18% GST extra. The only board here that prints a buyback.',
    async fetchRate() {
      const txt = await get('https://www.bangalorerefinery.com/cdn/shop/files/rates.txt')
      const pairs = JSON.parse(txt).map(([label, price]) => [String(label).replace(/\s+/g, ' ').trim(), price])
      const find = (re) => {
        const hit = pairs.find(([label]) => re.test(label))
        if (!hit) throw new Error(`label ${re} not found`)
        return num(hit[1])
      }
      const rate = {
        buy24: find(/^24K \(9999\) 1 g GoldBar$/i),
        buy22: find(/^22K \(916\) Gold Coin 1 gm$/i),
      }
      try {
        rate.sell22 = find(/^BuyBack Gold Rate \(gm\)$/i)
      } catch {
        // buyback line missing is tolerable
      }
      return rate
    },
  },
  {
    id: 'png',
    name: 'PNG Jewellers',
    short: 'PNG',
    site: 'https://www.pngjewellers.com/',
    note: 'Online purchase rate as published on the storefront.',
    async fetchRate() {
      const html = await get(this.site)
      const grab = (karat) => {
        const m = html.match(new RegExp(`${karat}K Gold\\s*<span class="price"[^>]*>₹([\\d,]+)</span>`))
        if (!m) throw new Error(`${karat}K pattern not found`)
        return num(m[1])
      }
      return { buy24: grab(24), buy22: grab(22) }
    },
  },
]

async function main() {
  let previous = { merchants: [] }
  try {
    previous = JSON.parse(await readFile(OUT, 'utf8'))
  } catch {
    // first run
  }
  const prevById = new Map(previous.merchants.map((m) => [m.id, m]))

  const merchants = []
  for (const m of MERCHANTS) {
    const prev = prevById.get(m.id)
    const entry = { id: m.id, name: m.name, short: m.short, site: m.site, note: m.note }
    try {
      const r = await m.fetchRate()
      if (!sane(r)) throw new Error(`insane values ${JSON.stringify(r)}`)
      entry.rate = { fetched: new Date().toISOString(), ...r, ok: true }
      entry.spark = [...(prev?.spark ?? []), r.buy24].slice(-SPARK_MAX)
      console.log(`ok    ${m.id}: 24K ${r.buy24} / 22K ${r.buy22}${r.sell22 ? ` / buyback ${r.sell22}` : ''}`)
    } catch (e) {
      const last = prev?.rate
      entry.rate = last?.buy24
        ? { ...last, ok: false, stale: true, error: String(e.message ?? e) }
        : { fetched: new Date().toISOString(), ok: false, error: String(e.message ?? e) }
      entry.spark = prev?.spark ?? []
      console.error(`FAIL  ${m.id}: ${e.message}`)
    }
    merchants.push(entry)
  }

  const payload = { updated: new Date().toISOString(), merchants }
  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(OUT, JSON.stringify(payload, null, 1) + '\n')
  const okCount = merchants.filter((m) => m.rate.ok).length
  console.log(`wrote ${OUT} — ${okCount}/${merchants.length} merchants ok`)
  if (okCount === 0) process.exitCode = 1 // full failure: keep the old commit
}

main()
