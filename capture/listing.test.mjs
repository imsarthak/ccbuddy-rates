// node --test capture/listing.test.mjs
//
// The page below is INVENTED. Nobody committed a real listing, which is the
// whole reason this capture exists, so the product shape here (an
// `inventoryInfo` array) is only the commonly reported one, used to check
// that the script finds a stock-like field wherever it sits and saves
// nothing but products. These tests never fetch anything.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractMyx, keep, stockPaths, verdict, redact } from './listing.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'listing.mjs')

const product = (id, inventory, extra = {}) => ({
  productId: id,
  productName: `Invented 24K Coin ${id}`,
  brand: 'Invented',
  price: 15000,
  mrp: 16000,
  inventoryInfo: [{ skuId: id * 10, label: 'Onesize', inventory, available: inventory > 0 }],
  ...extra,
})

const page = (myx) => `<html><script>window.__myx = ${JSON.stringify(myx)};</script></html>`
const MYX = {
  searchData: { results: { totalCount: 3, products: [product(1, 3), product(2, 0), product(3, 3518)], filters: { secret: 'x' } } },
  user: { session: 'not to be kept' },
}

test('keeps totalCount and products only', () => {
  const kept = keep(extractMyx(page(MYX)))
  assert.deepEqual(Object.keys(kept), ['totalCount', 'products'])
  assert.equal(kept.products.length, 3)
  assert.equal(JSON.stringify(kept).includes('not to be kept'), false)
  assert.equal(JSON.stringify(kept).includes('secret'), false)
})

test('finds the stock-like paths, with counts and ranges', () => {
  const paths = stockPaths(keep(extractMyx(page(MYX))).products)
  const inv = paths.find((p) => p.path === 'inventoryInfo[].inventory')
  assert.ok(inv, JSON.stringify(paths))
  assert.equal(inv.products, 3)
  assert.equal(inv.min, 0)
  assert.equal(inv.max, 3518)
  assert.equal(inv.maxPerProduct, 1)
  const avail = paths.find((p) => p.path === 'inventoryInfo[].available')
  assert.deepEqual(avail.other.sort(), ['false', 'true'])
  // An array of objects is walked into, never reported as a leaf itself.
  assert.equal(paths.some((p) => p.path === 'inventoryInfo'), false)
})

test('the verdict says so plainly when nothing looks like stock', () => {
  const kept = { totalCount: 1, products: [{ productId: 1, price: 1 }] }
  assert.deepEqual(verdict(kept, stockPaths(kept.products)), [
    '1 products read (totalCount 1).',
    'No field that looks like stock. The idea stops here.',
  ])
})

test('a token never reaches the screen', () => {
  const url = 'https://github_pat_ABC123@github.com/imsarthak/ccbuddy-rates.git'
  const said = redact(`fatal: unable to access '${url}': 403`, url)
  assert.equal(said.includes('ABC123'), false)
  assert.equal(redact('fatal: https://ghp_x@github.com/a', '').includes('ghp_x'), false)
})

test('a maintenance stub saves nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bdcap-'))
  const stub = join(dir, 'stub.html')
  writeFileSync(stub, '<html><title>Site Maintenance</title></html>')
  let out = ''
  try {
    execFileSync(process.execPath, [SCRIPT, '--html', stub, '--no-push'], { env: { ...process.env, CAPTURE_CLONE: dir }, encoding: 'utf8' })
  } catch (e) {
    out = e.stdout
    assert.equal(e.status, 1)
  }
  assert.match(out, /Nothing saved/)
  assert.deepEqual(readdirSync(dir).sort(), ['stub.html'])
})

test('a real-shaped page is saved, products only, and the verdict printed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bdcap-'))
  const html = join(dir, 'page.html')
  writeFileSync(html, page(MYX))
  const out = execFileSync(process.execPath, [SCRIPT, '--html', html, '--no-push'], { env: { ...process.env, CAPTURE_CLONE: dir }, encoding: 'utf8' })
  assert.match(out, /inventoryInfo\[\]\.inventory: 3\/3 products, min 0, max 3518/)
  const [file] = readdirSync(join(dir, 'captures'))
  const saved = JSON.parse(readFileSync(join(dir, 'captures', file), 'utf8'))
  assert.deepEqual(Object.keys(saved).sort(), ['bytes', 'capturedAt', 'products', 'status', 'totalCount', 'url'])
  assert.equal(JSON.stringify(saved).includes('not to be kept'), false)
})
