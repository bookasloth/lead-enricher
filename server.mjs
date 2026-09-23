// server.mjs
// Local web app: drop a Semrush "Backlink Audit" export (.xlsx/.csv) in the
// browser, it dedupes by domain, scrapes each source for email/phone/socials/
// name/company, and streams a sortable best-first table. Export CSV/JSON.
//
//   npm install && npm start   ->   open http://localhost:5178
//
// Browser parses the spreadsheet (SheetJS) and POSTs rows here, so the server
// needs no xlsx/multipart deps. Scraping logic reused from enrich.mjs.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseCSV, renderAdminHTML } from './admin-template.mjs';
import { initGmaps } from './gmaps/db.mjs';
import { provider } from './gmaps/provider.mjs';
import { runJob, createJob, coverageReport } from './gmaps/runner.mjs';
import { loadScoringConfig } from './gmaps/scoring.mjs';
import * as gexport from './gmaps/export.mjs';
import { layaDecide } from './gmaps/laya-client.mjs';
import { gradeLead } from './gmaps/grade.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- config ----------
const PORT        = 5178;
const DB_FILE     = path.join(__dirname, 'leads.db');
const CONCURRENCY = 30;          // balanced
const REQ_DELAY   = 150;         // ms jitter between a worker's requests (politeness)
const TIMEOUT_MS  = 12000;
const MAX_HTML    = 1_500_000;
const CONTACT_PATHS = ['/contact', '/contact-us', '/contactus', '/about', '/about-us', '/team', '/impressum'];
const UA = 'Mozilla/5.0 (compatible; LeadFinder/1.0)';

// competitor domain -> label (for the links_to column)
const COMPETITORS = {
  'topmate.io': 'Topmate', 'calendly.com': 'Calendly', 'cal.com': 'Cal.com',
  'savvycal.com': 'SavvyCal', 'tidycal.com': 'TidyCal', 'zcal.co': 'Zcal',
  'superpeer.com': 'Superpeer', 'stan.store': 'Stan',
};

// social hosts we do NOT scrape (login-walled / bot-blocked)
const SKIP_HOSTS = ['linkedin.com', 'instagram.com', 'facebook.com', 'twitter.com', 'x.com'];

// Aggregator/platform root domains — a backlink FROM here is not a prospect (it's a
// directory/profile host). Root pages get skipped_platform; user pages under a
// social type (github.com/<user>) are still real leads. ponytail: plain set, extend as needed.
const PLATFORM_ROOTS = new Set([
  'github.com','gitlab.com','medium.com','dev.to','producthunt.com','notion.so','notion.site',
  'substack.com','wordpress.com','wordpress.org','blogspot.com','reddit.com','quora.com',
  'youtube.com','vimeo.com','pinterest.com','tumblr.com','wix.com','wixsite.com','weebly.com',
  'squarespace.com','godaddy.com','canva.com','behance.net','dribbble.com','slideshare.net',
  'gitbook.io','readthedocs.io','sites.google.com','docs.google.com','crunchbase.com','g2.com',
  'capterra.com','trustpilot.com','yelp.com','glassdoor.com','stackoverflow.com','hashnode.com',
]);
// Link-in-bio hosts: many people share one domain, so key by full URL (per user), not domain,
// otherwise every creator collapses into a single useless row.
const MULTI_USER_HOSTS = new Set(['linktr.ee','bio.link','beacons.ai','carrd.co','about.me','linkin.bio','solo.to','komi.io','msha.ke']);

// email quality tiers (personal-on-domain converts best; role/free are weaker; drives primary pick + score)
const ROLE_LOCALS = new Set(['info','hello','contact','support','admin','sales','team','help','office','mail',
  'enquiry','enquiries','inquiry','inquiries','hi','hey','press','marketing','billing','accounts',
  'careers','jobs','noreply','no-reply','donotreply','webmaster','hr','general','service','feedback']);
const FREE_DOMAINS = new Set(['gmail.com','googlemail.com','yahoo.com','ymail.com','hotmail.com','outlook.com',
  'live.com','msn.com','icloud.com','me.com','aol.com','gmx.com','proton.me','protonmail.com','pm.me','mail.com','zoho.com']);

