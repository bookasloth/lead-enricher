# Timewheel Lead Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grade Nagpur local businesses as Timewheel (web/SEO/AEO/GEO/social agency) prospects by scoring their digital gap, running in parallel to the existing Book A Sloth track over the same `gmaps_leads` rows.

**Architecture:** Reuse the scrape → dedup → enrich → export → dashboard scaffolding unchanged. Add a site+GEO/AEO audit, a digital-gap grader, a deterministic pitch composer (with a Claude-API email seam), a re-grade CLI, and parallel `tw_*`/`audit_*`/`geo_*` columns. Book A Sloth's `gmaps/grade.mjs` and its columns are untouched.

**Tech Stack:** Node.js ≥22.5, ESM, `better-sqlite3` (via existing `gmaps/db.mjs`), built-in `node:test`, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-24-timewheel-lead-engine-design.md`

## Global Constraints

- Node ≥22.5, ESM (`"type":"module"`). No new npm dependencies.
- Flags are `YES | NO | UNKNOWN`. Never assert a gap without evidence: audit not run / fetch failed => the flag is `null`/`UNKNOWN` and earns **no** score and produces **no** pitch claim.
- All new logic modules are pure and dependency-injected (fetchers passed in) so tests need no network or Docker.
- Additive DB migrations only (guarded `ALTER`), matching `gmaps/db.mjs`'s existing pattern. Never touch the `sources` table or Book A Sloth grade columns.
- Tests run via `npm test` (`node --test && node test-signals.mjs`). Test files live in `test/` named `*.test.mjs`.
- Commit after every task with a `feat:`/`test:` message.

---

### Task 1: Shared fetch helper (`gmaps/fetch.mjs`)

`fetchText` currently lives inside `server.mjs` (uses module consts). The audit module and the re-grade CLI both need it outside the server. Extract it into a shared module, add a lightweight `fetchStatus` (HEAD-like GET returning the HTTP status, for `/llms.txt` and `/sitemap.xml` existence checks), and rewire `server.mjs` to import it.

**Files:**
- Create: `gmaps/fetch.mjs`
- Modify: `server.mjs:293-315` (replace local `fetchText` with import)
- Test: `test/gmaps-fetch.test.mjs`

**Interfaces:**
- Produces: `fetchText(url, opts?) -> Promise<string|null>` (HTML or null on non-ok/non-html/error), `fetchStatus(url, opts?) -> Promise<number>` (HTTP status, or 0 on error). `opts` = `{ timeoutMs?, ua?, maxHtml?, accept? }`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/gmaps-fetch.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { fetchText, fetchStatus } from '../gmaps/fetch.mjs';

test('fetchText returns null on abort/error', async () => {
  const r = await fetchText('http://127.0.0.1:1/nope', { timeoutMs: 50 });
  assert.equal(r, null);
});

test('fetchStatus returns 0 on error', async () => {
  const s = await fetchStatus('http://127.0.0.1:1/nope', { timeoutMs: 50 });
  assert.equal(s, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/gmaps-fetch.test.mjs`
Expected: FAIL — cannot find module `../gmaps/fetch.mjs`.

- [ ] **Step 3: Write the implementation**

```javascript
// gmaps/fetch.mjs — shared HTTP helpers for the Google Maps enrichment/audit path.
// Extracted from server.mjs so the audit module and CLIs can fetch without booting
// the server. Returns null/0 on any failure; callers must treat that as UNKNOWN.

const DEF = { timeoutMs: 12000, ua: 'Mozilla/5.0 (compatible; LeadBot/1.0)',
  maxHtml: 2_000_000, accept: 'text/html' };

export async function fetchText(url, opts = {}) {
  const { timeoutMs, ua, maxHtml, accept } = { ...DEF, ...opts };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow',
      headers: { 'User-Agent': ua, 'Accept': accept } });
    const ct = res.headers.get('content-type') || '';
    if (!res.ok || !ct.includes('text/html')) return null;
    const reader = res.body?.getReader();
    if (!reader) return await res.text();
    let received = 0, html = ''; const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      html += dec.decode(value, { stream: true });
      if (received > maxHtml) { ctrl.abort(); break; }
    }
    return html;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

// GET that returns only the HTTP status (0 on error). Used to test existence of
// /llms.txt, /sitemap.xml, /robots.txt without downloading large bodies.
export async function fetchStatus(url, opts = {}) {
  const { timeoutMs, ua } = { ...DEF, ...opts };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow',
      headers: { 'User-Agent': ua } });
    return res.status;
  } catch { return 0; }
  finally { clearTimeout(timer); }
}
```

- [ ] **Step 4: Rewire `server.mjs` to import instead of redefining**

At the top of `server.mjs` (near the other gmaps imports, ~line 18-24) add:

```javascript
import { fetchText as sharedFetchText } from './gmaps/fetch.mjs';
```

Then delete the local `async function fetchText(url) { ... }` (server.mjs:294-315) and add, where it was:

```javascript
const fetchText = (url) => sharedFetchText(url, { timeoutMs: TIMEOUT_MS, ua: UA, maxHtml: MAX_HTML });
```

(Keep the existing `TIMEOUT_MS`, `UA`, `MAX_HTML` consts — they now feed the shared helper.)

- [ ] **Step 5: Run tests to verify pass + server still parses**

Run: `node --test test/gmaps-fetch.test.mjs`
Expected: PASS.
Run: `node --check server.mjs`
Expected: no output (syntax OK).

- [ ] **Step 6: Commit**

```bash
git add gmaps/fetch.mjs test/gmaps-fetch.test.mjs server.mjs
git commit -m "feat: extract shared fetchText + fetchStatus into gmaps/fetch.mjs"
```

---

### Task 2: DB migration + statements (`gmaps/db.mjs`)

Add the parallel columns and two prepared statements. Additive and guarded, exactly like the existing STEP 3 grading migration.

**Files:**
- Modify: `gmaps/db.mjs:84-92` (add columns to the guarded-ALTER loop), `gmaps/db.mjs:107-190` (add statements + sync upsert columns)
- Test: `test/gmaps-db.test.mjs` (append)

**Interfaces:**
- Produces columns on `gmaps_leads`: `audit_json TEXT DEFAULT '{}'`, `psi_json TEXT DEFAULT '{}'`, `geo_json TEXT DEFAULT '{}'`, `audit_status TEXT DEFAULT 'pending'`, `tw_score INTEGER DEFAULT 0`, `tw_grade TEXT`, `tw_priority TEXT`, `tw_gap_json TEXT DEFAULT '[]'`, `tw_pitch TEXT`.
- Produces statements: `q.updateAudit` (params: `key, audit_json, psi_json, geo_json, audit_status`), `q.updateTwGrade` (params: `key, tw_score, tw_grade, tw_priority, tw_gap_json, tw_pitch`).

- [ ] **Step 1: Write the failing test**

```javascript
// append to test/gmaps-db.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { initGmaps } from '../gmaps/db.mjs';

test('tw columns + statements exist and round-trip', () => {
  const db = new Database(':memory:');
  const q = initGmaps(db);
  const now = Date.now();
  q.insertLead.run({ key: 'k1', job_id: 1, name: 'X', maps_url: '', place_id: 'p', cid: '',
    address: '', locality: '', lat: null, lng: null, phone: '', website: '', category: '',
    rating: null, review_count: 0, hours_json: '{}', description: '', services_json: '[]',
    doctor_name: '', socials_json: '{}', email: '', booking_link: '', whatsapp: '',
    branch_count: 1, areas_json: '{}', queries_json: '{}', found_count: 1,
    first_seen: now, last_seen: now, ts: now });
  q.updateAudit.run({ key: 'k1', audit_json: '{"web":{}}', psi_json: '{}', geo_json: '{}', audit_status: 'ok' });
  q.updateTwGrade.run({ key: 'k1', tw_score: 77, tw_grade: 'A', tw_priority: 'P1',
    tw_gap_json: '["no_website"]', tw_pitch: 'No website.' });
  const row = q.getLead.get('k1');
  assert.equal(row.audit_status, 'ok');
  assert.equal(row.tw_score, 77);
  assert.equal(row.tw_grade, 'A');
  assert.equal(row.tw_pitch, 'No website.');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/gmaps-db.test.mjs`
