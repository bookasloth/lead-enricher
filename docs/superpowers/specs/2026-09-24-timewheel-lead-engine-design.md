# Timewheel Internet — Lead Engine Design

**Date:** 2026-09-24
**Status:** Approved design, pending implementation plan
**Author:** brainstorming session (Timewheel pivot)

## Context

The existing pipeline (`gmaps/` + `leads.db` + `server.mjs`) scrapes Google Maps
local businesses, enriches contact/website flags, scores, grades, exports, and
serves an admin dashboard. It was tuned for **Book A Sloth** (an appointment /
booking-automation product) via `gmaps/grade.mjs` `DEFAULT_PROFILE`. That work is
complete.

New target: **Timewheel Internet** — a web development + digital marketing / SEO /
social content agency. Their ideal prospect is the **inverse** of Book A Sloth's:
a real, cash-generating local business that is **weak or absent online** and
**invisible to AI answer engines**. Big digital gap + can-pay + reachable = hot
lead.

## Goal

Produce graded, pitch-ready Timewheel leads from Nagpur local businesses,
covering three sales fronts:

1. **SEO / web** — no/dead/insecure/non-mobile site, weak on-page SEO.
2. **AEO / GEO** — invisible to AI engines (ChatGPT, Perplexity, Gemini, Google
   AI Overviews): no schema, AI crawlers blocked, no `llms.txt`, no answerable
   content, weak entity/citations.
3. **Social** — no or thin social presence.

Deliverables: graded CSVs with per-lead gaps + a pitch line, a Timewheel admin
view, and a seam for Claude-API-generated pitch emails (wired later).

## Non-Goals

- Removing or altering the Book A Sloth track (kept intact, runs in parallel).
- Widening geography beyond Nagpur (later).
- Sending any outreach automatically.
- Building the Claude-API email generator now — only the seam.

## Approach: parallel track, maximum reuse

Reuse the whole scrape → dedup → enrich → export → dashboard scaffolding
unchanged. Add only Timewheel-specific modules and **parallel `tw_*` columns** on
`gmaps_leads`, so both products coexist over one row set. Book A Sloth grade
columns are untouched.

Rejected alternative: generalizing `gmaps/grade.mjs` to a single profile-driven
grader. Its dimensions are genuinely different from Timewheel's (appointment_fit
vs. digital-gap), so branching inside one grader would tangle two products. A
separate grader is cleaner and safe.

## Components

### 1. `gmaps/audit.mjs` — site + GEO/AEO quality probe

For each lead **with a website**, fetch HTML (reuse `server.mjs` `fetchText`) and
detect, emitting a structured `audit_json`. Flags are `YES | NO | UNKNOWN`; never
assert `NO` without evidence (fetch fail / no site => `UNKNOWN`).