// scoring knobs — tune here. ponytail: heuristic weights, adjust after seeing real conversions.
const W = {
  personal:42, role:26, personal_offdomain:24, personal_free:22, role_free:12, phoneOnly:10,
  ascoreMax:25, intentReview:15, multiCompetitor:10, hasName:8, hasSocials:4, platformMult:0.15,
};

const JUNK = [
  'example.com','example.org','sentry','wixpress.com','wix.com','godaddy.com',
  'squarespace.com','shopify.com','cloudflare','domain.com','yourdomain','email.com',
  'yoursite','.png','.jpg','.jpeg','.gif','.svg','.webp','.css','.js','@2x','@x',
  'sentry.io','core.js','jquery','bootstrap','@sentry','wixpress',
];
const EMAIL_RE  = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,24}/g;
const MAILTO_RE = /mailto:([^"'?<>\s]+)/gi;
const TEL_RE    = /tel:([+\d][\d\s\-().]{6,}\d)/gi;
const SOCIAL_RES = {
  linkedin:  /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:in|company)\/[A-Za-z0-9._%\-]+/gi,
  instagram: /https?:\/\/(?:www\.)?instagram\.com\/[A-Za-z0-9._]+/gi,
  twitter:   /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[A-Za-z0-9_]+/gi,
  facebook:  /https?:\/\/(?:www\.)?facebook\.com\/[A-Za-z0-9.\-]+/gi,
  youtube:   /https?:\/\/(?:www\.)?youtube\.com\/(?:@|channel\/|c\/)[A-Za-z0-9._\-]+/gi,
  whatsapp:  /https?:\/\/(?:wa\.me|api\.whatsapp\.com)\/[^"'<>\s]+/gi,
  telegram:  /https?:\/\/t\.me\/[A-Za-z0-9_]+/gi,
};

// ---------- db ----------
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS sources (
  key        TEXT PRIMARY KEY,   -- domain (website) or full url (social)
  source_url TEXT,               -- representative source page
  domain     TEXT,
  type       TEXT,
  links_to   TEXT,
  anchor     TEXT,
  ascore     INTEGER,
  name       TEXT,
  company    TEXT,
  title      TEXT,
  emails     TEXT,
  phones     TEXT,
  socials    TEXT,
  status     TEXT,               -- pending | ok | no_contact | error | skipped_social
  note       TEXT,
  ts         INTEGER
);`);
const getRow    = db.prepare(`SELECT links_to FROM sources WHERE key=?`);
const insertSrc = db.prepare(`INSERT OR IGNORE INTO sources
  (key,source_url,domain,type,links_to,anchor,ascore,status,ts)
  VALUES (@key,@source_url,@domain,@type,@links_to,@anchor,@ascore,'pending',@ts)`);
const addLink   = db.prepare(`UPDATE sources SET links_to=? WHERE key=?`);
const saveRes   = db.prepare(`UPDATE sources SET
  name=@name, company=@company, title=@title, emails=@emails, phones=@phones,
  socials=@socials, status=@status, note=@note, ts=@ts WHERE key=@key`);
const pending   = db.prepare(`SELECT key, source_url, type, domain FROM sources WHERE status='pending'`);
const allRows   = db.prepare(`SELECT * FROM sources
  ORDER BY (emails != '') DESC, (phones != '') DESC, ascore DESC`);

// ---------- google maps source (own tables in the same db; sources untouched) ----------
const G = initGmaps(db);
const gmapsRunning = new Set();
const gmapsStop = new Set();
// hard concurrency cap — the box OOMs past ~2 parallel scrapers. Enforced HERE
// (not just in the watchdog) so nothing — watchdog, UI, or a manual /start — can
// ever exceed it, whatever order they fire in. Override with GMAPS_MAX_CONCURRENT.
const GMAPS_MAX_CONCURRENT = Math.max(1, Number(process.env.GMAPS_MAX_CONCURRENT) || 2);
const gScoreCfg = loadScoringConfig();

// ---------- classify + extract ----------
function competitorOf(url) {
  const u = (url || '').toLowerCase();
  for (const [dom, label] of Object.entries(COMPETITORS)) if (u.includes(dom)) return label;
  return null;
}
function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }
function normUrl(u) {
  u = (u || '').trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { return new URL(u).href; } catch { return null; }
}
function sourceType(host) {
  if (host.includes('linkedin.com'))  return 'linkedin';
  if (host.includes('instagram.com')) return 'instagram';
  if (host.includes('twitter.com') || host === 'x.com' || host.endsWith('.x.com')) return 'twitter';
  if (host.includes('facebook.com'))  return 'facebook';
  if (host.includes('youtube.com'))   return 'youtube';
  if (host.includes('github.com'))    return 'github';
  if (host.includes('medium.com'))    return 'medium';
  return 'website';
}
const isSkipHost = (host) => SKIP_HOSTS.some(h => host === h || host.endsWith('.' + h));

function cleanEmails(set, domain) {
  let list = [...set]
    .map(e => e.toLowerCase().replace(/^mailto:/, '').trim())
    .filter(e => e.includes('@') && e.length < 100)
    .filter(e => !JUNK.some(j => e.includes(j)))
    .filter(e => /\.[a-z]{2,}$/.test(e));
  list = [...new Set(list)];
  list.sort((a, b) => (b.endsWith('@' + domain) ? 1 : 0) - (a.endsWith('@' + domain) ? 1 : 0));
  return list;
}
function cleanPhones(set) {
  return [...new Set([...set].map(p => p.replace(/[^\d+]/g, '')))]
    .filter(p => { const d = p.replace(/\D/g, ''); return d.length >= 8 && d.length <= 15; });
}
// ---------- lead signals (derived from scraped data; no schema change, computed on read) ----------
function pathOf(url) { try { return new URL(url).pathname; } catch { return '/'; } }
function isPlatform(domain, type, url) {
  if (type === 'website') return PLATFORM_ROOTS.has(domain);
  const p = pathOf(url);
  return PLATFORM_ROOTS.has(domain) && (p === '' || p === '/'); // root profile of a social host = the platform itself
}
// email tier: personal > role (on-domain) > personal_offdomain > personal_free > role_free
function classifyEmail(email, domain) {
  const at = email.lastIndexOf('@');
  if (at < 0) return 'role_free';
  const local = email.slice(0, at), edom = email.slice(at + 1);
  const onDomain = !!domain && (edom === domain || edom.endsWith('.' + domain) || domain.endsWith('.' + edom));
  const role = ROLE_LOCALS.has(local.replace(/[0-9]+$/, ''));
  const free = FREE_DOMAINS.has(edom);
  if (role) return onDomain ? 'role' : 'role_free';
  if (free) return 'personal_free';
  return onDomain ? 'personal' : 'personal_offdomain';
}
const TIER_RANK = { personal:5, role:4, personal_offdomain:3.5, personal_free:3, role_free:2 };
// pick the single best contact email + its tier
function pickPrimary(emailsCsv, domain) {
  const list = (emailsCsv || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!list.length) return { email: '', tier: 'none' };
  let best = null, bestTier = 'role_free';
  for (const e of list) {
    const t = classifyEmail(e, domain);
    if (!best || (TIER_RANK[t] || 0) > (TIER_RANK[bestTier] || 0)) { best = e; bestTier = t; }
  }
  return { email: best, tier: bestTier };
}
function intentOf(row) {
  const a = (row.anchor || '').toLowerCase();
  const comps = (row.links_to || '').split(',').map(s => s.trim()).filter(c => c && c !== 'unknown');
  const review = /(alternativ|\bvs\b|versus|\bbest\b|top\s*\d|review|compar|round.?up|\btools?\b|competitor)/.test(a);
  if (review) return { tag: 'review / comparison', pts: W.intentReview + (comps.length > 1 ? W.multiCompetitor : 0) };
  if (comps.length > 1) return { tag: `compares ${comps.length} competitors`, pts: W.multiCompetitor };
  return { tag: comps.length ? `mentions ${comps[0]}` : 'backlink', pts: 0 };
}
// full signal bundle attached to every row on read / stream / export
function deriveSignals(row) {
  const platform = isPlatform(row.domain, row.type, row.source_url);
  const { email: primary_email, tier } = pickPrimary(row.emails, row.domain);
  const hasPhone = !!(row.phones || '').trim();
  const intent = intentOf(row);
  let score = 0;
  if (tier !== 'none') score += W[tier] || 0;
  else if (hasPhone) score += W.phoneOnly;
  score += Math.min(W.ascoreMax, (Number(row.ascore) || 0) * 0.25);
  score += intent.pts;
  if ((row.name || '').trim()) score += W.hasName;
  { let hasSoc = false; try { hasSoc = Object.keys(JSON.parse(row.socials || '{}')).length > 0; } catch {} if (hasSoc) score += W.hasSocials; }
  if (platform) score *= W.platformMult;
  score = Math.max(0, Math.min(100, Math.round(score)));

  const why = [];
  if (tier === 'personal') why.push('personal email on own domain');
  else if (tier === 'personal_offdomain') why.push('personal email');
  else if (tier === 'role') why.push('role inbox on own domain');
  else if (tier === 'personal_free') why.push('personal (free) email');
  else if (tier === 'role_free') why.push('generic email');
  else if (hasPhone) why.push('phone only');
  else why.push('no direct contact');
  if (row.name) why.push(`contact: ${row.name}`);
  if ((Number(row.ascore) || 0) >= 40) why.push(`DA ${row.ascore}`);
  why.push(intent.tag);
  if (platform) why.push('⚠ platform/aggregator — likely not a prospect');

  return { score, email_tier: tier, primary_email, intent: intent.tag, is_platform: platform, why: why.join(' · ') };
}
const withSignals = (row) => ({ ...row, ...deriveSignals(row) });
// all rows, best-lead-first (score desc, authority tiebreak)
function scoredRows() {
  return allRows.all().map(withSignals).sort((a, b) => b.score - a.score || (b.ascore || 0) - (a.ascore || 0));
}

// best-effort name + company from JSON-LD, og:site_name, title
function extractIdentity(html) {
  let name = '', company = '';
  const og = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']{1,80})["']/i);
  if (og) company = og[1].trim();
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      let data = JSON.parse(m[1].trim());
      const arr = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const node of arr) {
        const t = String(node['@type'] || '').toLowerCase();
        if (!node || typeof node !== 'object') continue;
        if ((t.includes('organization') || t.includes('localbusiness')) && node.name && !company) company = String(node.name).slice(0, 80);
        if (t.includes('person') && node.name && !name) name = String(node.name).slice(0, 80);
      }
    } catch { /* ignore bad json-ld */ }
  }
  return { name, company };
}
function extract(html, domain) {
  if (!html) return { emails: [], phones: [], socials: {}, title: '', name: '', company: '' };
  const emails = new Set(), phones = new Set(), socials = {};
  let m;
  while ((m = MAILTO_RE.exec(html)) !== null) emails.add(m[1]);
  while ((m = EMAIL_RE.exec(html))  !== null) emails.add(m[0]);
  while ((m = TEL_RE.exec(html))    !== null) phones.add(m[1]);
  for (const [k, re] of Object.entries(SOCIAL_RES)) {
    const found = html.match(re);
    if (found) socials[k] = [...new Set(found)].slice(0, 3);
  }
  const t = html.match(/<title[^>]*>([^<]{0,200})<\/title>/i);
  const id = extractIdentity(html);
  return { emails: cleanEmails(emails, domain), phones: cleanPhones(phones), socials, title: t ? t[1].trim() : '', ...id };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow',
      headers: { 'User-Agent': UA, 'Accept': 'text/html' } });
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
      if (received > MAX_HTML) { ctrl.abort(); break; }
    }
    return html;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

async function enrich(row) {
  const now = Date.now();
  const base = { key: row.key, name: '', company: '', title: '', emails: '', phones: '',
    socials: '{}', note: row.domain, ts: now };
  const host = hostOf(row.source_url);
  if (isSkipHost(host)) {
    // login-walled, but the profile URL itself is the actionable contact — surface it
    saveRes.run({ ...base, socials: JSON.stringify({ [row.type]: [row.source_url] }),
      status: 'skipped_social', note: 'profile link — work manually' });
    return;
  }
  if (isPlatform(row.domain, row.type, row.source_url)) {
    // aggregator/platform root — scraping it yields the platform's own contacts, not a prospect
    saveRes.run({ ...base, company: row.domain, status: 'skipped_platform', note: 'platform/aggregator — not a prospect' });
    return;
  }
  const domain = row.domain;
  // website: homepage + fallback contact/about/footer pages. social-scrapable: just the profile page.
  let r = extract(await fetchText(row.source_url), domain);
  if (row.type === 'website' && r.emails.length === 0 && r.phones.length === 0) {
    let origin = ''; try { origin = new URL(row.source_url).origin; } catch {}
    for (const p of CONTACT_PATHS) {
      await sleep(REQ_DELAY * Math.random());
      const r2 = extract(await fetchText(origin + p), domain);
      if (r2.emails.length || r2.phones.length) { r = { ...r2, title: r.title || r2.title, name: r.name || r2.name, company: r.company || r2.company }; break; }
    }
  }
  const has = r.emails.length || r.phones.length;
  saveRes.run({ ...base, name: r.name, company: r.company || domain, title: r.title,
    emails: r.emails.join(', '), phones: r.phones.join(', '), socials: JSON.stringify(r.socials),
    status: has ? 'ok' : 'no_contact' });
}

// ---------- ingest rows from browser ----------
// rows: [{ source_url, target_url, anchor, ascore }]
function ingest(rows) {
  let added = 0;
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      const url = normUrl(row.source_url);
      if (!url) continue;
      const host = hostOf(url);
      if (!host) continue;
      const type = sourceType(host);
      const multi = MULTI_USER_HOSTS.has(host); // link-in-bio: one lead per user path, not per domain
      const key = (type === 'website' && !multi) ? host : url; // dedupe websites by domain, socials/bio by profile
      const comp = competitorOf(row.target_url) || competitorOf(url) || 'unknown';
      const existing = getRow.get(key);
      if (existing) {
        const set = new Set((existing.links_to || '').split(',').map(s => s.trim()).filter(Boolean));
        set.add(comp);
        addLink.run([...set].join(', '), key);
      } else {
        insertSrc.run({ key, source_url: (type === 'website' && !multi) ? `https://${host}/` : url,
          domain: host, type, links_to: comp, anchor: (row.anchor || '').slice(0, 300),
          ascore: Number(row.ascore) || 0, ts: Date.now() });
        added++;
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return added;
}

