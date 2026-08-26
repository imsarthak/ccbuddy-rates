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

## Run locally

```bash
node scraper/scrape.mjs
```
