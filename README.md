# ccbuddy-rates

Public gold-rate feed for the [CCBuddy](https://github.com/imsarthak/ccbuddy)
app's Gold Rates module.

A GitHub Actions cron job runs `scraper/scrape.mjs` every 2 hours, reading
publicly published gold rates from Indian jewellers/refiners (Malabar,
Kalyan/Candere, Bangalore Refinery, PNG — more to come) and committing the
result to `docs/rates.json`, which GitHub Pages serves with permissive CORS.

- **No user data is involved anywhere in this repo or feed** — it only ever
  contains public market rates.
- Reads are low-volume (~12/merchant/day) with an honest User-Agent.
- A merchant read that fails keeps the previous value marked `stale: true`
  ("last good read"); rates outside sane bounds are rejected.

## Feed

```
https://imsarthak.github.io/ccbuddy-rates/rates.json
```

Schema: `{ updated, merchants: [{ id, name, short, site, note, rate:
{ fetched, buy24, buy22, sell22?, ok, stale?, error? }, spark: [buy24…] }] }`
— prices in INR per gram.

```
https://imsarthak.github.io/ccbuddy-rates/portal-caps.json
```

Reward-portal earning caps (SmartBuy, iShop, Travel EDGE, Travel with Points,
Travel & Shop): base + bonus points per slab and what each cap counts, so the
₹-to-cap figure is derived, never typed. Hand-maintained in the ccbuddy repo
(`src/data/portalCaps.data.ts`, every row read from the issuer's own terms)
and written here with `npm run caps:json`; `generated` decides which copy the
app uses. Schema: `{ generated, rules: [{ id, bank, cards, portal: { name,
url }, category, earn: { slab, base, bonus }, beyondCap?, caps: [{ value,
unit, counts, period }], verifiedOn?, source, confidence, notes?,
assumption? }] }`.

## Merchants investigated but currently blocked

Tanishq, Bhima, and MMTC-PAMP hard-403 non-browser clients (bot protection
that would reject GitHub's datacenter IPs regardless of headers); Aspect
Bullion's site was unreachable; Lalithaa's pricing API rejects unauthenticated
guesses and its SPA route exposes no static rates; Joyalukkas renders rates
client-side only. Revisit if their publishing changes, or if this feed ever
moves to infrastructure with residential egress.

## Run locally

```bash
node scraper/scrape.mjs
```
