// A coin's stock as the feed publishes it: what stockOf reads off Myntra's
// inventoryInfo, and that toSku carries it.
//
//   node --test scraper/stock.test.mjs
//
// Nothing here touches the network. The product is a trimmed copy of the
// first one in captures/listing-products-2026-10-29.json (capture/bd-stock
// branch), the gold-coins listing read on a phone at 21:02 IST that day.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stockOf, toSku } from './blinkdeal.mjs'

const ENTRY = { skuId: 74070454, label: 'Onesize', inventory: 752, available: true, brandSizeLabel: 'Onesize' }
const CAPTURED = {
  landingPageUrl: 'gold-coin/bhima/bhima-floral-24k-999-purity-gold-bar-1-gram/23250690/buy',
  productId: 23250690,
  productName: 'BHIMA Floral 24K 999 Purity Gold Bar 1 gram',
  brand: 'BHIMA',
  additionalInfo: '24KT Gold Bar -1gm',
  mrp: 16714,
  price: 15759,
  inventoryInfo: [ENTRY],
  couponData: { couponDiscount: 300, couponDescription: { couponCode: 'MYNTRA300', bestPrice: 15459 } },
}
const withEntries = (inventoryInfo) => ({ ...CAPTURED, inventoryInfo })

test('the captured shape: one entry, and the stock is its inventory', () => {
  assert.equal(stockOf(CAPTURED), 752)
})

test('two entries are summed', () => {
  assert.equal(stockOf(withEntries([ENTRY, { ...ENTRY, skuId: 74070455, inventory: 10 }])), 762)
})

test('zero is a count, not a missing one', () => {
  assert.equal(stockOf(withEntries([{ ...ENTRY, inventory: 0 }])), 0)
})

test('an entry marked available: false is left out', () => {
  assert.equal(stockOf(withEntries([ENTRY, { ...ENTRY, inventory: 40, available: false }])), 752)
  assert.equal(stockOf(withEntries([{ ...ENTRY, available: false }])), null, 'alone, nothing usable is left')
  const { available, ...unmarked } = ENTRY
  assert.equal(stockOf(withEntries([unmarked])), 752, 'only false excludes; a missing flag does not')
})

test('an inventory that is not a whole number of at least 0 is ignored', () => {
  for (const bad of ['3', -1, 1.5, NaN, Infinity, null, undefined]) {
    assert.equal(stockOf(withEntries([{ ...ENTRY, inventory: bad }])), null, `${String(bad)} alone`)
    assert.equal(stockOf(withEntries([ENTRY, { ...ENTRY, inventory: bad }])), 752, `${String(bad)} beside a good entry`)
  }
})

test('no usable entry is null', () => {
  const { inventoryInfo, ...missing } = CAPTURED
  assert.equal(stockOf(missing), null, 'missing')
  for (const info of [[], null, {}, ENTRY, 'Onesize', 752, [null], [752], ['Onesize']]) {
    assert.equal(stockOf(withEntries(info)), null, JSON.stringify(info))
  }
  assert.equal(stockOf(null), null)
  assert.equal(stockOf(undefined), null)
})

// Pinned on purpose: this is every key a coin in docs/blinkdeal.json has.
test('toSku carries stock, and these are all the keys a coin has', () => {
  assert.deepEqual(toSku(CAPTURED), {
    id: 23250690,
    name: 'BHIMA Floral 24K 999 Purity Gold Bar 1 gram',
    brand: 'BHIMA',
    info: '24KT Gold Bar -1gm',
    price: 15759,
    mrp: 16714,
    discount: 300,
    bestPrice: 15459,
    code: 'MYNTRA300',
    url: 'https://www.myntra.com/gold-coin/bhima/bhima-floral-24k-999-purity-gold-bar-1-gram/23250690/buy',
    stock: 752,
  })
})

test('toSku with nothing to read publishes stock as null, never 0', () => {
  const { inventoryInfo, ...missing } = CAPTURED
  const sku = toSku(missing)
  assert.equal('stock' in sku, true)
  assert.equal(sku.stock, null)
  assert.equal(JSON.parse(JSON.stringify(sku)).stock, null, 'it survives the write as null')
})
