# Suffix Atlas

Find the websites that share a word: `google.com`, `google.org`, `google.co.uk`, and every other public suffix where the name resolves. Each scan then tests the HTTP response and separates direct answers from redirects.

Live: <https://domain-finder.ennio.vip/>

Source: <https://github.com/EnnioMrk/suffix-atlas>

## Run

```sh
npm start
```

Open <http://127.0.0.1:8788/>. No dependencies are required; Node 20 or newer is enough.

Dokploy builds the `Dockerfile` and runs the app on port 8788. The public route is `domain-finder.ennio.vip`. The OpenChamber preview path remains available for local review: static files come from `public/`, and `/preview/tld-atlas/api/*` is forwarded to the scanner on port 8788. `start-api.sh` starts that local scanner.

## What a scan does

1. Reads the IANA root-zone list (1,436 TLDs, cached in `data/tlds.json`).
2. Adds 464 common multi-level suffixes such as `co.uk`, `com.au`, `co.jp`, and `com.br`. Total: 1,900 candidate names per word.
3. Resolves each candidate with DNS. Names without a public IPv4 address are skipped.
4. Sends one HTTPS `GET` to each resolved apex name without following redirects. If HTTPS does not complete, it tries HTTP once.
5. Classifies the answer:
   - **Direct**: HTTPS 2xx, no redirect.
   - **Live after redirect**: a same-site redirect (usually apex to `www`) ends at 2xx.
   - **Redirects away**: the first redirect leaves the site.
   - **HTTP only**: no HTTPS, but HTTP answers 2xx.
   - **Blocked / Not found / No answer**: the server responded with 401/403/429, 404/410, 5xx, or not at all.
6. Returns the results as JSON. The browser polls the job and draws the suffix field from real progress.

The scan does not search page content and does not enumerate subdomains. It tests one name per suffix. Results are live, held in memory, and not saved.

## API

- `GET /api/meta` — index size and source.
- `POST /api/search` with `{"term":"google"}` — starts a job.
- `GET /api/search/:id` — job state, progress, and results when complete.
- `GET /api/health` — service health.

## Notes

- The scanner blocks private and reserved IP addresses before making an HTTP request.
- Redirect following is limited to the same site, at most four hops.
- Each scan uses up to 90 DNS workers and 42 HTTP workers. A scan usually takes 10–20 seconds.
- The frontend uses Work Sans and IBM Plex Mono, self-hosted in `public/fonts/`.