Expected: FAIL — `q.updateAudit` is undefined.

- [ ] **Step 3: Add the columns**

In `gmaps/db.mjs`, extend the guarded-ALTER loop (currently ends ~line 89-90) by adding these pairs to the array:

```javascript
    ['audit_json', "TEXT DEFAULT '{}'"], ['psi_json', "TEXT DEFAULT '{}'"],
    ['geo_json', "TEXT DEFAULT '{}'"], ['audit_status', "TEXT DEFAULT 'pending'"],
    ['tw_score', 'INTEGER DEFAULT 0'], ['tw_grade', 'TEXT'], ['tw_priority', 'TEXT'],
    ['tw_gap_json', "TEXT DEFAULT '[]'"], ['tw_pitch', 'TEXT'],
```

- [ ] **Step 4: Add the statements**

In the returned object (near `updateGrade`, ~line 148), add:

```javascript
    updateAudit: db.prepare(`UPDATE gmaps_leads SET
      audit_json=@audit_json, psi_json=@psi_json, geo_json=@geo_json, audit_status=@audit_status WHERE key=@key`),
    updateTwGrade: db.prepare(`UPDATE gmaps_leads SET
      tw_score=@tw_score, tw_grade=@tw_grade, tw_priority=@tw_priority,
      tw_gap_json=@tw_gap_json, tw_pitch=@tw_pitch WHERE key=@key`),
```

- [ ] **Step 5: Extend the sync upsert (carry tw fields home→cloud)**

In `syncUpsertLead` add the new columns to the INSERT column list, the `VALUES` list, and the `ON CONFLICT ... DO UPDATE SET` list:

Column list + values — append after `contacted_at`:
`,audit_json,psi_json,geo_json,audit_status,tw_score,tw_grade,tw_priority,tw_gap_json,tw_pitch`
and `,@audit_json,@psi_json,@geo_json,@audit_status,@tw_score,@tw_grade,@tw_priority,@tw_gap_json,@tw_pitch`.
DO UPDATE SET — append:
`,audit_json=@audit_json,psi_json=@psi_json,geo_json=@geo_json,audit_status=@audit_status,tw_score=@tw_score,tw_grade=@tw_grade,tw_priority=@tw_priority,tw_gap_json=@tw_gap_json,tw_pitch=@tw_pitch`.

(If the existing `sync-upsert.test.mjs` builds lead objects without these keys, better-sqlite3 will throw on missing named params. In Step 6 confirm; if it fails, default the fields in the sync source — but the upsert prepared statement itself is what this task delivers.)

- [ ] **Step 6: Run tests**

Run: `node --test test/gmaps-db.test.mjs test/sync-upsert.test.mjs`
Expected: PASS. If `sync-upsert.test.mjs` fails on missing params, add `audit_json:'{}',psi_json:'{}',geo_json:'{}',audit_status:'pending',tw_score:0,tw_grade:null,tw_priority:null,tw_gap_json:'[]',tw_pitch:null` defaults wherever that test/its source builds the upsert param object, then re-run.

- [ ] **Step 7: Commit**

```bash
git add gmaps/db.mjs test/gmaps-db.test.mjs
git commit -m "feat: add tw_* + audit/geo columns and statements to gmaps_leads"
```

---

### Task 3: Site + GEO/AEO audit (`gmaps/audit.mjs`)

Pure detectors over fetched HTML + status checks for `/robots.txt`, `/llms.txt`, `/sitemap.xml`. Emits a structured audit with `null` for anything not observed.

**Files:**
- Create: `gmaps/audit.mjs`
- Test: `test/gmaps-audit.test.mjs`

**Interfaces:**
- Consumes: `fetchText`, `fetchStatus` from Task 1 (injected as `deps`).
- Produces:
  - `auditHtml(html, siteUrl) -> { web:{...}, geo:{ no_schema } }` (pure, HTML-only signals).
  - `auditSite(lead, deps) -> Promise<{ audit_json, geo_json, audit_status }>` where `deps = { fetchText, fetchStatus }`. `audit_status` ∈ `ok|error|skipped`.
  - `web` block keys: `dead, no_ssl, not_mobile, no_seo, thin, no_analytics, platform`. `geo` block keys: `no_schema, ai_crawlers_blocked, no_llms_txt, no_answer_content, no_sitemap`. Boolean when observed, `null` when not.

- [ ] **Step 1: Write the failing test**

```javascript
// test/gmaps-audit.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { auditHtml, auditSite } from '../gmaps/audit.mjs';

const GOOD = `<!doctype html><html><head><title>Sharma Dental Nagpur</title>
  <meta name="viewport" content="width=device-width">
  <meta name="description" content="Best dental clinic">
  <script type="application/ld+json">{"@type":"LocalBusiness","name":"Sharma"}</script>
  <script src="https://www.googletagmanager.com/gtag/js"></script></head>
  <body><h1>Welcome</h1><h2>Frequently Asked Questions</h2>
  ${'<p>content paragraph with real words here.</p>'.repeat(40)}</body></html>`;

const BAD = `<html><head><title></title></head><body>hi</body></html>`;

test('auditHtml: good site => no gaps', () => {
  const a = auditHtml(GOOD, 'https://sharmadental.in');
  assert.equal(a.web.not_mobile, false);
  assert.equal(a.web.no_seo, false);
  assert.equal(a.web.thin, false);
  assert.equal(a.web.no_analytics, false);
  assert.equal(a.geo.no_schema, false);
});

test('auditHtml: bad site => gaps flagged', () => {
  const a = auditHtml(BAD, 'http://x.in');
  assert.equal(a.web.not_mobile, true);
  assert.equal(a.web.no_seo, true);
  assert.equal(a.web.thin, true);
  assert.equal(a.web.no_analytics, true);
  assert.equal(a.geo.no_schema, true);
});

test('auditSite: no website => skipped, all null', async () => {
  const r = await auditSite({ website: '' }, { fetchText: async () => null, fetchStatus: async () => 0 });
  assert.equal(r.audit_status, 'skipped');
  const a = JSON.parse(r.audit_json);
  assert.equal(a.web.not_mobile, null);
});

test('auditSite: fetch fail => error, dead=true, rest null', async () => {
  const r = await auditSite({ website: 'https://x.in' },
    { fetchText: async () => null, fetchStatus: async () => 0 });
  assert.equal(r.audit_status, 'error');
  assert.equal(JSON.parse(r.audit_json).web.dead, true);
});

test('auditSite: robots blocking GPTBot => ai_crawlers_blocked true', async () => {
  const robots = 'User-agent: GPTBot\nDisallow: /';
  const deps = {
    fetchText: async (u) => u.endsWith('robots.txt') ? robots : GOOD,
    fetchStatus: async (u) => u.endsWith('sitemap.xml') ? 200 : 404, // llms.txt 404, sitemap 200
  };
  const r = await auditSite({ website: 'https://sharmadental.in' }, deps);
  assert.equal(r.audit_status, 'ok');
  const g = JSON.parse(r.geo_json);
  assert.equal(g.ai_crawlers_blocked, true);
  assert.equal(g.no_llms_txt, true);
  assert.equal(g.no_sitemap, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/gmaps-audit.test.mjs`
Expected: FAIL — cannot find module `../gmaps/audit.mjs`.

- [ ] **Step 3: Write the implementation**