// ---------- enrichment run + SSE ----------
let running = false;
const clients = new Set();
function broadcast(obj) {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of clients) { try { res.write(line); } catch {} }
}
async function runEnrichment() {
  if (running) return;
  running = true;
  const todo = pending.all();
  const total = todo.length;
  broadcast({ type: 'start', total });
  let done = 0, i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const row = todo[i++];
      try { await enrich(row); }
      catch (e) { saveRes.run({ key: row.key, name: '', company: '', title: '', emails: '',
        phones: '', socials: '{}', status: 'error', note: String(e).slice(0, 120), ts: Date.now() }); }
      done++;
      const saved = db.prepare(`SELECT * FROM sources WHERE key=?`).get(row.key);
      broadcast({ type: 'row', done, total, row: withSignals(saved) });
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  running = false;
  broadcast({ type: 'done', done, total });
}

// ---------- google maps job control + routes ----------
// returns { ok, running?, capped? } — refuses when the cap is already reached
function startGmapsJob(jobId) {
  if (gmapsRunning.has(jobId)) return { ok: true, running: true };
  if (gmapsRunning.size >= GMAPS_MAX_CONCURRENT) return { ok: false, capped: true };
  gmapsRunning.add(jobId); gmapsStop.delete(jobId);
  runJob(G, jobId, {
    runCell: provider.runCell,
    enrichDeps: { fetchText, extract },
    cfg: gScoreCfg,
    broadcast,
    shouldStop: () => gmapsStop.has(jobId),
  }).catch(e => {
    G.setJobStatus.run({ id: jobId, status: 'error', completed_at: Date.now() });
    broadcast({ type: 'gmaps_error', job_id: jobId, error: String(e).slice(0, 200) });
  }).finally(() => gmapsRunning.delete(jobId));
  return { ok: true };
}

