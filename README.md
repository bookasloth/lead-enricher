# Lead Enricher

A **local, single-machine web app** for building contact-ready lead lists. It has two independent modes:

1. **Google Maps mode** — systematically sweep a city for a business category (dentists, lawyers, gyms, anything) across a **City × Area × Query** matrix, deduplicate to one row per business, enrich each with website/email/social signals, score it, and export CSV/JSON. Backed by the open-source [`gosom/google-maps-scraper`](https://github.com/gosom/google-maps-scraper) running in **Docker**.
2. **Backlink mode** — drop a Semrush "Backlink Audit" export and the tool visits each referring site and scrapes email/phone/socials/name/company. Built for finding people who already link to your competitors.

Everything runs on your own PC. No accounts, no API keys, no data leaves your machine except the scraper's own requests to public pages.

---

## Table of contents

- [What you get](#what-you-get)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Google Maps mode](#google-maps-mode)
  - [How the search matrix works](#how-the-search-matrix-works)
  - [Running a job (UI)](#running-a-job-ui)
  - [Running a job (API)](#running-a-job-api)
  - [Output columns](#output-columns)
  - [Deduplication](#deduplication)
  - [Enrichment flags](#enrichment-flags)
  - [Scoring](#scoring)
- [Performance & load tuning](#performance--load-tuning)
- [Backlink mode](#backlink-mode)
- [Architecture](#architecture)
- [API reference](#api-reference)
- [Data storage & resume](#data-storage--resume)
- [Troubleshooting](#troubleshooting)
- [Tests](#tests)
- [Legal & etiquette](#legal--etiquette)

---

## What you get

- **Systematic geographic coverage** — not "search once", but every Area × Query cell, tracked and resumable.
- **One row per business** — six-stage dedup collapses the same shop found under many queries/areas into a single lead, while keeping a count of where it was discovered.
- **Enrichment** — visits each lead's website to confirm email, booking links, WhatsApp, and social presence.
- **Configurable scoring** — weighted score with human-readable reasons, tuned in a JSON file.
- **Coverage report** — per-area counts, totals, duplicates removed, error count.
- **CSV / JSON export** — a clean sales view, or the full raw record.
- **Resume** — kill it, reboot, restart the job; it picks up exactly where it stopped.

---

## Requirements

| Need | Why | Notes |
|---|---|---|
| **Node.js ≥ 22.5** | runs the app; uses the built-in `node:sqlite` | no `npm install` needed — zero runtime deps |
| **Docker** | runs the Google Maps scraper | Docker Desktop on Windows/Mac, or Docker Engine on Linux. **Only needed for Google Maps mode.** |

Check versions:

```bash
node --version   # v22.5.0 or higher
docker --version
```

The app has **no npm dependencies** — it uses Node's standard library only (including the experimental `node:sqlite`). Cloning and running is enough.

---

## Quick start

```bash
git clone <your-repo-url> lead-enricher
cd lead-enricher

# 1. Pull the Google Maps scraper image (one time, ~few hundred MB)
docker pull gosom/google-maps-scraper

# 2. Start the app
node server.mjs
```

Open **http://localhost:5178** in your browser.

Pick a **Source** at the top:
- **Google Maps** → the matrix UI (city, areas, queries, cap).
- **Backlink** → the Semrush upload UI.

To start the scraper without Docker Desktop's GUI, just make sure the Docker daemon is running (`docker ps` should work).

---

## Google Maps mode

### How the search matrix works

You give three things:

- **City** — e.g. `Nagpur`
- **Areas** — a list of neighbourhoods, e.g. `Dharampeth`, `Sadar`, `Civil Lines`…
- **Queries** — search terms for one category, e.g. `Dentist`, `Dental clinic`, `Orthodontist`…

The app builds one **cell** per `Area × Query` pair and runs each as a gosom search like `Dentist in Dharampeth, Nagpur`. So **40 areas × 12 queries = 480 cells**. Each cell returns up to **cap** businesses (default 60; 30 is a good lean setting).

Every cell's status (`pending` / `ok` / `error`) is stored, which is what makes a job **resumable** — restarting skips completed cells.

> The tool is **category-agnostic**. Nothing is hardcoded to any industry — you supply the queries.

### Running a job (UI)

1. Source → **Google Maps**.
2. Fill **City**, paste **Areas** (one per line) and **Queries** (one per line), set **cap**.
3. **Start**. The progress panel shows cells done / total, unique leads, duplicates, errors — live over SSE.
4. When done (or mid-run), **Export CSV / JSON**, or **XLSX** (built in-browser).
5. **Resume Last** re-attaches to the newest job and continues it.

### Running a job (API)

```bash
# Create a job -> returns { "job_id": N, "total_cells": M }
curl -s -X POST http://localhost:5178/api/gmaps/jobs \
  -H 'content-type: application/json' \
  -d '{
    "city": "Nagpur",
    "areas": ["Dharampeth","Sadar","Civil Lines"],
    "queries": ["Dentist","Dental clinic","Orthodontist"],
    "cap": 30
  }'

# Start it
curl -X POST http://localhost:5178/api/gmaps/jobs/1/start

# Poll status + coverage
curl -s http://localhost:5178/api/gmaps/jobs/1

# Export
curl -s "http://localhost:5178/api/gmaps/export.csv?job_id=1" -o leads.csv
curl -s "http://localhost:5178/api/gmaps/export.csv?job_id=1&raw=1" -o leads_raw.csv
```

### Output columns

The default **sales export** (`export.csv`):

`name, category, locality, address, phone, whatsapp, email, website, booking_link, rating, review_count, has_website, has_phone, has_email, has_social, has_booking, has_whatsapp, branch_count, score, score_reasons, maps_url, found_count`

Add **`&raw=1`** for the full record (adds `place_id, cid, lat, lng, hours_json, services_json, socials_json, areas_json, queries_json, job_id, enrich_status, status, first_seen, last_seen`).

Key columns:
- **found_count** — how many cells surfaced this business (popularity signal).
- **branch_count** — detected multi-location businesses.
- **has_\*** — `YES` / `NO` / `UNKNOWN`. `UNKNOWN` means no evidence either way (never a false `NO`).
- **score_reasons** — plain-text list of what earned the score.

### Deduplication

One business = one row. A new result is matched against existing leads in this order, first hit wins:

1. `place_id` → 2. `cid` → 3. Maps URL → 4. phone → 5. website host → 6. fuzzy `name + locality` (Levenshtein ratio ≥ 0.9).

On a match it **merges**: bumps `found_count`, records the extra area/query, and backfills any field that was empty. Discovery attribution is kept, so you still see everywhere the business showed up.

### Enrichment flags

After dedup, each lead's website (if any) is fetched once to derive:
- `has_website`, `has_phone`, `has_email`, `has_social`, `has_booking`, `has_whatsapp`.

Booking is detected from known booking hosts; WhatsApp from `wa.me` links. Enrichment is idempotent across cells and resumes.

### Scoring

`gmaps-scoring.json` holds the weights. Defaults:

| Signal | Weight |
|---|---|
| review volume (log-scaled) | 22 |
| has website | 15 |
| has booking | 12 |
| rating | 12 |
| has email | 10 |
| multi-branch | 10 |
| has WhatsApp | 8 |
| has social | 8 |
| has phone | 6 |

Edit the JSON and restart to retune. `UNKNOWN` flags earn nothing.

---

## Performance & load tuning

Each cell spins up a headless-Chromium gosom container. Two knobs live in [`gmaps/provider.mjs`](gmaps/provider.mjs) (`dockerExec`):

- **`concurrency`** (gosom `-c`) — browser workers per container. Higher = faster per cell, more CPU/RAM.
- **`depth`** (gosom `-depth`) — how far it scrolls the results list. `2` comfortably fills a cap of 30.

Defaults are tuned for a laptop (`concurrency: 3`, `depth: 2`).

**What actually limits speed:**

| Limit | Reality |
|---|---|
| **RAM** | the real ceiling — each active container is ~1–2 GB. On 8 GB, keep to ~2 parallel jobs. Exceeding RAM is what crashes the app. |
| **Your IP** | Google rate-limits a single IP. Running 3+ parallel jobs mostly adds *errors*, not throughput. |
| CPU | rarely the bottleneck; it saturates gracefully. |

**Rules of thumb:**
- 8 GB RAM → **2 parallel jobs** max.
- Want more parallelism without throttling → you'd need rotating proxies (gosom supports `-proxies`; not wired into the UI here).
- Roughly **~4–5 cells/min** combined at 2 parallel on a home connection.

Run jobs **sequentially or 2-at-a-time**, not more.

---

## Backlink mode

Drop a Semrush **Backlink Audit** CSV export in the browser. The tool visits each referring domain and scrapes email / phone / socials / name / company, then shows a sortable best-first table with the same CSV/JSON export. No Docker needed for this mode — it's plain HTTP fetches. See the in-app UI; behaviour is unchanged from v1.

---

## Architecture

```
server.mjs            HTTP + SSE server (port 5178), routes, job control
public/index.html     single-page UI for both modes
gmaps-scoring.json    scoring weights (edit + restart to retune)

gmaps/
  db.mjs        SQLite schema (jobs / searches / gmaps_leads) + prepared statements
  provider.mjs  gosom-in-Docker provider: build query line, spawn container, map output
  dedup.mjs     six-stage dedup + merge
  enrich.mjs    website fetch -> YES/NO/UNKNOWN flags
  scoring.mjs   weighted score + reasons
  runner.mjs    orchestrates a job cell-by-cell; resumable; injectable deps
  export.mjs    CSV/JSON, sales vs raw columns
  fixtures/     sample gosom output for tests

test/           node --test unit tests for every gmaps module
```

- **Storage**: a single `leads.db` SQLite file (via `node:sqlite`).
- **Provider is swappable**: `runner` depends on an injected `runCell`, so tests never touch Docker.
- **Docker is spawned via Node `spawn`** (no shell) — avoids Git-Bash path mangling on Windows.

---

## API reference

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/gmaps/jobs` | create job `{city, areas[], queries[], cap}` → `{job_id, total_cells}` |
| POST | `/api/gmaps/jobs/:id/start` | start / resume |
| POST | `/api/gmaps/jobs/:id/stop` | graceful stop (finishes current cell) |
| GET | `/api/gmaps/jobs` | list jobs |
| GET | `/api/gmaps/jobs/:id` | job status + coverage report |
| GET | `/api/gmaps/leads?job_id=N` | leads for a job |
| GET | `/api/gmaps/export.csv?job_id=N[&raw=1]` | CSV export |
| GET | `/api/gmaps/export.json?job_id=N[&raw=1]` | JSON export |

Progress streams over SSE (`gmaps_progress`, `gmaps_done`, `gmaps_error`).

---

## Data storage & resume

- Everything persists in **`leads.db`** (gitignored — it holds real people's contact data).
- Each cell's status is recorded, so a job is fully **resumable**: `POST /jobs/:id/start` again after any interruption and it skips finished cells.
- Ingest, enrich and score are **idempotent** — re-running a cell can't double-count a business.

---

## Troubleshooting

**Stuck / leaked containers.** gosom occasionally keeps a container alive after finishing. The provider auto-kills it (stable-file-size poll + timeout), but if load spikes, list and clean up manually:

```bash
docker ps --filter name=gmaps- --format '{{.Names}} {{.CreatedAt}}'
# kill anything older than ~10 min:
docker ps -q --filter name=gmaps- | xargs -r docker kill
```

On Windows Git Bash, prefix docker commands that mount paths with `MSYS_NO_PATHCONV=1`.

**App crashes under heavy load** (`STATUS_STACK_BUFFER_OVERRUN` / `0xC0000409` on Windows). You exceeded RAM with too many parallel containers. `node:sqlite` is a single connection and doesn't like heavy concurrent load. Fix: run ≤ 2 parallel jobs, then restart the server and `POST /jobs/:id/start` to resume — no data is lost.

**"docker: command not found" / daemon not running.** Start Docker Desktop (or `sudo systemctl start docker`). Verify with `docker ps`.

**A job seems stalled.** Check `docker ps` — if a container has run for minutes, kill it; the runner will record the cell as an error and move on.

---

## Tests

```bash
npm test        # node --test (all gmaps modules) + signal tests
```

Tests use in-memory SQLite (`:memory:`) and fixture gosom output — **no Docker required to run the test suite**.

---

## Timewheel Internet track

A second, parallel scoring track for **Timewheel Internet** (web/SEO/AEO/GEO/social agency) that runs alongside the existing Book A Sloth score — same leads, same `leads.db`, additive `tw_*` columns. It never touches `grade.mjs` or the original score.

**What it scores** — the *digital gap*: does the business have a website at all, is it dead/unreachable, does it have SSL, is it mobile-friendly, thin/weak on-page SEO, missing schema markup, AI crawlers blocked (`robots.txt`), no answer-shaped content (AEO), no `llms.txt`/sitemap (GEO), and no social presence. Cheap checks (site fetch + HTML parse) run on every lead; a deeper GEO pass (citability + brand-mention search) runs only on A/B-graded leads to keep it fast.

**Backfill existing leads** — after pulling this branch, regrade everything already in `leads.db`:

```bash
node gmaps/regrade-timewheel.mjs
```

Prints `Timewheel regrade: { audited, graded, deep }` when done. Safe to re-run; it's a pure recompute over existing rows, no new scraping.

**Scrape new verticals** — `timewheel-verticals.json` has the Nagpur City × Area × Vertical query set (restaurants, fitness, real estate, hotels, salons/spas, clinics, coaching, events, interiors, auto, jewellers, retail). Feed it to the existing job endpoint the same way as any Google Maps job:

```bash
curl -X POST http://localhost:PORT/api/gmaps/jobs -H "Content-Type: application/json" -d @timewheel-verticals.json
```

The runner auto-populates the `tw_*` columns (score, grade, priority, gap list, pitch) for every lead it discovers — no separate step needed.

**Dashboard** — the product dropdown (`#fProduct`) toggles the whole leads view between Book A Sloth and Timewheel: switching to `timewheel` swaps the table columns to the `tw_*` fields and the gap filter, without affecting the other product's data.

**Export** — `GET /api/gmaps/tw-export.csv` exports the Timewheel view (same query params as the regular `/api/gmaps/export.csv`); the dashboard's Export button follows whichever product is selected.

**Later seams (documented, not wired to a live call yet):**
- `ANTHROPIC_API_KEY` — enables `draftEmail` in `gmaps/pitch.mjs` to generate a live outreach email from `tw_pitch`; without it, `draftEmail` returns a stub.
- `SEARCH_API_KEY` — enables `brandMentions` in `gmaps/geo-deep.mjs` to run a real citation/mention search; without it, it returns `{ status: 'skipped', note: 'no SEARCH_API_KEY' }`.
- `PSI_API_KEY` — gates a PageSpeed Insights call for A-grade leads (stored in the existing `psi_json` column); not called until this key is set.

---

## Legal & etiquette

- Uses the OSS `gosom/google-maps-scraper`, which drives a real headless browser over **public** Google Maps pages. It does **not** bypass CAPTCHAs, logins, or paywalls, and this app won't scrape `maps.google.com` directly.
- Scrapes **business** listing data (name, address, phone, website, rating) — not private personal data.
- You are responsible for how you use the output. Respect Google's Terms, local data-protection law (GDPR/DPDP/etc.), and anti-spam rules (CAN-SPAM, etc.) before contacting anyone.
- Rate-limit yourself. Hammering from one IP gets you throttled and is rude. Keep parallelism low.

This is a tool for legitimate B2B prospecting. Don't use it to harvest personal data or spam.