```javascript
// gmaps/audit.mjs — site + GEO/AEO quality probe. Pure HTML detectors (auditHtml)
// + orchestration (auditSite) that also checks robots.txt/llms.txt/sitemap.xml.
// Every signal is boolean when observed, null when not. Never assert a gap without
// evidence: fetch failure => dead=true, everything else null, status 'error'.

const AI_BOTS = ['GPTBot', 'ClaudeBot', 'Claude-Web', 'PerplexityBot', 'Google-Extended', 'CCBot', 'anthropic-ai'];
const THIN_CHARS = 600;

const stripText = (html) => String(html || '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function sniffPlatform(html) {
  const h = String(html || '').toLowerCase();
  if (h.includes('wix.com') || h.includes('_wix')) return 'wix';
  if (h.includes('wp-content') || h.includes('wp-includes')) return 'wordpress';
  if (h.includes('squarespace')) return 'squarespace';
  if (h.includes('cdn.shopify')) return 'shopify';
  return 'unknown';
}

function ldTypes(html) {
  const types = [];
  for (const m of String(html || '').matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1].trim());
      const arr = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const n of arr) if (n && n['@type']) types.push(String(n['@type']).toLowerCase());
    } catch { /* bad json-ld */ }
  }
  return types;
}

// Pure: signals derivable from the HTML + its URL alone.
export function auditHtml(html, siteUrl) {
  const h = String(html || '');
  const text = stripText(h);
  const hasViewport = /<meta[^>]+name=["']viewport["']/i.test(h);
  const hasTitle = /<title[^>]*>[^<]{1,}<\/title>/i.test(h);
  const hasDesc = /<meta[^>]+name=["']description["'][^>]+content=["'][^"']{1,}["']/i.test(h);
  const hasH1 = /<h1[\s>]/i.test(h);
  const hasAnalytics = /gtag\(|googletagmanager|google-analytics|gtm\.js|fbq\(|clarity\.ms/i.test(h);
  const types = ldTypes(h);
  const hasBizSchema = types.some(t => /localbusiness|organization|product|faqpage/.test(t));
  const hasFaq = types.includes('faqpage') || /frequently asked questions|<h[23][^>]*>\s*faq/i.test(h);
  const headings = (h.match(/<h[1-3][\s>]/gi) || []).length;
  return {
    web: {
      dead: false,
      no_ssl: !/^https:/i.test(siteUrl || ''),
      not_mobile: !hasViewport,
      no_seo: !(hasTitle && hasDesc && hasH1),
      thin: text.length < THIN_CHARS,
      no_analytics: !hasAnalytics,
      platform: sniffPlatform(h),
    },
    geo: {
      no_schema: !hasBizSchema,
      no_answer_content: !(hasFaq || headings >= 3),
      ai_crawlers_blocked: null, // set by auditSite from robots.txt
      no_llms_txt: null,         // set by auditSite
      no_sitemap: null,          // set by auditSite
    },
  };
}

const NULL_WEB = { dead: null, no_ssl: null, not_mobile: null, no_seo: null, thin: null, no_analytics: null, platform: null };
const NULL_GEO = { no_schema: null, no_answer_content: null, ai_crawlers_blocked: null, no_llms_txt: null, no_sitemap: null };

function robotsBlocksAI(robotsTxt) {
  if (!robotsTxt) return false; // absent robots => not blocked
  const lines = String(robotsTxt).split(/\r?\n/).map(l => l.trim());
  let uaMatch = false, blocked = false;
  for (const line of lines) {
    const ua = line.match(/^user-agent:\s*(.+)$/i);
    if (ua) { const v = ua[1].trim(); uaMatch = v === '*' || AI_BOTS.some(b => v.toLowerCase() === b.toLowerCase()); continue; }
    if (uaMatch && /^disallow:\s*\/\s*$/i.test(line)) blocked = true;
  }
  return blocked;
}

// Orchestrate all fetches. deps = { fetchText, fetchStatus }.
export async function auditSite(lead, deps) {
  const site = lead.website || '';
  if (!site) {
    return { audit_json: JSON.stringify({ web: NULL_WEB, geo: NULL_GEO }),
      geo_json: JSON.stringify(NULL_GEO), audit_status: 'skipped' };
  }
  let origin = ''; try { origin = new URL(site).origin; } catch {}
  const html = await deps.fetchText(site);
  if (!html) {
    const web = { ...NULL_WEB, dead: true, no_ssl: !/^https:/i.test(site) };
    return { audit_json: JSON.stringify({ web, geo: NULL_GEO }),
      geo_json: JSON.stringify(NULL_GEO), audit_status: 'error' };
  }
  const a = auditHtml(html, site);
  if (origin) {
    const robots = await deps.fetchText(origin + '/robots.txt');
    a.geo.ai_crawlers_blocked = robotsBlocksAI(robots);
    a.geo.no_llms_txt = (await deps.fetchStatus(origin + '/llms.txt')) !== 200;
    a.geo.no_sitemap = (await deps.fetchStatus(origin + '/sitemap.xml')) !== 200;
  }
  return { audit_json: JSON.stringify(a), geo_json: JSON.stringify(a.geo), audit_status: 'ok' };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test test/gmaps-audit.test.mjs`
Expected: PASS (all 5).

- [ ] **Step 5: Commit**

```bash
git add gmaps/audit.mjs test/gmaps-audit.test.mjs
git commit -m "feat: add site + GEO/AEO audit (gmaps/audit.mjs)"
```

---

### Task 4: Pitch composer + Claude-API email seam (`gmaps/pitch.mjs`)

`composePitch` is a pure, deterministic one-liner built from the ranked gap list — used by the grader. `draftEmail` is the async Claude-API seam: returns a stub unless a key is present.

**Files:**
- Create: `gmaps/pitch.mjs`
- Test: `test/gmaps-pitch.test.mjs`

**Interfaces:**
- Produces:
  - `composePitch(lead, gaps) -> string` where `gaps` is `string[]` from the grader (e.g. `['no_website','ai_crawlers_blocked']`). Pure.
  - `draftEmail(lead, { apiKey } = {}) -> Promise<{ status:'stub'|'ok', body:string }>`. Without `apiKey` (or `process.env.ANTHROPIC_API_KEY`) returns `{ status:'stub', body:<deterministic template> }`. The live branch is a documented seam.
- Consumed by: Task 5 (grader imports `composePitch`), Task 10 (routes may call `draftEmail`).

- [ ] **Step 1: Write the failing test**

```javascript
// test/gmaps-pitch.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { composePitch, draftEmail } from '../gmaps/pitch.mjs';

test('composePitch: value + no website + AI-blocked', () => {
  const s = composePitch({ name: 'Sharma Dental', review_count: 450, rating: 4.6 },
    ['no_website', 'ai_crawlers_blocked', 'no_schema']);
  assert.match(s, /450 reviews/);
  assert.match(s, /no website/i);
  assert.match(s, /AI/i);
});

test('composePitch: no gaps => empty', () => {
  assert.equal(composePitch({ name: 'X', review_count: 5 }, []), '');
});

test('draftEmail: no key => deterministic stub', async () => {
  const r = await draftEmail({ name: 'Sharma Dental', tw_pitch: 'No website.' }, { apiKey: '' });
  assert.equal(r.status, 'stub');
  assert.match(r.body, /Sharma Dental/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/gmaps-pitch.test.mjs`
Expected: FAIL — cannot find module `../gmaps/pitch.mjs`.

- [ ] **Step 3: Write the implementation**