async function handleGmaps(req, res, url) {
  const p = url.pathname;
  const m = p.match(/^\/api\/gmaps\/jobs\/(\d+)(\/start|\/stop)?$/);

  // Laya typed decision for one lead. Gated: refused while a scrape runs, because
  // the model (~1.5GB) would fight the scraper for RAM on the 8GB host.
  const md = p.match(/^\/api\/gmaps\/leads\/(.+)\/decide$/);
  if (md && req.method === 'POST') {
    if (gmapsRunning.size > 0) return send(res, 409, 'application/json', JSON.stringify({ error: 'scrape jobs running; run Laya decisions when idle' }));
    const lead = G.getLead.get(decodeURIComponent(md[1]));
    if (!lead) return send(res, 404, 'application/json', JSON.stringify({ error: 'no such lead' }));
    try {
      const decision = await layaDecide({
        name: lead.name, category: lead.category, locality: lead.locality,
        description: lead.description, services: lead.services_json,
        rating: lead.rating, review_count: lead.review_count,
        has_website: lead.has_website, has_booking: lead.has_booking,
      });
      return send(res, 200, 'application/json', JSON.stringify({ key: lead.key, decision }));
    } catch (e) {
      return send(res, 502, 'application/json', JSON.stringify({ error: 'laya service unavailable', detail: String(e.message || e) }));
    }
  }

  // step-3 backfill: (re)grade stored leads. Pure CPU, no scrape/model needed;
  // safe to run anytime. Optional ?job_id= limits to one job, else all leads.
  if (req.method === 'POST' && p === '/api/gmaps/grade-all') {
    const jid = Number(url.searchParams.get('job_id')) || 0;
    const rows = jid ? G.leadsByJob.all(jid) : G.allLeads.all();
    let n = 0;
    for (const row of rows) { G.updateGrade.run({ key: row.key, ...gradeLead(row) }); n++; }
    return send(res, 200, 'application/json', JSON.stringify({ graded: n, scope: jid ? `job ${jid}` : 'all' }));
  }

  if (req.method === 'POST' && p === '/api/gmaps/jobs') {
    const { city, areas, queries, cap } = JSON.parse((await readBody(req)) || '{}');
    const A = (areas || []).map(s => String(s).trim()).filter(Boolean);
    const Q = (queries || []).map(s => String(s).trim()).filter(Boolean);
    if (!A.length || !Q.length) return send(res, 400, 'application/json', JSON.stringify({ error: 'need at least one area and one query' }));
    const jobId = createJob(G, { city: String(city || '').trim(), areas: A, queries: Q, cap: Number(cap) || 60 });
    const started = startGmapsJob(jobId);
    return send(res, 200, 'application/json', JSON.stringify({ job_id: jobId, total_cells: A.length * Q.length,
      started: started.ok, queued: !started.ok, note: started.ok ? undefined : `max ${GMAPS_MAX_CONCURRENT} jobs running; job queued — start it when one finishes` }));
  }
  if (req.method === 'GET' && p === '/api/gmaps/jobs') {
    return send(res, 200, 'application/json', JSON.stringify({ jobs: G.listJobs.all(), running: [...gmapsRunning] }));
  }
  if (m && req.method === 'POST' && m[2] === '/start') {
    const r = startGmapsJob(Number(m[1]));
    if (!r.ok) return send(res, 409, 'application/json', JSON.stringify({ error: `max ${GMAPS_MAX_CONCURRENT} concurrent jobs already running`, running: [...gmapsRunning] }));
    return send(res, 200, 'application/json', JSON.stringify({ running: true }));
  }
  if (m && req.method === 'POST' && m[2] === '/stop')  { gmapsStop.add(Number(m[1])); return send(res, 200, 'application/json', JSON.stringify({ stopping: true })); }
  if (m && req.method === 'GET' && !m[2]) {
    const id = Number(m[1]); const job = G.getJob.get(id);
    if (!job) return send(res, 404, 'application/json', JSON.stringify({ error: 'no such job' }));
    return send(res, 200, 'application/json', JSON.stringify({ job, coverage: coverageReport(G, id), searches: G.allSearches.all(id), running: gmapsRunning.has(id) }));
  }
  // dashboard aggregates — grade/priority/eligible distributions + per-job summary
  if (req.method === 'GET' && p === '/api/gmaps/stats') {
    const grp = (col) => db.prepare(`SELECT ${col} k, COUNT(*) n FROM gmaps_leads GROUP BY ${col}`).all()
      .reduce((o, r) => (o[r.k || '?'] = r.n, o), {});
    const total = db.prepare('SELECT COUNT(*) n FROM gmaps_leads').get().n;
    const cats = db.prepare('SELECT category k, COUNT(*) n FROM gmaps_leads GROUP BY category ORDER BY n DESC LIMIT 12').all();
    const jobs = G.listJobs.all().map(j => {
      let label = ''; try { label = (JSON.parse(j.params_json).queries || [])[0] || ''; } catch { /* */ }
      return { id: j.id, label, city: j.city, status: j.status, done: j.done_cells,
        total: j.total_cells, uniq: j.unique_leads, errors: j.errors };
    });
    return send(res, 200, 'application/json', JSON.stringify({
      total, grade: grp('grade'), priority: grp('priority'), eligible: grp('marketing_eligible'),
      top_categories: cats, jobs, running: [...gmapsRunning],
    }));
  }

  // filterable, server-side paged leads (grade/priority/job/search), best fit first
  if (req.method === 'GET' && p === '/api/gmaps/leads') {
    const args = {};
    const where = [];
    const jid = Number(url.searchParams.get('job_id')) || 0;
    if (jid) { where.push('job_id=@jid'); args.jid = jid; }
    const grade = url.searchParams.get('grade'); if (grade) { where.push('grade=@grade'); args.grade = grade; }
    const priority = url.searchParams.get('priority'); if (priority) { where.push('priority=@priority'); args.priority = priority; }
    const qs = (url.searchParams.get('q') || '').trim();
    if (qs) { where.push('(name LIKE @q OR category LIKE @q OR locality LIKE @q OR phone LIKE @q OR email LIKE @q)'); args.q = '%' + qs + '%'; }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const limit = Math.min(2000, Number(url.searchParams.get('limit')) || 500);
    const offset = Number(url.searchParams.get('offset')) || 0;
    const rows = db.prepare(`SELECT * FROM gmaps_leads ${w} ORDER BY fit_score DESC, score DESC LIMIT @limit OFFSET @offset`)
      .all({ ...args, limit, offset });
    const total = db.prepare(`SELECT COUNT(*) n FROM gmaps_leads ${w}`).get(args).n;
    return send(res, 200, 'application/json', JSON.stringify({ rows, total }));
  }
  if (req.method === 'GET' && (p === '/api/gmaps/export.csv' || p === '/api/gmaps/export.json')) {
    const jid = Number(url.searchParams.get('job_id')) || 0;
    const raw = url.searchParams.get('raw') === '1';
    const rows = jid ? G.leadsByJob.all(jid) : G.allLeads.all();
    if (p.endsWith('.csv')) {
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="gmaps-leads.csv"' });
      return res.end(gexport.toCSV(rows, raw));
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="gmaps-leads.json"' });
    return res.end(gexport.toJSON(rows, raw));
  }
  return send(res, 404, 'application/json', JSON.stringify({ error: 'unknown gmaps route' }));
}

// ---------- csv/json export ----------
// outreach-ready order: score + primary contact + why up front, then supporting fields
const COLS = ['score','primary_email','email_tier','name','company','domain','intent','why','links_to',
  'anchor','ascore','emails','phones','socials','title','type','status','is_platform','source_url'];
function toCSV() {
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = scoredRows();
  return COLS.join(',') + '\n' + rows.map(r => COLS.map(c => esc(r[c])).join(',')).join('\n');
}

// ---------- http ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''; req.on('data', c => { data += c; if (data.length > 60_000_000) req.destroy(); });
    req.on('end', () => resolve(data)); req.on('error', reject);
  });
}
const send = (res, code, type, body) => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };

function listsIndex(LISTS) {
  let items = [];
  try {
    for (const name of fs.readdirSync(LISTS)) {
      const dir = path.join(LISTS, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.csv')) continue;
        const period = f.slice(0, -4);
        const rows = parseCSV(fs.readFileSync(path.join(dir, f), 'utf8')).length;
        items.push({ name, period, rows });
      }
    }
  } catch { /* no lists dir yet */ }
  items.sort((a, b) => a.name.localeCompare(b.name) || b.period.localeCompare(a.period));
  const li = items.map(i => `<li><a href="/admin/lists/${i.name}/${i.period}">${i.name} / ${i.period}</a> <small>${i.rows} leads · <a href="/admin/lists/${i.name}/${i.period}.csv">CSV</a></small></li>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>Lead lists</title>
<style>body{font:14px system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#1a1a18}
a{color:#2f6f4f;text-decoration:none}a:hover{text-decoration:underline}small{color:#77776f}
li{margin:6px 0}h1{font-size:18px}@media(prefers-color-scheme:dark){body{background:#17170f;color:#ececdf}}</style>
<h1>Lead lists</h1><ul>${li || '<li><small>no lists yet — add lists/&lt;name&gt;/&lt;period&gt;.csv</small></li>'}</ul>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    }
    if (req.method === 'POST' && url.pathname === '/api/ingest') {
      const { rows } = JSON.parse(await readBody(req));
      const added = ingest(rows || []);
      const counts = db.prepare(`SELECT COUNT(*) total, SUM(status='pending') pending FROM sources`).get();
      return send(res, 200, 'application/json', JSON.stringify({ added, ...counts }));
    }
    if (req.method === 'POST' && url.pathname === '/api/start') {
      runEnrichment(); // fire and forget; progress via SSE
      return send(res, 200, 'application/json', JSON.stringify({ running: true }));
    }
    if (req.method === 'GET' && url.pathname === '/api/rows') {
      return send(res, 200, 'application/json', JSON.stringify({ rows: scoredRows(), running }));
    }
    if (req.method === 'GET' && url.pathname === '/api/progress') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      res.write('retry: 3000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/export.csv') {
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="leads.csv"' });
      return res.end(toCSV());
    }
    if (req.method === 'GET' && url.pathname === '/api/export.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="leads.json"' });
      return res.end(JSON.stringify(scoredRows(), null, 2));
    }
    if (req.method === 'POST' && url.pathname === '/api/reset') {
      db.exec('DELETE FROM sources');
      return send(res, 200, 'application/json', JSON.stringify({ ok: true }));
    }

    if (url.pathname.startsWith('/api/gmaps/')) return handleGmaps(req, res, url);

    // ---- saved lists admin: /admin/lists , /admin/lists/<name>/<period>[.csv] ----
    if (req.method === 'GET' && url.pathname.startsWith('/admin/lists')) {
      const LISTS = path.join(__dirname, 'lists');
      const SAFE = /^[a-z0-9][a-z0-9-]*$/i;              // no dots/slashes -> no path traversal
      const rest = url.pathname.slice('/admin/lists'.length).replace(/^\/+|\/+$/g, '');
      if (!rest) return send(res, 200, 'text/html; charset=utf-8', listsIndex(LISTS));
      const wantCsv = rest.endsWith('.csv');
      const parts = (wantCsv ? rest.slice(0, -4) : rest).split('/');
      if (parts.length !== 2 || !parts.every(p => SAFE.test(p))) return send(res, 404, 'text/plain', 'bad list path');
      const [name, period] = parts;
      const file = path.join(LISTS, name, period + '.csv');
      if (!fs.existsSync(file)) return send(res, 404, 'text/plain', 'list not found');
      if (wantCsv) {
        res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="${name}-${period}.csv"` });
        return res.end(fs.readFileSync(file));
      }
      const rows = parseCSV(fs.readFileSync(file, 'utf8'));
      const html = renderAdminHTML(rows, { title: `${name} · ${period}`, subtitle: `${name} / ${period} — ${rows.length} leads`,
        listsHref: '/admin/lists', csvHref: `/admin/lists/${name}/${period}.csv` });
      return send(res, 200, 'text/html; charset=utf-8', html);
    }

    send(res, 404, 'text/plain', 'not found');
  } catch (e) {
    send(res, 500, 'application/json', JSON.stringify({ error: String(e) }));
  }
});
export { deriveSignals, classifyEmail, pickPrimary, isPlatform, intentOf, fetchText, extract };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => console.log(`Lead Enricher → http://localhost:${PORT}`));
}
