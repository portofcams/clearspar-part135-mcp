# Clearspar Part 135 MCP

An [MCP](https://modelcontextprotocol.io) server that turns Claude into a **US Part 135 market analyst** over my live Clearspar FAA operator dataset — **1,890 active Part 135 charter certificate holders** scraped from the official FAA xlsx (fleet size derived from tail counts, state-mapped).

It wraps my real, key-gated endpoint `GET /api/prospects` on `clearspar.binnacleai.com`. The tools **compute** — concentration ratios, HHI, fleet distributions, rankings — they don't just dump rows. Ask "How concentrated is Alaska's Part 135 charter market?" and Claude pulls all 303 Alaska operators live and answers with real math.

This is a thin analyst layer over my own production data — not a public FAA API. It's read-only and key-gated.

## What it is (honest scope)

The dataset reliably populates three dimensions: **operator name**, **state** (2-letter USPS), and **fleetSize** (FAA tail count), plus a **crmStatus** pipeline field. Every tool here is built on those. Sparse/empty fields (email, phone, website, `style`, certificate dates, aircraft type, lat/lng) are deliberately **not** exposed as tools — see "Not built" below — so the server never fabricates a metric it can't back with data.

## Tools

| Tool | What it computes |
|------|------------------|
| `market_summary(state, topN?)` | Operator count, total tails, avg & median fleet, largest operator, top-5 tail share, HHI concentration, top operators. |
| `fleet_ranking({state?, limit?})` | Operators ranked by fleet size. State-scoped or the full ~1,890 universe. |
| `compare_operators(names[])` | Side-by-side of 2+ operators (state, fleet, certNo, CRM status); who's largest, shared state. |
| `competitive_landscape(state)` | Fleet-size distribution buckets, top-1/3/5 concentration, HHI with plain-English read, market leaders. |
| `crm_pipeline_summary({state?})` | Live counts across CRM stages (NEW/CONTACTED/REPLIED/DEMO/CLOSED/DEAD). |

### Not built (data doesn't support it)
- **Proximity / radius / "operators near X"** — there is no lat/lng, base-airport, or ICAO field. Geography is **state-level only**.
- **Operator-type segmentation (bush vs scheduled vs tour)** — the `style` field exists but is `NULL` in 100% of records.
- **Contact / email / phone outreach tools** — email, phone, and website are populated on ~0.5% of records (known enrichment gap).
- **Certificate-age / aircraft-make-model tools** — no cert-issue-date or aircraft-type field exists; only a derived `fleetSize` integer.

## Install

```bash
cd clearspar-part135-mcp
npm install
npm run build
```

## Configure

Copy `.env.example` and fill in the key:

```bash
cp .env.example .env
```

```ini
CLEARSPAR_BASE_URL=https://clearspar.binnacleai.com
CLEARSPAR_API_KEY=<the DIGEST_API_KEY value>
```

The endpoint is **key-gated** (returns `401` without a valid key — that gate is verified). The key is the `DIGEST_API_KEY` env var on the `takeoff-app` Docker container (host `144.202.116.229`):

```bash
# retrieve without printing it into history/logs
docker exec takeoff-app printenv DIGEST_API_KEY
```

`CLEARSPAR_API_KEY` is **required** — the server refuses to call the API without it.

## Claude Desktop config

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "clearspar-part135": {
      "command": "node",
      "args": ["/Users/johnthomasair/code/clearspar-part135-mcp/build/index.js"],
      "env": {
        "CLEARSPAR_BASE_URL": "https://clearspar.binnacleai.com",
        "CLEARSPAR_API_KEY": "<the DIGEST_API_KEY value>"
      }
    }
  }
}
```

Restart Claude Desktop. The five tools appear under the plug icon.

## Demo prompts

- "How concentrated is Alaska's Part 135 charter market?"
- "Give me a market summary for Hawaii's Part 135 operators."
- "Rank the top 15 Part 135 operators nationwide by fleet size."
- "Compare Grant Aviation and Bering Air."
- "What's the competitive landscape in Texas — is it fragmented or dominated by a few?"
- "Where does my CRM pipeline stand for Alaska?"

## How it talks to the API

- `GET /api/prospects?state=&crmStatus=&limit=&offset=` with header `X-API-Key`.
- Response: `{ "total": <count of matching ACTIVE rows>, "rows": [ <Prospect> ] }`. The server always filters `status: 'ACTIVE'`.
- **`limit` is hard-capped at 500 server-side.** Any tool needing full coverage paginates by `offset` until it has all `total` rows, and caches the ~1,890-row universe for the process lifetime (the data only changes when the FAA scraper re-runs).
- There is **no** free-text search param, so `compare_operators` matches names client-side.
- Read-only: only `GET` is ever called (the route also has `POST`/`PATCH`, which this server never uses).

## Live data sanity (as of build)

`total = 1890` active operators · `AK = 303` · `HI = 28` · all `certType = "135"` · all `crmStatus = "NEW"`. Verified against the live endpoint; `fleetSize` ranges 1–386 nationwide (1–42 in AK).