```javascript
// gmaps/pitch.mjs — deterministic pitch one-liner (composePitch, used by the grader)
// + a Claude-API email seam (draftEmail). No network in composePitch. draftEmail
// returns a stub until ANTHROPIC_API_KEY is wired.

const GAP_PHRASES = {
  no_website: 'no website',
  dead_site: 'a dead/parked website',
  no_ssl: 'an insecure (no-HTTPS) site',
  not_mobile: 'a non-mobile site',
  weak_seo: 'weak on-page SEO',
  thin: 'thin content',
  no_schema: 'zero schema markup',
  ai_crawlers_blocked: 'AI crawlers blocked',
  no_llms_txt: 'no llms.txt',
  no_answer_content: 'no answerable content',
  no_sitemap: 'no sitemap',
  no_social: 'no social presence',
};
const AI_GAPS = new Set(['no_schema', 'ai_crawlers_blocked', 'no_llms_txt', 'no_answer_content']);

// Pure. Leads with the biggest proof-of-value (reviews) get the punchiest opener.
export function composePitch(lead, gaps) {
  if (!gaps || !gaps.length) return '';
  const rc = Number(lead.review_count) || 0;
  const rating = Number(lead.rating) || 0;
  const value = rc >= 25
    ? `${rc} reviews${rating ? `, ${rating}★` : ''}`
    : 'An established local business';
  const phrases = gaps.map(g => GAP_PHRASES[g]).filter(Boolean).slice(0, 3);
  const aiInvisible = gaps.some(g => AI_GAPS.has(g) || g === 'no_website');
  const tail = aiInvisible ? ' Invisible on Google and ChatGPT.' : '';
  return `${value} — but ${phrases.join(', ')}.${tail}`.trim();
}

// Seam. Live branch documented but inert until a key is provided.
export async function draftEmail(lead, { apiKey } = {}) {
  const key = apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
  const stub = `Subject: Quick note for ${lead.name}\n\n` +
    `Hi ${lead.name} team,\n\n${lead.tw_pitch || ''}\n\n` +
    `We help local businesses fix exactly this. Worth a 10-minute call?\n\n— Timewheel Internet`;
  if (!key) return { status: 'stub', body: stub };
  // ponytail: seam only. Wire the Claude API call here when the key lands:
  // POST https://api.anthropic.com/v1/messages with model 'claude-opus-4-8',
  // a prompt built from lead + audit_json + geo_json; return { status:'ok', body }.
  return { status: 'stub', body: stub };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test test/gmaps-pitch.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add gmaps/pitch.mjs test/gmaps-pitch.test.mjs
git commit -m "feat: add pitch composer + Claude-API email seam (gmaps/pitch.mjs)"
```

---

### Task 5: Timewheel grader + config (`gmaps/grade-timewheel.mjs`, `timewheel-scoring.json`)

The digital-gap grader. Consumes a lead row + parsed audit and emits the `tw_*` fields. Never scores a gap that is `null` (unobserved).

**Files:**
- Create: `gmaps/grade-timewheel.mjs`, `timewheel-scoring.json`
- Test: `test/gmaps-grade-timewheel.test.mjs`

**Interfaces:**
- Consumes: `composePitch` (Task 4); audit blocks (Task 3) passed in as parsed objects.
- Produces: `loadTwConfig(file?) -> cfg`; `gradeTimewheel(lead, audit, cfg?) -> { tw_score, tw_grade, tw_priority, tw_gap_json, tw_pitch }` where `audit = { web, geo }` (parsed `audit_json`; pass `{}` if none). `tw_gap_json` is a JSON array of gap keys (the same keys `composePitch` understands).

- [ ] **Step 1: Write `timewheel-scoring.json`**

```json
{
  "weights": {
    "business_value": 30,
    "web_gap": 18,
    "mobile_seo_gap": 14,
    "geo_aeo_gap": 18,
    "social_gap": 8,
    "contactability": 10
  },
  "reviewCap": 500,
  "ratingMinReviews": 10,
  "grades": { "A": 72, "B": 56, "C": 40 }
}
```

- [ ] **Step 2: Write the failing test**

```javascript
// test/gmaps-grade-timewheel.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { gradeTimewheel, loadTwConfig } from '../gmaps/grade-timewheel.mjs';

const cfg = loadTwConfig();

test('config loads', () => {
  assert.equal(cfg.weights.business_value, 30);
  assert.equal(cfg.grades.A, 72);
});

test('rich business, no website => A / P1 with gaps + pitch', () => {
  const lead = { name: 'Sharma Dental', review_count: 450, rating: 4.6, branch_count: 2,
    has_website: 'NO', has_phone: 'YES', has_email: 'YES', has_social: 'NO', website: '' };
  const r = gradeTimewheel(lead, {}, cfg);
  assert.equal(r.tw_grade, 'A');
  assert.equal(r.tw_priority, 'P1');
  const gaps = JSON.parse(r.tw_gap_json);
  assert.ok(gaps.includes('no_website'));
  assert.match(r.tw_pitch, /450 reviews/);
});

test('poor business, great site => low grade', () => {
  const lead = { name: 'X', review_count: 3, rating: 5, branch_count: 1,
    has_website: 'YES', has_phone: 'YES', has_email: 'YES', has_social: 'YES', website: 'https://x.in' };
  const audit = { web: { dead: false, no_ssl: false, not_mobile: false, no_seo: false, thin: false },
    geo: { no_schema: false, ai_crawlers_blocked: false, no_llms_txt: false, no_answer_content: false, no_sitemap: false } };
  const r = gradeTimewheel(lead, audit, cfg);
  assert.ok(['C', 'D'].includes(r.tw_grade), `got ${r.tw_grade}`);
});

test('unobserved (null) audit signals earn nothing, no false pitch', () => {
  const lead = { name: 'Y', review_count: 200, rating: 4.5, has_website: 'YES',
    has_phone: 'YES', has_social: 'YES', website: 'https://y.in' };
  const nulls = { web: { dead: null, no_ssl: null, not_mobile: null, no_seo: null, thin: null },
    geo: { no_schema: null, ai_crawlers_blocked: null, no_llms_txt: null, no_answer_content: null, no_sitemap: null } };
  const r = gradeTimewheel(lead, nulls, cfg);
  const gaps = JSON.parse(r.tw_gap_json);
  assert.ok(!gaps.includes('not_mobile'));
  assert.ok(!gaps.includes('ai_crawlers_blocked'));
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/gmaps-grade-timewheel.test.mjs`
Expected: FAIL — cannot find module.

- [ ] **Step 4: Write the implementation**

