# powmow-snow

Snow conditions page for Powder Mountain, Utah, built from free public sources
(NRCS SNOTEL, NWS, Open-Meteo, the resort's own feeds). Not affiliated with the resort or OpenSnow.

`fetch.py` pulls everything into `site/data.json` and `site/cams/`; `site/index.html` renders it.
A GitHub Actions job runs every 30 minutes and deploys `site/` to Cloudflare (Workers static assets).
All arithmetic happens in `fetch.py`, not in the page.

Run locally: `python3 -I fetch.py && cd site && python3 -m http.server`.

Secrets needed: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

Weather-model data: Open-Meteo.com (non-commercial use, CC BY 4.0). Snow depth: NRCS SNOTEL. Forecast text: NWS.
