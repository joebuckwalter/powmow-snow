# powmow-snow

Snow conditions page for Powder Mountain, Utah, built from free public sources
(NRCS SNOTEL, NWS, Open-Meteo, the resort's own feeds). Not affiliated with the resort or OpenSnow.

The page loads each source live from the Cloudflare Worker: `worker.js` routes `/live/<source>.json`
to `live.js`, which fetches and computes that source on request. Upstream responses are edge-cached
for about as long as each source takes to change (`TTL` in `live.js`). All arithmetic happens in
`live.js`, not in the page.

`fetch.py` is the older Python version of the same pull. A GitHub Actions job still runs it a few
times a day (GitHub's schedule is best-effort) to publish `site/data.json`, which is the fallback when a
live source fails, and to append `history/daily.jsonl`. Keep `fetch.py` and `live.js` in step until
`fetch.py` is retired.

Run locally: `python3 -I fetch.py && npx wrangler dev` (the first step builds the fallback `site/data.json`).

Secrets needed: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

Weather-model data: Open-Meteo.com (non-commercial use, CC BY 4.0). Snow depth: NRCS SNOTEL. Forecast text: NWS.
