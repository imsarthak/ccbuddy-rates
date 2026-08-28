// CCBuddy gold rates scraper.
// Reads public gold rates from Indian jewellers/refiners and publishes
// docs/rates.json for the CCBuddy app. Run on a schedule (~every 2 hours);
// a failed adapter keeps the previous rate marked stale.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

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

// Fetch via the system curl binary. Some Cloudflare rules block node's undici
// TLS fingerprint but pass curl's, so this is the escape hatch for those hosts
// (verified: Bhima 403s node fetch but 200s curl, from any IP). curl ships on
// the GitHub Actions ubuntu runner and on dev machines.
async function curlGet(url, headers = {}) {
  const args = [
    '-sS', '--compressed', '-L', '--max-time', String(TIMEOUT_MS / 1000),
    '--fail', // non-2xx -> non-zero exit, so we throw like get()
    '-A', headers['User-Agent'] ?? UA,
  ]
  for (const [k, v] of Object.entries(headers)) {
    if (k === 'User-Agent') continue
    args.push('-H', `${k}: ${v}`)
  }
  args.push(url)
  try {
    const { stdout } = await execFileAsync('curl', args, { maxBuffer: 8 * 1024 * 1024 })
    return stdout
  } catch (e) {
    const code = /(\b\d{3}\b)/.exec(e.stderr ?? '')?.[1]
    throw new Error(code ? `HTTP ${code}` : `curl failed: ${String(e.message ?? e).slice(0, 80)}`)
  }
}

async function post(url, body, headers = {}) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json', ...headers },
      // string bodies pass through raw (socket.io frames); objects go as JSON
      body: typeof body === 'string' ? body : JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } finally {
    clearTimeout(t)
  }
}

