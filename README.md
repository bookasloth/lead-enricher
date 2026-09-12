# Lead Enricher

A local web app that turns a **Semrush "Backlink Audit" export** into an
enriched, contact-ready lead list. Drop the spreadsheet in your browser, and the
tool visits every referring website and scrapes **email, phone, social handles,
name, and company** — then shows you a sortable, best-first table you can export
to CSV or JSON.

Built for finding people who already link to your competitors (Topmate,
Calendly, Cal.com, etc.) so you can pitch them your product.

---

## Table of contents

- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [How the pipeline works](#how-the-pipeline-works)
- [The interface](#the-interface)
- [Output columns](#output-columns)
- [Status values](#status-values)
- [Configuration](#configuration)
- [How scraping works (and its limits)](#how-scraping-works-and-its-limits)
- [Data storage & resume](#data-storage--resume)
- [Architecture](#architecture)
- [API reference](#api-reference)
- [Troubleshooting](#troubleshooting)
- [Legal & etiquette](#legal--etiquette)

---

## What it does

1. You export **referring pages** from a Semrush Backlink Audit (the CSV/XLSX
   with columns like `Source url`, `Target url`, `Anchor`, `Page ascore`).
2. You drop that file onto the web page. The browser parses it (no upload of a
   huge file to the server — it's read locally with SheetJS) and auto-detects
   the **Source url** column.
3. The server **dedupes by domain**, remembers which competitor(s) each source
   links to, and classifies each source as a scrapable website or a login-walled
   social profile.
4. It **visits every website** — homepage plus `/contact`, `/about`, `/team`,
   and the footer — and extracts contact details.
5. Results stream into a **live table**, sorted best-first (rows with email +
   phone on top). Export to **CSV** or **JSON** anytime.
6. Everything is saved to a local SQLite file, so you can **stop and resume** —
   already-scraped domains are skipped on the next run.

---

## Requirements

- **Node.js ≥ 22.5** (uses the built-in `node:sqlite` — no native modules to
  compile). Check with `node -v`. This machine runs v24, which is fine.
- A modern browser (Chrome/Edge/Firefox).
- Internet access (to scrape sites and to load the SheetJS library from CDN).

**No `npm install` needed** — the app has zero runtime dependencies.

---

## Quick start

```bash
cd "D:/My Development/competitor-leads"
npm start
```

Then open **http://localhost:5178** and:

1. Drag your `.xlsx` / `.csv` onto the drop zone (or click to pick).
2. Wait for it to say `N unique sources (M to scrape)`.
3. Click **Start scraping**.
4. Watch the table fill. Click column headers to sort, type in the filter box to
   search.
5. Click **CSV** or **JSON** to download.

Kill the server (`Ctrl+C`) whenever — re-run `npm start` and click **Start
scraping** again to resume where it left off.

---

## How the pipeline works

```
 ┌─────────────┐   drop file    ┌──────────────┐   POST rows    ┌──────────────┐
 │  Semrush     │ ─────────────▶ │   Browser     │ ─────────────▶ │   Server      │
 │  .xlsx/.csv  │                │  (SheetJS      │  /api/ingest   │  (node:sqlite │
 └─────────────┘                │   parses it)   │                │   dedupes)    │
                                └──────────────┘                └──────┬───────┘
                                                                        │ Start scraping
                                        ┌───────────────────────────────▼──────────┐
                                        │  Scrape pool (30 parallel workers)         │
                                        │  homepage → /contact /about /team → footer │
                                        │  extract email / phone / socials / name    │
                                        └───────────────────────────────┬──────────┘
                                                                        │ SSE stream
 ┌──────────────┐   CSV / JSON   ┌──────────────┐   live rows    ┌──────▼───────┐
 │  leads.csv    │ ◀───────────── │   Table UI    │ ◀───────────── │  /api/progress│
 │  leads.json   │                │  (sort/filter) │                │  (EventStream)│
 └──────────────┘                └──────────────┘                └──────────────┘
```

**Step by step:**

1. **Ingest** — the browser reads the spreadsheet, finds the URL column
   (matches `source url` → `source page` → `referring page` → any `url`), and
   POSTs rows to `/api/ingest` in 5,000-row chunks.
2. **Dedupe & classify** — the server normalizes each URL, extracts the host,
   and keys it:
   - **Websites** → keyed by **domain** (so `sbl.so/` and `sbl.so/pricing`
     become one lead). The homepage `https://domain/` becomes the scrape target.
   - **Socials** (LinkedIn, Instagram, GitHub, Medium, etc.) → keyed by the full
     **profile URL** (each profile is distinct).
   - The competitor label comes from the `Target url` column (or the source URL
     as a fallback). Multiple competitors merge into a comma list.
3. **Scrape** — click **Start scraping** and 30 workers pull from the pending
   queue:
   - **Website** → fetch homepage. If no email/phone found, try `/contact`,
     `/contact-us`, `/about`, `/about-us`, `/team`, `/impressum`. The footer is
     covered automatically because the whole HTML is scanned.
   - **Scrapable social** (GitHub, Medium, YouTube) → fetch the profile page and
     extract whatever's public.
   - **Login-walled social** (LinkedIn, Instagram, Facebook, X/Twitter) → marked
     `skipped_social`, never fetched.
4. **Extract** — from each page's HTML, regexes pull emails (incl. `mailto:`),
   phones (`tel:` + free numbers), and social profile links; JSON-LD and
   `og:site_name` give the person name and company.
5. **Stream & store** — each finished row is written to SQLite and pushed to the
   browser over Server-Sent Events, updating the table and progress bar live.

---

## The interface

| Element | What it does |
|---|---|
| **Drop zone** | Drag `.xlsx`/`.csv` or click to pick. Parsed in-browser. |
| **Progress bar + counter** | `done / total` during a scrape run. |
| **Filter box** | Live full-text filter across domain, name, company, emails, phones, links-to, status. |
| **Column headers** | Click to sort; click again to reverse. |
| **Start scraping** | Begins/resumes enrichment of all `pending` rows. |
| **CSV / JSON** | Download the full result set. |
| **Reset** | Wipes all scraped data (confirm prompt). |
| **Emails / Phones cells** | Click to copy to clipboard. |
| **Domain / Socials cells** | Clickable links (open in new tab). |

The table sorts **best-first by default**: rows with an email rank above rows
with only a phone, above no-contact rows; ties break by Semrush authority score
(`ascore`).

---

## Output columns

Both the on-screen table and the CSV/JSON export use these fields. Exports lead
with the outreach-ready columns (`score`, `primary_email`, `email_tier`, `name`,
`company`, `intent`, `why`) so a CSV is usable as-is in a mail-merge:

| Column | Meaning |
|---|---|
| `score` | 0–100 lead score (see above). Sort/export order. |
| `primary_email` | The single best contact address to use. |
| `email_tier` | `personal` / `role` / `personal_free` / `role_free` / `personal_offdomain` / `none`. |
| `intent` | Derived intent, e.g. `review / comparison`, `compares 3 competitors`. |
| `why` | One-line human reason this lead is worth contacting. |
| `is_platform` | `true` if the source is an aggregator/platform (not a real prospect). |
| `source_url` | Representative page for the lead (homepage for websites). |
| `domain` | Host, `www.` stripped. |
| `type` | `website`, `github`, `medium`, `youtube`, `linkedin`, `instagram`, `facebook`, `twitter`. |
| `links_to` | Which competitor(s) this source links to, e.g. `Topmate, Calendly`. |
| `anchor` | Anchor text of the backlink (first seen), trimmed to 300 chars. |
| `ascore` | Semrush Page authority score (0–100) — higher is a stronger site. |
| `name` | Person name, from JSON-LD `Person` where available. |
| `company` | Company/brand, from JSON-LD `Organization` or `og:site_name`; falls back to the domain. |
| `title` | Page `<title>`. |
| `emails` | Comma-separated, de-duped, junk-filtered; on-domain addresses ranked first. |
| `phones` | Comma-separated, digits normalized, 8–15 digit sanity filter. |
| `socials` | JSON map, e.g. `{"linkedin":["…"],"instagram":["…"]}`. |
| `status` | See below. |

---

## Status values

| Status | Meaning |
|---|---|
| `pending` | Ingested, not yet scraped. |
| `ok` | Scraped and has at least an email or phone. |
| `no_contact` | Scraped successfully but found no email/phone (often a contact-form-only site). |
| `skipped_social` | Login-walled social profile — not fetched. The **profile URL is saved as a social** so you can work it manually. |
| `skipped_platform` | Source is an aggregator/platform root (github.com, medium.com, producthunt.com, …) — not a real prospect, so not scraped. |
| `error` | Fetch/parse failed (timeout, DNS, blocked, non-HTML). |

---

## Lead score & signals

Every row gets a **0–100 `score`** (computed on read from the scraped data — no
re-scrape needed) and the table sorts by it best-first. Score rewards, in order
of weight:

1. **Contact quality** — a *personal email on the company's own domain* beats a
   role inbox (`info@`, `sales@`), which beats a free-provider address
   (`gmail`), which beats phone-only, which beats nothing. The single best
   address is surfaced as **`primary_email`** with an **`email_tier`** badge.
2. **Intent** (from the backlink `anchor` + how many competitors it links to) —
   an "best/vs/alternative/review" anchor, or a source linking **2+
   competitors**, is a comparison shopper and scores higher. Shown as `intent`.
3. **Authority** — Semrush `ascore` (capped contribution).
4. **A named person** and **public socials** add a little.
5. **Platform/aggregator roots are crushed** (×0.15) so directories never
   outrank real businesses.

The **`why`** column spells out the reason in one line, e.g.
`personal email on own domain · DA 65 · review / comparison`. Tick **hide
low-value** in the header to drop platforms, no-contact, and sub-20 rows.

---

## Configuration

Edit the constants at the top of [`server.mjs`](server.mjs):

| Constant | Default | What it controls |
|---|---|---|
| `PORT` | `5178` | Server port. |
| `CONCURRENCY` | `30` | Parallel scrape workers. Raise for speed, lower to be gentler. |
| `REQ_DELAY` | `150` | ms jitter between a worker's fallback-page requests. |
| `TIMEOUT_MS` | `12000` | Per-request timeout. |
| `MAX_HTML` | `1_500_000` | Max bytes read per page (guards against huge pages). |
| `CONTACT_PATHS` | `/contact`, `/about`, `/team`, … | Fallback pages tried when the homepage has no contact. |
| `COMPETITORS` | Topmate, Calendly, Cal.com, … | Domain → label map. **Add your competitors here.** |
| `SKIP_HOSTS` | linkedin, instagram, facebook, twitter/x | Hosts never scraped. |
| `JUNK` | asset/CDN/placeholder patterns | Email substrings that get filtered out. |

To scrape a **different competitor set**, just add domains to `COMPETITORS`. The
tool doesn't require any competitor to be listed — unlisted targets are labeled
`unknown` but still processed.

---

## How scraping works (and its limits)

- **Websites are the goldmine.** Emails and phones scrape reliably from company
  homepages, contact pages, and footers.
- **Login-walled socials yield nothing** and actively block bots, so LinkedIn,
  Instagram, Facebook, and X are flagged `skipped_social` rather than wasting
  requests. Work them by hand, or plug in a paid actor (e.g. Apify) later.
- **GitHub / Medium / YouTube** are fetched for whatever is public (a profile
  bio, linked socials), but rarely expose a direct email.
- **Realistic yield:** expect **~20–40%** of website sources to give a usable
  email. Many sites only offer a contact form (those land as `no_contact`).
- **Blocking:** at balanced concurrency most sites respond fine; some will
  timeout or block and land as `error`. That's normal at this scale.

The scraper reads raw HTML — it does **not** run JavaScript. Contacts injected
by client-side JS won't be seen. (A headless-browser mode could be added later
if that becomes a bottleneck.)

---

## Data storage & resume

- All state lives in **`leads.db`** (SQLite, WAL mode) beside `server.mjs`, with
  `leads.db-wal` / `leads.db-shm` sidecar files.
- One table, `sources`, keyed by domain (websites) or profile URL (socials).
- **Resume:** only `pending` rows are scraped, so stopping and restarting never
  re-scrapes finished domains. Ingesting the same file twice is safe (existing
  keys merge their `links_to` instead of duplicating).
- **Reset:** the **Reset** button (or `POST /api/reset`) clears the table. To
  wipe completely, stop the server and delete `leads.db*`.

---

## Architecture

```
competitor-leads/
├── server.mjs          # HTTP server + scraper + SQLite. The whole backend.
├── public/
│   └── index.html      # Single-page UI (drop zone, table, SSE client).
├── package.json        # Zero deps; "npm start" → node server.mjs
├── test-signals.mjs    # Self-check for the lead-scoring logic (node test-signals.mjs).
├── leads.db*           # SQLite data (created on first run).
└── README.md
```

- **Backend** — one file, Node's built-in `http` + `node:sqlite` + global
  `fetch`. No Express, no ORM, no build step.
- **Frontend** — one HTML file, vanilla JS, SheetJS from CDN for spreadsheet
  parsing. Communicates via `fetch` + one `EventSource`.
- **Why the browser parses the spreadsheet:** it keeps a 30k-row XLSX off the
  wire and out of the server, so the server needs no xlsx or multipart libraries.

---

## API reference

The UI uses these; you can also script against them.

| Method & path | Body / query | Returns |
|---|---|---|
| `GET /` | — | The web app. |
| `POST /api/ingest` | `{ rows: [{source_url, target_url, anchor, ascore}] }` | `{ added, total, pending }` |
| `POST /api/start` | — | `{ running: true }` — begins/resumes scraping. |
| `GET /api/rows` | — | `{ rows: [...], running }` — full current table. |
| `GET /api/progress` | — | **SSE stream**: `{type:'start'|'row'|'done', done, total, row}`. |
| `GET /api/export.csv` | — | CSV download. |
| `GET /api/export.json` | — | JSON download. |
| `POST /api/reset` | — | Wipes all rows. |

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `node:sqlite` error on start | Node too old. Need ≥ 22.5; run `node -v`. |
| Drop zone does nothing | SheetJS blocked (no internet / CSP). Check the browser console. |
| Every row is `error` | Network/firewall blocking outbound requests, or offline. |
| Everything `no_contact` | Sites use contact forms or JS-rendered contacts (not scrapable here). |
| Scrape feels slow | Raise `CONCURRENCY` in `server.mjs` (watch for more `error`s/blocks). |
| Port already in use | Change `PORT` in `server.mjs`. |
| Want a fresh start | **Reset** button, or stop server and delete `leads.db*`. |

---

## Legal & etiquette

Cold outreach to scraped contacts is generally fine for **B2B in India**, but
**EU/US** contacts fall under **GDPR / CAN-SPAM**. Bulk cold mail can also burn
your sending domain's reputation. Warm up your domain, keep volumes sane, honor
opt-outs, and only contact businesses where there's a genuine fit.
