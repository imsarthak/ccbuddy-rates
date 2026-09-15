// Does Myntra accept a residential proxy?
//
// We know two things already: every datacenter egress gets a 483-byte "Site
// Maintenance" page, and a home connection gets the real ~691 KB listing. The
// open question is whether a COMMERCIAL residential proxy — shared pools that
// sites often flag — lands on the first side or the second. A paid plan is
// only worth buying if it lands on the second.
//
// Two things could fail independently, so this separates them:
//   the exit IP        — is the proxy's address itself refused?
//   the TLS handshake  — curl looks different from a browser on the wire,
//                        and some WAFs refuse it regardless of address
// Running curl both directly and through the proxy tells the two apart.
//
//   node scraper/proxy-check.mjs                  reads .proxy.env
//   node scraper/proxy-check.mjs --proxy <url>    or pass it explicitly
//
// The proxy URL usually looks like http://user:pass@host:port. It is never
// printed, and .proxy.env is gitignored.

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ARGS = process.argv.slice(2)
const argProxy = ARGS.includes('--proxy') ? ARGS[ARGS.indexOf('--proxy') + 1] : null

const TARGET = 'https://www.myntra.com/gold-coins'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36'
const HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-IN,en;q=0.9',
  'Upgrade-Insecure-Requests': '1',
}

/** Real page or block page? The two are ~691 KB and ~483 bytes, so this is unambiguous. */
function verdict(body) {
  if (!body) return { ok: false, what: 'empty response' }
  if (body.includes('window.__myx')) {
    const n = (body.match(/"productId":/g) || []).length
    const codes = [...new Set([...body.matchAll(/"couponCode":"([A-Z0-9]+)"/g)].map((m) => m[1]))]
    return { ok: true, what: `REAL PAGE — ${n} products, codes ${codes.join(',') || 'none'}` }
  }
  if (/Site Maintenance/i.test(body)) return { ok: false, what: 'BLOCKED — "Site Maintenance" stub' }
  if (/Access Denied|Just a moment|captcha/i.test(body)) return { ok: false, what: 'BLOCKED — challenge page' }
  return { ok: false, what: `unrecognised, ${body.length} bytes` }
}

async function viaNodeDirect() {
  const res = await fetch(TARGET, { headers: HEADERS, signal: AbortSignal.timeout(30000) })
  return { status: res.status, body: await res.text() }
}

async function viaCurl(url, proxy) {
  const args = ['-sS', '--compressed', '-L', '--max-time', '40', '-A', UA]
  for (const [k, v] of Object.entries(HEADERS)) {
    if (k !== 'User-Agent') args.push('-H', `${k}: ${v}`)
  }
  if (proxy) args.push('--proxy', proxy)
  args.push('-w', '\n__STATUS__%{http_code}', url)
  const { stdout } = await execFileAsync('curl', args, { maxBuffer: 32 * 1024 * 1024 })
  const at = stdout.lastIndexOf('\n__STATUS__')
  return { status: at === -1 ? 0 : Number(stdout.slice(at + 11)), body: at === -1 ? stdout : stdout.slice(0, at) }
}

/** Never let a proxy URL reach stdout — it carries the credentials. */
function redact(text, proxy) {
  let s = String(text ?? '')
  if (proxy) {
    s = s.split(proxy).join('<proxy>')
    const bare = proxy.replace(/^[a-z0-9+.-]+:\/\/[^@]*@/i, '')
    if (bare && bare !== proxy) s = s.split(bare).join('<proxy>')
    const creds = /^[a-z0-9+.-]+:\/\/([^@]*)@/i.exec(proxy)?.[1]
    if (creds) s = s.split(creds).join('<credentials>')
  }
  return s
}

/** Last octet masked — the address appears in logs and pasted output. */
const maskIp = (ip) => String(ip ?? '').replace(/^(\d+\.\d+\.\d+)\.\d+$/, '$1.x')

async function exitIdentity(proxy) {
  try {
    const { body } = await viaCurl('https://ipinfo.io/json', proxy)
    const j = JSON.parse(body)
    return `${maskIp(j.ip)} · ${j.city ?? '?'}, ${j.country ?? '?'} · ${j.org ?? '?'}`
  } catch {
    return proxy ? '(proxy unreachable)' : '(could not read exit identity)'
  }
}

async function main() {
  let proxy = argProxy || process.env.BLINKDEAL_PROXY || null
  if (!proxy) {
    try {
      proxy = (await readFile(join(ROOT, '.proxy.env'), 'utf8')).trim()
    } catch {
      /* no file */
    }
  }
  if (!proxy) {
    console.error('No proxy given. Put the URL in .proxy.env, or pass --proxy <url>.')
    console.error('Format: http://user:pass@host:port')
    process.exitCode = 2
    return
  }

  const rows = []
  console.log('target:', TARGET)
  console.log('direct exit: ', await exitIdentity(null))
  console.log('proxy exit:  ', await exitIdentity(proxy))
  console.log('')

  for (const [label, run] of [
    ['node fetch, direct  (control, known good)', () => viaNodeDirect()],
    ['curl, direct        (isolates TLS fingerprint)', () => viaCurl(TARGET, null)],
    ['curl, via proxy     (the actual question)', () => viaCurl(TARGET, proxy)],
  ]) {
    try {
      const { status, body } = await run()
      const v = verdict(body)
      rows.push({ label, ok: v.ok, reached: true })
      console.log(`${v.ok ? 'PASS' : 'FAIL'}  ${label}`)
      console.log(`      HTTP ${status}, ${body.length} bytes — ${v.what}`)
    } catch (e) {
      // A transport failure is NOT a block — a dead or mistyped proxy must not
      // be reported as "Myntra refused you".
      const msg = redact(e.message ?? e, proxy)
      const transport = /Could not resolve|Failed to connect|Connection refused|timed out|proxy|tunnel/i.test(msg)
      rows.push({ label, ok: false, reached: !transport })
      console.log(`FAIL  ${label}`)
      console.log(`      ${transport ? 'could not connect' : msg.slice(0, 140)}`)
    }
  }

  const [control, curlDirect, viaProxy] = rows
  console.log('\n--- verdict')
  if (viaProxy.ok) {
    console.log('BUY IT. Myntra serves the real page through this proxy.')
  } else if (!viaProxy.reached) {
    console.log('INCONCLUSIVE. The proxy could not be reached at all, so Myntra never saw it.')
    console.log('Check the URL, port and credentials, then run this again.')
  } else if (!control.ok) {
    console.log('INCONCLUSIVE. Even the direct control was blocked — run this from the home line.')
  } else if (!curlDirect.ok) {
    console.log('INCONCLUSIVE. curl is refused even directly, so this rig cannot judge the proxy.')
    console.log('The proxy may still be fine; the blocker is the TLS fingerprint, not the address.')
  } else {
    console.log('DO NOT BUY. curl works directly but not through the proxy, so the exit IP is refused.')
  }
  process.exitCode = viaProxy.ok ? 0 : 1
}

main()