// Some origins (Akamai/Cloudflare) refuse our polite self-identifying UA but
// accept a request that looks like their own frontend making it.
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'sec-ch-ua': '"Not;A=Brand";v="99", "Google Chrome";v="139", "Chromium";v="139"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
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
    // Adapter: getMetalRate GraphQL call from their live-rate page.
    note: 'Their One India One Gold Rate, as published on malabargoldanddiamonds.com.',
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
    // Adapter: rate card regex on the Candere city page (prints per-10g; swap city in URL).
    note: "Kalyan's online arm Candere — Hyderabad board.",
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
    note: 'Wholesale refinery rate, 18% GST extra — the only board here with a published buyback.',
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
    market: 'Pan-India',
    site: 'https://www.pngjewellers.com/',
    note: 'As published on their online store.',
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
    market: 'Bengaluru',
    site: 'https://www.joyalukkas.in/gold-rate',
    // Adapter: getgoldrates GraphQL; ECM = their online-shop Bangalore branch.
    note: 'As published on their online store.',
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
    market: 'Pan-India',
    hidden: true, // still scraped for history; not shown in the app for now
    site: 'https://www.dpjewellers.com/',
    // Adapter: metalPrices Magento GraphQL.
    note: 'As published on their online store.',
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
    // Adapter: their public pricing API (states -> pricings/latest).
    note: 'Their Telangana board — Lalithaa rates vary by state.',
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
    market: 'Chennai',
    site: 'https://www.grtjewels.com/',
    // Adapter: rate JSON embedded (escaped) in the homepage.
    note: 'As published on their online store.',
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
    id: 'bhima',
    name: 'Bhima Jewellers',
    short: 'Bhima',
    market: 'Pan-India',
    // Cloudflare 403s node's fetch (undici TLS fingerprint) but passes curl —
    // so this one fetches via the curl binary. Verified 200 from curl on both
    // residential and CI (datacenter) IPs, 2026-08-28.
    site: 'https://www.bhimagold.com/',
    // Adapter: metalrate2.rateArray JSON embedded in the homepage HTML.
    note: 'As published on their online store.',
    async fetchRate() {
      const html = await curlGet(this.site, {
        ...BROWSER_HEADERS,
        // Look like an HTML page navigation, not a same-origin JSON XHR.
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1',
      })
      const grab = (karat, fine) => {
        // rateArray entries look like {"metal":"Online Gold Rate 24 KT (999)","rate":"₹16,079.00/g"}.
        // Tolerate optional backslash escaping (\") in case the block is nested in a JSON string, like GRT.
        const re = new RegExp(
          'Online Gold Rate ' + karat + ' KT \\(' + fine + '\\)\\\\?",\\\\?"rate\\\\?":\\\\?"[^0-9]*([0-9,.]+)',
        )
        const m = html.match(re)
        if (!m) throw new Error(`${karat} KT (${fine}) pattern not found`)
        return num(m[1])
      }
      return { buy24: grab(24, 999), buy22: grab(22, 916) }
    },
  },
  {
    id: 'indriya',
    name: 'Indriya (Aditya Birla)',
    short: 'Indriya',
    market: 'Pan-India',
    site: 'https://www.indriya.com/gold-rate-today',
    // Adapter: AEM goldChart JSON (double-parsed ratesJson).
    note: "As published on their online store. Their 24K is 995-fine, so it reads slightly under a 999 board.",
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
  {
    id: 'mmtc',
    name: 'MMTC-PAMP',
    short: 'MMTC',
    market: 'Pan-India',
    site: 'https://www.mmtcpamp.com/gold-silver-rate-today',
    note: 'Minted-bar buy price before GST — sits above a plain spot rate. 22K is derived.',
    // Adapter: their getQuote API; Akamai wants full browser headers.
    async fetchRate() {
      const raw = await post(
        'https://www.mmtcpamp.com/api/getQuote',
        { type: 'BUY', currencyPair: 'XAU/INR', quantity: '1' },
        {
          ...BROWSER_HEADERS,
          Origin: 'https://www.mmtcpamp.com',
          Referer: 'https://www.mmtcpamp.com/gold-silver-rate-today',
        },
      )
      const j = JSON.parse(raw)
      const buy24 = num(j.preTaxAmount)
      if (!Number.isFinite(buy24)) throw new Error('preTaxAmount missing')
      // They only mint 999 fine — 22K shown as the standard 916 fraction.
      return { buy24, buy22: Math.round(buy24 * 0.916), derived22: true }
    },
  },
  {
    id: 'aspect',
    name: 'Aspect Bullion',
    short: 'Aspect',
    market: 'Bengaluru',
    site: 'https://aspectbullion.com/',
    note: 'Live bullion dealer board (999 fine, quoted per 10 g). 22K is derived; buyback included.',
    // Adapter: their socket.io LiveData feed, read over the polling transport
    // (handshake -> namespace connect -> one poll) so no client dependency.
    async fetchRate() {
      const base = 'https://aspectbullion.com:8022/socket.io/?EIO=4&transport=polling'
      const hs = await get(base)
      const sid = JSON.parse(hs.slice(hs.indexOf('{'))).sid
      await post(`${base}&sid=${sid}`, '40')
      let frame = ''
      for (let i = 0; i < 5 && !frame.includes('"gold999"'); i++) {
        frame = await get(`${base}&sid=${sid}`)
      }
      const m = frame.match(/42\["LiveData",(\[.*?\])\]/s)
      if (!m) throw new Error('no LiveData frame')
      const rows = JSON.parse(m[1])
      const spot = rows.find((r) => r.symbol === 'gold')
      const fine = rows.find((r) => r.symbol === 'gold999')
      if (!spot || !fine) throw new Error('gold rows missing')
      const buy24 = (num(fine.Ask) + num(fine.premiumAsk)) / 10 // board quotes per 10 g
      const rate = { buy24: Math.round(buy24), buy22: Math.round(buy24 * 0.916), derived22: true }
      const bid = num(spot.Bid) + num(fine.premiumBid)
      if (Number.isFinite(bid) && bid > 0) rate.sell22 = Math.round(bid / 10)
      return rate
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