**Web / SEO block:**
- `dead` / parked (fetch fail, parked-domain markers, tiny body)
- `no_ssl` (http:// or TLS failure)
- `not_mobile` (no `<meta name=viewport>`)
- `no_seo` (missing `<title>` / meta description / `<h1>`)
- `thin` (body text below a threshold)
- `no_analytics` (no GA / GTM / pixel)
- `platform` (wix / wordpress / squarespace / none — sniffed)

**GEO / AEO block (`geo`):**
- `no_schema` (no `LocalBusiness` / `Organization` / `Product` / `FAQ` JSON-LD)
- `ai_crawlers_blocked` (robots.txt blocks `GPTBot`, `ClaudeBot`, `PerplexityBot`,
  `Google-Extended`, or robots.txt absent)
- `no_llms_txt` (`/llms.txt` 404)
- `no_answer_content` (no FAQ / service pages to quote)
- `no_sitemap` (`/sitemap.xml` 404)

No-website leads: gap is maximal on every axis (they need everything).

**Deep tier — PSI (A-grade only):** PageSpeed Insights API (one HTTP call, no
headless install), gated behind `PSI_API_KEY`. Stores `psi_json`. Skipped
silently if no key.

New columns: `audit_json`, `psi_json`, `audit_status` (`pending|ok|error|skipped`).

### 2. Deep GEO tier — reuse existing geo skills (A + B grades)

For grade **A and B** leads (mid tier — enough convincing data per prospect),
run the repo's GEO skills — `geo-citability` (how quotable/citable the page is)
and `geo-brand-mentions` (why AI doesn't *know* the entity: weak web
citations) — via their subagents. Store the distilled result in `geo_json`.
This is the ammo for the pitch. Cheap GEO signals (from §1) run on **all** leads.

### 3. `gmaps/grade-timewheel.mjs` — opportunity grader

Pure, injectable, profile-driven (weights in `timewheel-scoring.json`).
Dimensions:

| Dimension | Rewards |
|-----------|---------|
| `business_value` | review volume + rating + multi-branch (can pay, real business) |
| `web_gap` | no / dead / insecure site |
| `mobile_seo_gap` | not mobile, weak on-page SEO, thin |
| `geo_aeo_gap` | no schema, AI crawlers blocked, no llms.txt, no answer content |
| `social_gap` | no / thin social presence |
| `contactability` | phone / email / whatsapp (needed to pitch) |

Emits, persisted to parallel columns:
- `tw_score` (0–100 opportunity), `tw_grade` (A/B/C/D), `tw_priority` (P1/P2/P3)
- `tw_gap_json` (which gaps fired, ranked)
- `tw_pitch` — auto one-liner across SEO + AEO + GEO, e.g.
  *"450 reviews, 4.6★ — but no website, blocked to AI crawlers, zero schema.
  Invisible on Google and ChatGPT."*

High business_value + large gaps + reachable => A / P1.

### 4. `gmaps/regrade-timewheel.mjs` — CLI

Iterate all existing `gmaps_leads`: run audit (if website + not audited) + tw
grade, persist. Idempotent. Produces Timewheel results **today** on everything
already scraped. Deep GEO for the A/B leads it produces.

### 5. New verticals (fresh scrape, Nagpur)

Businesses that buy web/SEO/social/GEO, wired as jobs via the existing runner:
restaurants/cafes, gyms/fitness, real estate, hotels, salons/spas, clinics,
coaching/institutes, wedding/events, interiors/architects, auto dealers,
jewellers, retail/boutiques. Query lists added to config; scrape uses the
unchanged provider/runner/dedup path, then audit + tw-grade.

### 6. Export + dashboard + pitch seam

- **`gmaps/export.mjs`** (extend): `tw_grade` A/B/C/D CSVs with gaps + `tw_pitch`.
- **`server.mjs`** (extend): Timewheel admin view — product toggle, show
  tw_score / gaps / pitch, filter by gap type (e.g. "no website", "AI-blocked").
- **`gmaps/pitch.mjs`** (new, seam only): builds the Claude-API request from
  `audit_json` + `geo_json` + lead to draft a pitch email. Gated behind an API
  key env var; returns a stub/placeholder until the key is added.

## Data flow

```
scrape (runner) -> dedup -> enrich (existing flags)
   -> audit (new: web + GEO/AEO signals; PSI on A-grade)
   -> tw-grade (new)
   -> [deep GEO on A/B grades] -> export / dashboard
```

`regrade-timewheel` runs audit + tw-grade (+ deep GEO on A/B) over existing rows.

## Schema changes (additive, guarded ALTERs in `gmaps/db.mjs`)

New columns on `gmaps_leads`:
`audit_json TEXT DEFAULT '{}'`, `psi_json TEXT DEFAULT '{}'`,
`geo_json TEXT DEFAULT '{}'`, `audit_status TEXT DEFAULT 'pending'`,
`tw_score INTEGER DEFAULT 0`, `tw_grade TEXT`, `tw_priority TEXT`,
`tw_gap_json TEXT DEFAULT '[]'`, `tw_pitch TEXT`.

Add matching prepared statements (`updateAudit`, `updateTwGrade`) and include the
new columns in the sync upsert so home→cloud sync carries them.

## Config

`timewheel-scoring.json` (new): dimension weights + thresholds (thin-body length,
review caps, grade cutoffs), mirroring `gmaps-scoring.json`'s load-with-defaults
pattern.

## Error handling

- Audit fetch failures => `audit_status='error'`, flags stay `UNKNOWN`, never
  fabricate a `NO`.
- PSI / deep GEO absent or failing => skip that lead's deep data, grade proceeds
  on cheap signals; never block the pipeline.
- All new modules pure + injectable (deps passed in) so tests need no network.

## Testing

- `audit.mjs`: HTML fixtures in `gmaps/fixtures/` — mobile vs. not, seo vs. not,
  schema vs. not, dead/parked, robots.txt allow vs. block. Assert each flag.
- `grade-timewheel.mjs`: table test — rich business + no website => A / P1;
  poor business + good site => low grade; unknowns never penalize.
- Keep the existing gmaps parity/test suite green (Book A Sloth untouched).

## Open items (later, out of scope now)

- Claude-API pitch email generation (seam built now, key + prompt later).
- Widening beyond Nagpur.
- Automated outreach.