```javascript
// gmaps/grade-timewheel.mjs — digital-gap opportunity grader for Timewheel.
// Parallel to gmaps/grade.mjs (Book A Sloth). Pure. High business_value + big
// gaps + reachable => A/P1. Gaps flagged only from evidence (true), never from
// null/UNKNOWN. Weights in timewheel-scoring.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { composePitch } from './pitch.mjs';

const DEFAULTS = {
  weights: { business_value: 30, web_gap: 18, mobile_seo_gap: 14, geo_aeo_gap: 18, social_gap: 8, contactability: 10 },
  reviewCap: 500, ratingMinReviews: 10, grades: { A: 72, B: 56, C: 40 },
};

export function loadTwConfig(file) {
  const f = file || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'timewheel-scoring.json');
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return { ...DEFAULTS, ...j, weights: { ...DEFAULTS.weights, ...(j.weights || {}) }, grades: { ...DEFAULTS.grades, ...(j.grades || {}) } };
  } catch { return DEFAULTS; }
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const isYes = (v) => v === 'YES';
const isNo = (v) => v === 'NO'; // explicit evidence of absence

// A gap is "present" only when we have positive evidence: the audit flag is true.
const on = (v) => v === true;

export function gradeTimewheel(lead, audit = {}, cfg = DEFAULTS) {
  const W = cfg.weights;
  const web = audit.web || {};
  const geo = audit.geo || {};
  const noSite = isNo(lead.has_website) || !lead.website;
  const gaps = [];
  let score = 0;

  // business_value: reviews (log) + rating + multi-branch. Proof they can pay.
  const rc = Number(lead.review_count) || 0;
  const rating = Number(lead.rating) || 0;
  let bvFrac = clamp(Math.log10(rc + 1) / Math.log10(cfg.reviewCap + 1), 0, 1) * 0.7;
  if (rating > 0 && rc >= cfg.ratingMinReviews) bvFrac += ((clamp((rating - 3) / 2, 0, 1)) * 0.2);
  if ((Number(lead.branch_count) || 1) > 1) bvFrac += 0.1;
  score += W.business_value * clamp(bvFrac, 0, 1);

  // web_gap: no site (max) or dead/insecure.
  let webFrac = 0;
  if (noSite) { webFrac = 1; gaps.push('no_website'); }
  else {
    if (on(web.dead)) { webFrac += 0.7; gaps.push('dead_site'); }
    if (on(web.no_ssl)) { webFrac += 0.3; gaps.push('no_ssl'); }
  }
  score += W.web_gap * clamp(webFrac, 0, 1);

  // mobile_seo_gap: only when a live site was observed.
  let msFrac = 0;
  if (noSite) msFrac = 1;
  else {
    if (on(web.not_mobile)) { msFrac += 0.4; gaps.push('not_mobile'); }
    if (on(web.no_seo)) { msFrac += 0.4; gaps.push('weak_seo'); }
    if (on(web.thin)) { msFrac += 0.2; gaps.push('thin'); }
  }
  score += W.mobile_seo_gap * clamp(msFrac, 0, 1);

  // geo_aeo_gap: no site => invisible to AI (max). Else from observed geo flags.
  let geoFrac = 0;
  if (noSite) geoFrac = 1;
  else {
    if (on(geo.no_schema)) { geoFrac += 0.3; gaps.push('no_schema'); }
    if (on(geo.ai_crawlers_blocked)) { geoFrac += 0.3; gaps.push('ai_crawlers_blocked'); }
    if (on(geo.no_answer_content)) { geoFrac += 0.2; gaps.push('no_answer_content'); }
    if (on(geo.no_llms_txt)) { geoFrac += 0.1; gaps.push('no_llms_txt'); }
    if (on(geo.no_sitemap)) { geoFrac += 0.1; gaps.push('no_sitemap'); }
  }
  score += W.geo_aeo_gap * clamp(geoFrac, 0, 1);

  // social_gap: explicit NO only.
  if (isNo(lead.has_social)) { score += W.social_gap; gaps.push('no_social'); }

  // contactability: can we reach them to pitch?
  const reachable = isYes(lead.has_phone) || isYes(lead.has_email) || isYes(lead.has_whatsapp);
  let cFrac = 0;
  if (isYes(lead.has_phone)) cFrac += 0.5;
  if (isYes(lead.has_email)) cFrac += 0.3;
  if (isYes(lead.has_whatsapp)) cFrac += 0.2;
  score += W.contactability * clamp(cFrac, 0, 1);

  const tw_score = clamp(Math.round(score), 0, 100);
  let tw_grade = 'D';
  if (tw_score >= cfg.grades.A) tw_grade = 'A';
  else if (tw_score >= cfg.grades.B) tw_grade = 'B';
  else if (tw_score >= cfg.grades.C) tw_grade = 'C';

  let tw_priority = 'P3';
  if (tw_grade === 'A' && reachable) tw_priority = 'P1';
  else if ((tw_grade === 'A' || tw_grade === 'B') && reachable) tw_priority = 'P2';

  return {
    tw_score, tw_grade, tw_priority,
    tw_gap_json: JSON.stringify(gaps),
    tw_pitch: composePitch(lead, gaps),
  };
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `node --test test/gmaps-grade-timewheel.test.mjs`
Expected: PASS (all 4).

- [ ] **Step 6: Commit**

```bash
git add gmaps/grade-timewheel.mjs timewheel-scoring.json test/gmaps-grade-timewheel.test.mjs
git commit -m "feat: add Timewheel digital-gap grader + config"
```

---

### Task 6: Deep GEO — citability heuristic + brand-mention seam (`gmaps/geo-deep.mjs`)

Node-computable "convincing data" for A/B leads. `citabilityScore` is a pure heuristic over the fetched HTML (structure AI engines reward). `brandMentions` is a gated seam (search API) that returns `skipped` without a key.

**Files:**
- Create: `gmaps/geo-deep.mjs`
- Test: `test/gmaps-geo-deep.test.mjs`

**Interfaces:**
- Produces:
  - `citabilityScore(html) -> { score:0..100, signals:{...} }` (pure). Signals: `hasFaq, headingCount, listCount, hasSchema, wordCount, hasDirectAnswers`.
  - `brandMentions(lead, { apiKey } = {}) -> Promise<{ status:'skipped'|'ok', count:number, note:string }>` — `skipped` without a key (documented seam).
  - `deepGeo(lead, html, opts?) -> Promise<{ citability, mentions }>` — combines both; used by the CLI for A/B leads. Result stored as `geo_json` deep block.

- [ ] **Step 1: Write the failing test**

```javascript
// test/gmaps-geo-deep.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { citabilityScore, brandMentions } from '../gmaps/geo-deep.mjs';

test('citabilityScore: rich structured page scores higher than thin', () => {
  const rich = `<h1>A</h1><h2>Frequently Asked Questions</h2><h2>Services</h2>
    <ul><li>x</li><li>y</li></ul>
    <script type="application/ld+json">{"@type":"FAQPage"}</script>
    ${'<p>real informative sentence with plenty of words.</p>'.repeat(60)}`;
  const thin = `<p>hi</p>`;
  assert.ok(citabilityScore(rich).score > citabilityScore(thin).score);
  assert.equal(citabilityScore(rich).signals.hasFaq, true);
});

