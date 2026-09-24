# Taking Leadforge online

**Architecture:** the app (browse / CRM / export) runs on Render. Scraping stays on
your home machine (residential IP, avoids Google blocks) and pushes results up.

```
  home PC  ──scrape (Docker)──► local leads.db ──node sync.mjs──►  Render app  ──►  you + team (any device)
```

---

## 1. Deploy the app to Render (~10 min)

1. Push this repo to GitHub (already done).
2. Render dashboard → **New → Blueprint** → pick this repo. It reads `render.yaml`.
3. On the create screen:
   - **APP_PASSWORD** — type a password you'll use to log in. (Not auto-set.)
   - **SYNC_TOKEN** — leave it; Render generates one. After deploy, open the service
     → Environment → copy its value (needed in step 2).
4. Click **Apply**. First deploy takes ~2 min. You get a URL like
   `https://leadforge.onrender.com`. Open it → login page → your password.

**Plan note:** `render.yaml` uses `plan: starter` (~$7/mo) so the disk survives redeploys.
On **free** tier: remove the `disk:` block — the app still runs and your home `sync.mjs`
re-populates leads on every run, but CRM edits made online are lost if the free instance
spins down. Fine for read-only; use starter once you (or a teammate) edit outreach state.

---

## 2. Point the home scraper at it (~2 min)

On the machine that scrapes, create `sync.config.json` next to `sync.mjs`:

```json
{ "url": "https://leadforge.onrender.com", "token": "<the SYNC_TOKEN from Render>" }
```

Then push your existing leads up:

```bash
node sync.mjs
```

It streams all leads + job history to the cloud. Re-run anytime — it's idempotent and
never overwrites outreach status / notes you edited online.

---

## 3. Make it run itself (optional)

**Scrape on a schedule:** already built — the Scrape page's "Auto-schedule" fires jobs
on your home server on an interval. Keep the home server running (disable PC sleep).

**Auto-sync after each scrape:** schedule `node sync.mjs` to run every hour via Windows
Task Scheduler (Create Basic Task → Daily → repeat every 1 hour → action: `node` with
argument `sync.mjs`, start-in = this folder). Fresh leads land online without you lifting
a finger.

---

## What stays local vs online

| Piece | Where | Why |
|-------|-------|-----|
| Scraper (Docker/gosom) | Home | Residential IP — cloud IPs get Google-blocked |
| Lead DB + web UI | Render | Access from anywhere, survives PC reformats |
| CRM edits (status/notes) | Render (source of truth) | Team edits, preserved across syncs |
| Password / sync token | Render env vars | Never in the repo |
