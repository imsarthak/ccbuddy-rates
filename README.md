# ccbuddy-rates

Public gold-rate feed for the [CCBuddy](https://github.com/imsarthak/ccbuddy)
app's Gold Rates module.

A GitHub Actions cron job runs `scraper/scrape.mjs` hourly through the Indian
business day (and twice overnight), reading publicly published gold rates from
Indian jewellers/refiners (Malabar, Kalyan/Candere, Bangalore Refinery, PNG —
more to come) and committing the result to `docs/rates.json`, which GitHub
Pages serves with permissive CORS.

**On the schedule** (changed 2026-09-11). It used to be a flat `every 2 hours`,
which delivered badly: GitHub's scheduler is best-effort on free runners and
drops slots, so 12 requested runs a day produced 5–7, with gaps up to 7h52m —
the feed read hours stale even though every run succeeded. Nothing can force a
given slot to fire, so the slots were concentrated where they earn something.
Measured across 100 run-to-run comparisons of `rates.json`, changes cluster on
the Indian business day: a 05:47 IST run moved 1 merchant of 15, while 12:51
and 16:59 IST moved 12 of 15. See `.github/workflows/scrape.yml`.

- **No user data is involved anywhere in this repo or feed** — it only ever
  contains public market rates.
- Reads stay low-volume (~14/merchant/day requested, fewer delivered) with an
  honest User-Agent. Only Bhima, Tanishq and Senco go through Firecrawl; the
  rest are direct fetches.
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