test('brandMentions: no key => skipped', async () => {
  const r = await brandMentions({ name: 'Sharma Dental Nagpur' }, { apiKey: '' });
  assert.equal(r.status, 'skipped');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/gmaps-geo-deep.test.mjs`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

```javascript
// gmaps/geo-deep.mjs — deep GEO "convincing data" for A/B leads, Node-computable.
// citabilityScore: how quotable/citable the page is to AI answer engines (pure
// heuristic). brandMentions: entity/citation strength off-site — a gated seam
// (needs a search API key) that returns 'skipped' until wired.
//
// NOTE: The richer Claude geo-* skills (geo-citability, geo-brand-mentions) remain
// a MANUAL deep-dive for building the final per-lead pitch deck; they run in a
// Claude session, not in this autonomous pipeline.

const stripText = (html) => String(html || '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

export function citabilityScore(html) {
  const h = String(html || '');
  const text = stripText(h);
  const wordCount = text ? text.split(/\s+/).length : 0;
  const headingCount = (h.match(/<h[1-3][\s>]/gi) || []).length;
  const listCount = (h.match(/<(ul|ol)[\s>]/gi) || []).length;
  const hasSchema = /application\/ld\+json/i.test(h);
  const hasFaq = /faqpage/i.test(h) || /frequently asked questions/i.test(h);
  const hasDirectAnswers = /\b(what|how|why|when|where)\b[^.?!]{0,80}\?/i.test(text);
  let score = 0;
  score += Math.min(30, Math.round(wordCount / 40));   // depth up to 30
  score += Math.min(20, headingCount * 4);             // structure up to 20
  score += Math.min(10, listCount * 5);                // scannability up to 10
  if (hasSchema) score += 15;
  if (hasFaq) score += 15;
  if (hasDirectAnswers) score += 10;
  return { score: Math.min(100, score),
    signals: { hasFaq, headingCount, listCount, hasSchema, wordCount, hasDirectAnswers } };
}

// Gated seam. Wire a search API (e.g. Brave/Serper) here to count off-site
// mentions of the business name; strong pitch input ("AI has no data on you").
export async function brandMentions(lead, { apiKey } = {}) {
  const key = apiKey ?? process.env.SEARCH_API_KEY ?? '';
  if (!key) return { status: 'skipped', count: 0, note: 'no SEARCH_API_KEY' };
  // ponytail: seam only. Implement the search call + count when the key lands.
  return { status: 'skipped', count: 0, note: 'not implemented' };
}

export async function deepGeo(lead, html, opts = {}) {
  const citability = citabilityScore(html || '');
  const mentions = await brandMentions(lead, opts);
  return { citability, mentions };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test test/gmaps-geo-deep.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add gmaps/geo-deep.mjs test/gmaps-geo-deep.test.mjs
git commit -m "feat: add deep GEO citability heuristic + brand-mention seam"
```

---

### Task 7: Re-grade CLI (`gmaps/regrade-timewheel.mjs`)

Run audit + Timewheel grade over all existing rows; add deep GEO for the A/B leads it produces. Idempotent (re-runs update in place). Produces results today.

**Files:**
- Create: `gmaps/regrade-timewheel.mjs`
- Test: `test/gmaps-regrade-timewheel.test.mjs`

**Interfaces:**
- Consumes: `initGmaps` (Task 2 statements `updateAudit`, `updateTwGrade`), `auditSite` (Task 3), `gradeTimewheel`/`loadTwConfig` (Task 5), `deepGeo` (Task 6), `fetchText`/`fetchStatus` (Task 1).
- Produces: `regradeAll(q, deps) -> Promise<{ audited, graded, deep }>` where `deps = { fetchText, fetchStatus, cfg?, deepGrades? }` (`deepGrades` default `['A','B']`). CLI entry (`import.meta` main) opens `leads.db` and runs it.

- [ ] **Step 1: Write the failing test**

```javascript
// test/gmaps-regrade-timewheel.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { initGmaps } from '../gmaps/db.mjs';
import { regradeAll } from '../gmaps/regrade-timewheel.mjs';

function seed(q) {
  const now = Date.now();
  const base = { job_id: 1, maps_url: '', place_id: '', cid: '', address: '', locality: '',
    lat: null, lng: null, category: '', hours_json: '{}', description: '', services_json: '[]',
    doctor_name: '', socials_json: '{}', email: '', booking_link: '', whatsapp: '',
    branch_count: 1, areas_json: '{}', queries_json: '{}', found_count: 1,
    first_seen: now, last_seen: now, ts: now };
  q.insertLead.run({ ...base, key: 'rich', name: 'Sharma Dental', phone: '911', website: '',
    rating: 4.6, review_count: 450, place_id: 'p1' });
  // reflect enrich flags (insertLead defaults them UNKNOWN; set no-website explicitly)
  q.updateEnrich.run({ key: 'rich', email: '', socials_json: '{}', booking_link: '', whatsapp: '',
    has_website: 'NO', has_phone: 'YES', has_email: 'UNKNOWN', has_social: 'NO',
    has_booking: 'UNKNOWN', has_whatsapp: 'UNKNOWN', enrich_status: 'skipped' });
}

test('regradeAll audits + grades every lead; no-website rich => A', async () => {
  const db = new Database(':memory:');
  const q = initGmaps(db);
  seed(q);
  const deps = { fetchText: async () => null, fetchStatus: async () => 0 };
  const out = await regradeAll(q, deps);
  assert.equal(out.graded, 1);
  const row = q.getLead.get('rich');
  assert.equal(row.tw_grade, 'A');
  assert.equal(row.audit_status, 'skipped'); // no website
  assert.ok(JSON.parse(row.tw_gap_json).includes('no_website'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/gmaps-regrade-timewheel.test.mjs`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

```javascript
// gmaps/regrade-timewheel.mjs — backfill Timewheel scoring over existing rows.
// audit -> tw grade -> deep GEO (A/B only). Idempotent. Pure core (regradeAll)
// with injected fetchers; CLI entry opens leads.db.
import { auditSite } from './audit.mjs';
import { gradeTimewheel, loadTwConfig } from './grade-timewheel.mjs';
import { deepGeo } from './geo-deep.mjs';

export async function regradeAll(q, deps) {
  const cfg = deps.cfg || loadTwConfig();
  const deepGrades = deps.deepGrades || ['A', 'B'];
  const rows = q.allLeads.all();
  let audited = 0, graded = 0, deep = 0;

  for (const row of rows) {
    const a = await auditSite(row, deps);
    q.updateAudit.run({ key: row.key, audit_json: a.audit_json, psi_json: row.psi_json || '{}',
      geo_json: a.geo_json, audit_status: a.audit_status });
    if (a.audit_status !== 'skipped') audited++;

    let audit = {}; try { audit = JSON.parse(a.audit_json); } catch {}
    const g = gradeTimewheel(row, audit, cfg);
    q.updateTwGrade.run({ key: row.key, ...g });
    graded++;

    // deep GEO for A/B leads with a live site (needs the HTML again)
    if (deepGrades.includes(g.tw_grade) && row.website && a.audit_status === 'ok') {
      const html = await deps.fetchText(row.website);
      if (html) {
        const dg = await deepGeo(row, html, deps);
        let geo = {}; try { geo = JSON.parse(a.geo_json); } catch {}
        geo.deep = dg;
        q.updateAudit.run({ key: row.key, audit_json: a.audit_json, psi_json: row.psi_json || '{}',
          geo_json: JSON.stringify(geo), audit_status: a.audit_status });
        deep++;
      }
    }
  }
  return { audited, graded, deep };
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('regrade-timewheel.mjs')) {
  const Database = (await import('better-sqlite3')).default;
  const { fetchText, fetchStatus } = await import('./fetch.mjs');
  const db = new Database('leads.db');
  const { initGmaps } = await import('./db.mjs');
  const q = initGmaps(db);
  const out = await regradeAll(q, { fetchText, fetchStatus });
  console.log('Timewheel regrade:', out);
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test test/gmaps-regrade-timewheel.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add gmaps/regrade-timewheel.mjs test/gmaps-regrade-timewheel.test.mjs
git commit -m "feat: add Timewheel regrade CLI (audit + grade + deep GEO over existing leads)"
```

---

### Task 8: Wire audit + tw-grade into the runner (`gmaps/runner.mjs`)

Fresh scrapes should populate `tw_*` too, not just Book A Sloth grades. Add audit + Timewheel grade to the per-lead loop, alongside the existing enrich/score/grade.

**Files:**
- Modify: `gmaps/runner.mjs:60-73` (per-lead enrich/score/grade loop)
- Test: `test/gmaps-runner.test.mjs` (append)

**Interfaces:**
- Consumes: `auditSite` (Task 3), `gradeTimewheel`/`loadTwConfig` (Task 5). The runner already receives `deps.enrichDeps = { fetchText, extract }`; audit needs `fetchStatus` too — extend `enrichDeps` to optionally carry `fetchStatus` (default to a no-op returning 0 so existing tests pass).

- [ ] **Step 1: Write the failing test**

```javascript
// append to test/gmaps-runner.test.mjs — mirror the existing runJob test setup.
// (Reuse the file's existing imports/helpers for building q + a fake runCell.)
import { test } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { initGmaps } from '../gmaps/db.mjs';
import { createJob, runJob } from '../gmaps/runner.mjs';

test('runJob populates tw_grade for scraped leads', async () => {
  const db = new Database(':memory:');
  const q = initGmaps(db);
  const jobId = createJob(q, { city: 'Nagpur', areas: ['Dharampeth'], queries: ['dentist'], cap: 10 });
  const deps = {
    runCell: async () => ([{ name: 'Rich Dental', phone: '911', website: '', rating: 4.7,
      review_count: 300, place_id: 'x1', maps_url: 'https://maps/x1' }]),
    enrichDeps: { fetchText: async () => null, extract: () => ({ emails: [], phones: [], socials: {} }),
      fetchStatus: async () => 0 },
  };
  await runJob(q, jobId, deps);
  const rows = q.allLeads.all();
  assert.ok(rows.length >= 1);
  assert.ok(rows[0].tw_grade, 'tw_grade should be set');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/gmaps-runner.test.mjs`
Expected: FAIL — `tw_grade` is null/empty.

- [ ] **Step 3: Add imports + wire the loop**

In `gmaps/runner.mjs`, add near the top imports:

```javascript
import { auditSite } from './audit.mjs';
import { gradeTimewheel, loadTwConfig } from './grade-timewheel.mjs';
```

In `runJob`, after `const cfg = deps.cfg || loadScoringConfig();` add:

```javascript
  const twCfg = deps.twCfg || loadTwConfig();
  const auditDeps = { fetchText: deps.enrichDeps.fetchText, fetchStatus: deps.enrichDeps.fetchStatus || (async () => 0) };
```

Then inside the `for (const key of touched)` loop, after the existing `q.updateGrade.run(...)` line (~line 72), add:

```javascript
      // Timewheel parallel track: audit + digital-gap grade
      const twRow = q.getLead.get(key);
      const a = await auditSite(twRow, auditDeps);
      q.updateAudit.run({ key, audit_json: a.audit_json, psi_json: twRow.psi_json || '{}',
        geo_json: a.geo_json, audit_status: a.audit_status });
      let auditObj = {}; try { auditObj = JSON.parse(a.audit_json); } catch {}
      q.updateTwGrade.run({ key, ...gradeTimewheel(twRow, auditObj, twCfg) });
```

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test test/gmaps-runner.test.mjs`
Expected: PASS (existing runner tests + the new one).

- [ ] **Step 5: Commit**

```bash
git add gmaps/runner.mjs test/gmaps-runner.test.mjs
git commit -m "feat: run Timewheel audit + grade inside the scrape runner"
```

---

### Task 9: Timewheel export columns (`gmaps/export.mjs`)

Add a Timewheel column set + a `product` switch so exports carry `tw_*` + gaps + pitch.

**Files:**
- Modify: `gmaps/export.mjs`
- Test: `test/gmaps-export.test.mjs` (append)

**Interfaces:**
- Produces: `TW_SALES_COLS` (array); `flatten(lead, includeRaw, product='sloth')`, `toCSV(leads, includeRaw, product)`, `toJSON(leads, includeRaw, product)` — when `product==='timewheel'`, use `TW_SALES_COLS` and derive `tw_gaps` (from `tw_gap_json`) + `audit_summary` (from `audit_json`). Existing signature stays back-compatible (default `product='sloth'`).

- [ ] **Step 1: Write the failing test**

```javascript
// append to test/gmaps-export.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { toCSV } from '../gmaps/export.mjs';

test('timewheel export includes tw fields + gaps', () => {
  const lead = { name: 'Sharma Dental', tw_grade: 'A', tw_priority: 'P1', tw_score: 80,
    tw_pitch: 'No website.', tw_gap_json: '["no_website","no_schema"]',
    audit_json: '{"web":{"platform":"none"}}', phone: '911', category: 'Dentist' };
  const csv = toCSV([lead], false, 'timewheel');
  assert.match(csv, /tw_grade/);
  assert.match(csv, /Sharma Dental/);
  assert.match(csv, /no_website; no_schema/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/gmaps-export.test.mjs`
Expected: FAIL — `tw_grade` column absent / `toCSV` ignores product.

- [ ] **Step 3: Extend `export.mjs`**

Add after `RAW_COLS`:

```javascript
export const TW_SALES_COLS = ['tw_grade', 'tw_priority', 'tw_score', 'tw_pitch', 'tw_gaps',
  'name', 'category', 'locality', 'address', 'phone', 'whatsapp', 'email', 'website',
  'rating', 'review_count', 'has_website', 'has_social', 'audit_summary', 'maps_url'];
```

Change `flatten` to accept `product`:

```javascript
export function flatten(lead, includeRaw = false, product = 'sloth') {
  const reasons = (() => { try { return JSON.parse(lead.score_reasons_json || '[]').join('; '); } catch { return ''; } })();
  const gradeReasons = (() => { try { return (JSON.parse(lead.grade_json || '{}').reasons || []).join('; '); } catch { return ''; } })();
  const twGaps = (() => { try { return JSON.parse(lead.tw_gap_json || '[]').join('; '); } catch { return ''; } })();
  const auditSummary = (() => { try { const w = (JSON.parse(lead.audit_json || '{}').web) || {}; return `platform=${w.platform ?? '?'}`; } catch { return ''; } })();
  const derived = { score_reasons: reasons, grade_reasons: gradeReasons, tw_gaps: twGaps, audit_summary: auditSummary };
  const cols = product === 'timewheel' ? TW_SALES_COLS : SALES_COLS;
  const row = {};
  for (const c of cols) row[c] = c in derived ? derived[c] : (lead[c] ?? '');
  if (includeRaw) for (const c of RAW_COLS) row[c] = lead[c] ?? '';
  return row;
}
```

Thread `product` through `exportRows`/`toCSV`/`toJSON`:

```javascript
export function exportRows(leads, includeRaw = false, product = 'sloth') { return leads.map(l => flatten(l, includeRaw, product)); }

export function toCSV(leads, includeRaw = false, product = 'sloth') {
  const base = product === 'timewheel' ? TW_SALES_COLS : SALES_COLS;
  const cols = includeRaw ? [...base, ...RAW_COLS] : base;
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = exportRows(leads, includeRaw, product);
  return cols.join(',') + '\n' + rows.map(r => cols.map(c => esc(r[c])).join(',')).join('\n');
}

export function toJSON(leads, includeRaw = false, product = 'sloth') {
  return JSON.stringify(exportRows(leads, includeRaw, product), null, 2);
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test test/gmaps-export.test.mjs`
Expected: PASS (existing + new).

- [ ] **Step 5: Commit**

```bash
git add gmaps/export.mjs test/gmaps-export.test.mjs
git commit -m "feat: add Timewheel export column set + product switch"
```

---

### Task 10: Server routes + dashboard toggle (`server.mjs`)

Expose the Timewheel track over HTTP: a regrade trigger, tw-filtered leads/stats/export, and a product toggle in the admin UI.

**Files:**
- Modify: `server.mjs` (add imports + routes near the existing `/api/gmaps/*` block; add a product toggle to the admin HTML/JS)
- Test: manual (route smoke) — no unit test framework for the raw-http server; verify with curl in Step 5.

**Interfaces:**
- Consumes: `regradeAll` (Task 7), `gexport.toCSV/toJSON` with `product='timewheel'` (Task 9), `G.allLeads` + `db` (existing).
- Produces routes:
  - `POST /api/gmaps/tw-regrade-all` — runs `regradeAll(G, { fetchText, fetchStatus })`, returns counts.
  - `GET /api/gmaps/tw-leads` — same filters as `/api/gmaps/leads` but ordered by `tw_score DESC`, filterable by `tw_grade`, `tw_priority`, and `gap` (matches inside `tw_gap_json`).
  - `GET /api/gmaps/tw-export.csv|.json` — export with `product='timewheel'`, same filters.

- [ ] **Step 1: Add imports**

Near the gmaps imports at the top of `server.mjs`:

```javascript
import { fetchStatus as sharedFetchStatus } from './gmaps/fetch.mjs';
import { regradeAll } from './gmaps/regrade-timewheel.mjs';
```

And a local status helper mirroring `fetchText`:

```javascript
const fetchStatus = (url) => sharedFetchStatus(url, { timeoutMs: TIMEOUT_MS, ua: UA });
```

- [ ] **Step 2: Add the regrade route**

Next to the existing `POST /api/gmaps/grade-all` handler (~server.mjs:472):

```javascript
  if (req.method === 'POST' && p === '/api/gmaps/tw-regrade-all') {
    const out = await regradeAll(G, { fetchText, fetchStatus });
    return send(res, 200, 'application/json', JSON.stringify(out));
  }
```

- [ ] **Step 3: Add tw-leads + tw-export routes**

After the existing `/api/gmaps/leads` handler (~server.mjs:539), add:

```javascript
  if (req.method === 'GET' && p === '/api/gmaps/tw-leads') {
    const args = {}; const where = [];
    const jid = Number(url.searchParams.get('job_id')) || 0;
    if (jid) { where.push('job_id=@jid'); args.jid = jid; }
    const g = url.searchParams.get('tw_grade'); if (g) { where.push('tw_grade=@g'); args.g = g; }
    const pr = url.searchParams.get('tw_priority'); if (pr) { where.push('tw_priority=@pr'); args.pr = pr; }
    const gap = url.searchParams.get('gap'); if (gap) { where.push('tw_gap_json LIKE @gap'); args.gap = '%"' + gap + '"%'; }
    const qs = (url.searchParams.get('q') || '').trim();
    if (qs) { where.push('(name LIKE @q OR category LIKE @q OR locality LIKE @q)'); args.q = '%' + qs + '%'; }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const limit = Math.min(2000, Number(url.searchParams.get('limit')) || 500);
    const offset = Number(url.searchParams.get('offset')) || 0;
    const rows = db.prepare(`SELECT * FROM gmaps_leads ${w} ORDER BY tw_score DESC LIMIT @limit OFFSET @offset`).all({ ...args, limit, offset });
    const total = db.prepare(`SELECT COUNT(*) n FROM gmaps_leads ${w}`).get(args).n;
    return send(res, 200, 'application/json', JSON.stringify({ rows, total }));
  }
  if (req.method === 'GET' && (p === '/api/gmaps/tw-export.csv' || p === '/api/gmaps/tw-export.json')) {
    const raw = url.searchParams.get('raw') === '1';
    const args = {}; const where = [];
    const g = url.searchParams.get('tw_grade'); if (g) { where.push('tw_grade=@g'); args.g = g; }
    const pr = url.searchParams.get('tw_priority'); if (pr) { where.push('tw_priority=@pr'); args.pr = pr; }
    const gap = url.searchParams.get('gap'); if (gap) { where.push('tw_gap_json LIKE @gap'); args.gap = '%"' + gap + '"%'; }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rows = db.prepare(`SELECT * FROM gmaps_leads ${w} ORDER BY tw_score DESC`).all(args);
    const tag = [g, pr, gap].filter(Boolean).join('-') || 'all';
    const fname = `timewheel-leads-${tag}`;
    if (p.endsWith('.csv')) {
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="${fname}.csv"` });
      return res.end(gexport.toCSV(rows, raw, 'timewheel'));
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${fname}.json"` });
    return res.end(gexport.toJSON(rows, raw, 'timewheel'));
  }
```

- [ ] **Step 4: Add a product toggle to the admin UI**

Locate the gmaps dashboard markup in `server.mjs` (the admin HTML template string served for the gmaps view — search for `/api/gmaps/leads` in the client JS). Add a product selector that, when set to "Timewheel", points the table fetch at `/api/gmaps/tw-leads`, shows columns `tw_grade | tw_priority | tw_score | name | phone | tw_pitch | gaps`, adds a gap-type filter dropdown (`no_website, ai_crawlers_blocked, no_schema, not_mobile, weak_seo, no_social`), and a "Regrade Timewheel" button POSTing `/api/gmaps/tw-regrade-all`. Reuse the existing table render + filter wiring; only swap the endpoint, columns, and filter params. Keep the default product "Book A Sloth" so the existing view is unchanged.

(Implementation detail: mirror the existing leads-fetch function, parameterized by `product`. This is UI plumbing over the routes added above; no new data logic.)

- [ ] **Step 5: Smoke-test the routes**

Run: `node --check server.mjs` (syntax), then start the server (`node server.mjs`) and:

```bash
curl -X POST http://localhost:3000/api/gmaps/tw-regrade-all
curl "http://localhost:3000/api/gmaps/tw-leads?tw_grade=A&limit=5"
curl "http://localhost:3000/api/gmaps/tw-export.csv?tw_grade=A" -o /tmp/tw.csv && head -2 /tmp/tw.csv
```

Expected: regrade returns `{audited,graded,deep}`; tw-leads returns rows ordered by `tw_score`; CSV has the `tw_*` header. (Adjust port if `server.mjs` uses a different one.)

- [ ] **Step 6: Commit**

```bash
git add server.mjs
git commit -m "feat: Timewheel routes (regrade/tw-leads/tw-export) + admin product toggle"
```

---

### Task 11: Nagpur verticals config + docs (`timewheel-verticals.json`, `README.md`)

Ship the query set for businesses that buy web/SEO/GEO/social, and document the workflow.

**Files:**
- Create: `timewheel-verticals.json`
- Modify: `README.md` (add a Timewheel section)

**Interfaces:**
- Produces: a config the operator feeds to `POST /api/gmaps/jobs` (existing) to scrape new verticals; the runner (Task 8) then auto-populates `tw_*`.

- [ ] **Step 1: Write `timewheel-verticals.json`**

```json
{
  "city": "Nagpur",
  "areas": ["Dharampeth", "Sadar", "Sitabuldi", "Ramdaspeth", "Civil Lines",
    "Manish Nagar", "Pratap Nagar", "Wardha Road", "Bajaj Nagar", "Laxmi Nagar"],
  "verticals": {
    "restaurants": ["restaurant", "cafe", "cloud kitchen"],
    "fitness": ["gym", "fitness studio", "yoga studio"],
    "real_estate": ["real estate agent", "property dealer", "builder"],
    "hotels": ["hotel", "banquet hall", "resort"],
    "salons_spas": ["salon", "spa", "beauty parlour"],
    "clinics": ["clinic", "dental clinic", "diagnostic centre"],
    "coaching": ["coaching classes", "training institute"],
    "events": ["wedding planner", "event management", "photographer"],
    "interiors": ["interior designer", "architect"],
    "auto": ["car dealer", "car service centre"],
    "jewellers": ["jeweller", "jewellery showroom"],
    "retail": ["boutique", "furniture store", "electronics store"]
  }
}
```

- [ ] **Step 2: Document the workflow in `README.md`**

Add a `## Timewheel Internet track` section covering: what it scores (digital gap: web/SEO/AEO/GEO/social), how to backfill existing leads (`node gmaps/regrade-timewheel.mjs`), how to scrape new verticals (POST `/api/gmaps/jobs` with an area×query set from `timewheel-verticals.json`), the dashboard product toggle, exports (`/api/gmaps/tw-export.csv`), and the two later seams (`ANTHROPIC_API_KEY` for `draftEmail`, `SEARCH_API_KEY` for `brandMentions`, `PSI_API_KEY` for PageSpeed).

- [ ] **Step 3: Verify the CLI runs end-to-end on the real DB**

Run: `node gmaps/regrade-timewheel.mjs`
Expected: prints `Timewheel regrade: { audited, graded, deep }` with `graded` = current lead count. (This performs live audits; it may take a while and hit the network — that is expected for the backfill.)

- [ ] **Step 4: Full test suite green**

Run: `npm test`
Expected: all `node --test` files pass and `test-signals.mjs` still passes.

- [ ] **Step 5: Commit**

```bash
git add timewheel-verticals.json README.md
git commit -m "feat: add Nagpur Timewheel verticals config + docs"
```

---

## Self-Review

**Spec coverage:**
- Site+GEO/AEO audit (cheap, all leads) → Task 3. ✓
- PSI on A-grade → seam noted (`psi_json` column Task 2; PSI call is an explicit later seam, documented Task 11). ✓ (deferred, gated — matches "gated behind a key".)
- Deep GEO (citability + brand-mention) on A/B → Task 6 + Task 7 (`deepGrades=['A','B']`). ✓
- Digital-gap grader with the 6 dimensions → Task 5. ✓
- `tw_pitch` across SEO+AEO+GEO → Task 4 `composePitch`. ✓
- Regrade CLI (results today) → Task 7. ✓
- New Nagpur verticals → Task 11. ✓
- Export + dashboard + pitch-email seam → Tasks 9, 10, 4. ✓
- Parallel columns, Book A Sloth untouched → Task 2 (additive), grade.mjs never modified. ✓
- Home→cloud sync carries tw fields → Task 2 Step 5. ✓

**Placeholder scan:** No TBD/TODO left; the only deferred items (PSI call, live `draftEmail`, live `brandMentions`) are explicit seams the spec designates as later work, each with a documented wire-up point.

**Type consistency:** `auditSite -> {audit_json, geo_json, audit_status}` consumed identically in Tasks 7 & 8. `gradeTimewheel(lead, audit, cfg) -> {tw_score,tw_grade,tw_priority,tw_gap_json,tw_pitch}` matches `q.updateTwGrade` params (Task 2) everywhere. Gap keys emitted by the grader (`no_website, dead_site, no_ssl, not_mobile, weak_seo, thin, no_schema, ai_crawlers_blocked, no_answer_content, no_llms_txt, no_sitemap, no_social`) all exist in `GAP_PHRASES` (Task 4) and the dashboard gap filter (Task 10). `regradeAll(q, deps)` / `runJob` both pass `{fetchText, fetchStatus}` as audit deps. ✓
