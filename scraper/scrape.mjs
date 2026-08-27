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
    market: 'Pan-India',
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
    market: 'Hyderabad',
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
    market: 'Bengaluru',
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
    market: 'Online (pan-India)',
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
  {
    id: 'joyalukkas',
    name: 'Joyalukkas',
    short: 'Joyalukkas',
    market: 'Online (Bengaluru)',
    site: 'https://www.joyalukkas.in/gold-rate',
    note: 'Online-store board, from the getgoldrates GraphQL call their site makes.',
    async fetchRate() {
      const q = '{ getgoldrates { metal_rate_time Data { BRANCH_CODE BRANCH_NAME GOLD_22KT_RATE GOLD_24KT_RATE } } }'
      const j = JSON.parse(await get('https://www.joyalukkas.in/graphql?query=' + encodeURIComponent(q)))
      const rows = j?.data?.getgoldrates?.Data ?? []
      const row = rows.find((r) => r.BRANCH_CODE === 'ECM') ?? rows[0]
      if (!row) throw new Error('no branch rows')
      return { buy24: num(row.GOLD_24KT_RATE), buy22: num(row.GOLD_22KT_RATE) }
    },
  },
  {
    id: 'dp',
    name: 'D.P. Jewellers',
    short: 'DP',
    market: 'Online (pan-India)',
    hidden: true, // still scraped for history; not shown in the app for now
    site: 'https://www.dpjewellers.com/',
    note: 'Storefront board, from the metalPrices Magento GraphQL call.',
    async fetchRate() {
      const q = '{ metalPrices { metal purity rate_id sale_rate } }'
      const j = JSON.parse(await get('https://www.dpjewellers.com/graphql?query=' + encodeURIComponent(q)))
      const rows = (j?.data?.metalPrices ?? []).filter((r) => String(r.metal).toLowerCase() === 'gold')
      const pick = (p) => rows.find((r) => String(r.purity).toUpperCase().startsWith(p))
      const g24 = pick('24')
      const g22 = pick('22')
      if (!g24 || !g22) throw new Error('22KT/24KT rows missing')
      return { buy24: num(g24.sale_rate), buy22: num(g22.sale_rate) }
    },
  },
  {
    id: 'lalithaa',
    name: 'Lalithaa Jewellery',
    short: 'Lalithaa',
    market: 'Telangana',
    site: 'https://www.lalithaajewellery.com/',
    note: 'Telangana board from their public pricing API — rates vary by state.',
    async fetchRate() {
      const states = JSON.parse(await get('https://api.lalithaajewellery.com/public/states?limit=50'))
      const rows = states?.data?.items ?? []
      const state = rows.find((s) => /telangana/i.test(s.name ?? ''))
      if (!state?.id) throw new Error('Telangana state id not found')
      const j = JSON.parse(await get(`https://api.lalithaajewellery.com/public/pricings/latest?state_id=${state.id}`))
      const prices = j?.data?.prices
      if (!prices?.gold_24kt || !prices?.gold_22kt) throw new Error('gold prices missing')
      return { buy24: num(prices.gold_24kt.price), buy22: num(prices.gold_22kt.price) }
    },
  },
  {
    id: 'grt',
    name: 'GRT Jewellers',
    short: 'GRT',
    market: 'Online (Chennai)',
    site: 'https://www.grtjewels.com/',
    note: 'Storefront board, from the rate JSON embedded in the homepage.',
    async fetchRate() {
      const html = await get(this.site)
      const grab = (karat) => {
        // The rate JSON sits backslash-escaped inside a larger JSON string,
        // so quotes may appear as \" — tolerate the optional backslashes.
        const m = html.match(new RegExp('purity\\\\?":\\\\?"' + karat + ' KT\\\\?",\\\\?"amount\\\\?":([\\d.]+)'))
        if (!m) throw new Error(`${karat} KT pattern not found`)
        return num(m[1])
      }
      return { buy24: grab(24), buy22: grab(22) }
    },
  },
  {
    id: 'indriya',
    name: 'Indriya (Aditya Birla)',
    short: 'Indriya',
    market: 'Online (pan-India)',
    site: 'https://www.indriya.com/gold-rate-today',
    note: "Their 24K board is 995-fine, so it reads slightly under a 999 board.",
    async fetchRate() {
      const url =
        'https://www.indriya.com/content/noveljewels/in/en/gold-rate-today/jcr:content/root/container/container/container_copy_copy__1497933197/chartcomponent.goldChart.json?storeId=NS0001'
      const outer = JSON.parse(await get(url))
      const inner = JSON.parse(outer.ratesJson) // stringified JSON inside JSON
      const purities = inner?.purities ?? []
      // Nesting under each purity varies — walk it for gold_rate.today.
      const findRate = (node) => {
        if (!node || typeof node !== 'object') return undefined
        if (node.gold_rate?.today != null) return num(node.gold_rate.today)
        for (const v of Object.values(node)) {
          const hit = findRate(v)
          if (hit != null) return hit
        }
        return undefined
      }
      const rateFor = (prefix) => {
        const p = purities.find((x) => String(x.purity).toUpperCase().startsWith(prefix))
        if (!p) throw new Error(`${prefix} purity missing`)
        const r = findRate(p)
        if (r == null) throw new Error(`${prefix} gold_rate.today missing`)
        return r
      }
      return { buy24: rateFor('24'), buy22: rateFor('22') }
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
    const entry = { id: m.id, name: m.name, short: m.short, site: m.site, note: m.note, market: m.market }
    if (m.hidden) entry.hidden = true
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
