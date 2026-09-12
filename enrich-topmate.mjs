// Enrich the linkedin_topmate mapping by scraping each public Topmate profile.
// Topmate profiles are static SSR HTML that self-declare the person's website,
// linkedin, and other socials — so they verify the linkedin↔topmate pair AND
// point us at the personal site, which we then scrape for email/phone.
//
// Usage: node enrich-topmate.mjs [input.csv] [output.csv]
// Reuses fetchText + extract from server.mjs (no listen — guarded there).

import fs from 'node:fs';
import path from 'node:path';
import { fetchText, extract, pickPrimary } from './server.mjs';

const IN  = process.argv[2] || 'linkedin_topmate.csv';
const OUT = process.argv[3] || 'linkedin_topmate_enriched.csv';
const CONC = 24;
const FETCH_CAP_MS = 8000; // hard cap so one slow site can't stall a worker

// hosts that are socials, not a scrapeable "website"
const SOCIAL_HOSTS = ['linkedin.com','twitter.com','x.com','instagram.com','facebook.com',
  'youtube.com','youtu.be','tiktok.com','threads.net','pinterest.com','t.me','telegram.me',
  'wa.me','whatsapp.com','discord.gg','discord.com','snapchat.com'];
const IGNORE = /schema\.org|w3\.org|googleapis|gstatic|cloudfront|amazonaws|sentry|clarity\.ms|facebook\.net|google\.com|googletagmanager|doubleclick|facebook\.com\/tr|\.(png|jpe?g|svg|gif|webp|css|js|ico|woff2?)(\?|$)/i;

// shared platform profile roots: worth listing, but don't scrape them for email
// (they leak the platform's own corporate addresses, not the person's).
const SHARED_ROOTS = ['substack.com','github.com','medium.com','stackoverflow.com','stackexchange.com',
  'dev.to','reddit.com','producthunt.com','notion.so','quora.com','hashnode.com','gitlab.com','behance.net','dribbble.com'];
// email domains that are a platform's own inbox, never the lead's
const EMAIL_BLOCK = ['substackinc.com','github.com','wordpress.com','automattic.com','stackoverflow.com',
  'stackexchange.com','medium.com','wixpress.com','sentry.io','googlegroups.com','example.com','producthunt.com','sentry-next.wixpress.com'];
// topmate's own footer handles that appear on every profile
const BRAND_HANDLES = ['topmatehq','topmate','wordpresscom','officialstackoverflow','stackoverflow','stackoverflowofficial'];

// ---------- tiny CSV parser/writer (handles quoted fields) ----------
function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i+1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c === '\r') { /* skip */ }
    else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  const hdr = rows.shift();
  return rows.filter(r => r.length > 1 || (r[0] && r[0].trim())).map(r => Object.fromEntries(hdr.map((h, i) => [h, r[i] ?? ''])));
}
const esc = (v) => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
function writeCSV(file, cols, rows) {
  const out = [cols.join(',')];
  for (const r of rows) out.push(cols.map(c => esc(r[c])).join(','));
  fs.writeFileSync(file, out.join('\n'), 'utf8');
}

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const liSlug = (u) => (String(u).match(/\/in\/([^/?#]+)/i)?.[1] || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const isSocial = (h) => SOCIAL_HOSTS.some(s => h === s || h.endsWith('.' + s));

// pull the person's own external links out of a topmate profile page
function parseTopmate(html) {
  const links = [...new Set((html.match(/https?:\/\/[^"'\\ )<>]+/gi) || []))]
    .map(u => u.replace(/&amp;.*$/, '').replace(/[.,)]+$/, ''))
    .filter(u => !/topmate\.io/i.test(u) && !IGNORE.test(u));
  const socials = {}, websites = [];
  let linkedin = '';
  const handleOf = (u) => (u.match(/(?:\/|@)([A-Za-z0-9_.-]+)\/?$/)?.[1] || '').toLowerCase();
  for (const u of links) {
    const h = hostOf(u);
    if (!h) continue;
    if (BRAND_HANDLES.includes(handleOf(u))) continue;               // topmate's own footer socials
    if (/linkedin\.com\/company\//i.test(u)) continue;                // company pages (incl. topmate)
    if (/linkedin\.com\/in\//i.test(u)) {
      if (!linkedin) linkedin = u.replace(/\/+$/, '');
      (socials.linkedin ||= []).push(u);
    } else if (isSocial(h)) {
      const key = h.replace(/\.(com|net|org|me|gg)$/, '').replace(/^(www\.)?/, '').replace('youtu','youtube').replace(/\./g, '_');
      (socials[key] ||= []).push(u);
    } else {
      websites.push(u);
    }
  }
  for (const k in socials) socials[k] = [...new Set(socials[k])].slice(0, 3);
  const name = extract(html, '').name || '';
  return { linkedin, socials, websites: [...new Set(websites)], name };
}

// bounded fetch: a slow host resolves null instead of blocking a worker
const fetchCapped = (url) => Promise.race([fetchText(url), new Promise(r => setTimeout(() => r(null), FETCH_CAP_MS))]);

// scrape a website homepage for emails/phones (homepage only — the /contact
// fallback was the run's bottleneck and yielded ~no extra emails).
async function scrapeSite(url) {
  const host = hostOf(url);
  const origin = (() => { try { return new URL(url).origin; } catch { return url.replace(/\/+$/, ''); } })();
  let html = await fetchCapped(url);
  if (!html && origin !== url) html = await fetchCapped(origin);
  if (!html) return { emails: [], phones: [], socials: {} };
  return extract(html, host);
}

async function enrichRow(row) {
  const tmUrl = row.topmate_profile;
  const out = { ...row, tm_status: '', tm_name: '', website: '', website_all: '',
    verified_linkedin: '', discovered_emails: '', discovered_phones: '', email_tier: '', all_socials: '' };
  const html = tmUrl ? await fetchCapped(tmUrl) : null;
  if (!html) { out.tm_status = tmUrl ? 'fetch_failed' : 'no_topmate'; return out; }
  out.tm_status = 'ok';

  const tm = parseTopmate(html);
  out.tm_name = tm.name;

  // verify / correct linkedin against what topmate self-declares
  const csvSlug = liSlug(row.linkedin_profile);
  const tmSlug = liSlug(tm.linkedin);
  if (tm.linkedin) {
    if (!csvSlug) out.verified_linkedin = 'topmate_only';
    else if (csvSlug === tmSlug) out.verified_linkedin = 'confirmed';
    else { out.verified_linkedin = 'mismatch->corrected'; out.linkedin_profile = tm.linkedin; }
  } else {
    out.verified_linkedin = csvSlug ? 'unconfirmed' : 'none';
  }

  // websites: a "personal" site is any external non-social host that isn't a
  // shared platform profile root. Those personal sites are the good email source.
  const isShared = (u) => SHARED_ROOTS.some(r => hostOf(u) === r || hostOf(u).endsWith('.' + r));
  const sites = tm.websites;
  const personal = sites.filter(u => !isShared(u));
  const csvDomainPersonal = row.domain && !SHARED_ROOTS.includes(row.domain) && !/hashnode\.com$/.test(row.domain);
  out.website_all = sites.join(', ');
  out.website = personal[0] || sites[0] || (csvDomainPersonal ? 'https://' + row.domain + '/' : '');

  // ponytail: website re-scrape disabled — the server's first pass already scraped
  // every domain's homepage+contact for email, so this found ~0 new and one
  // pathological page could ReDoS-freeze the event loop. Emails come from the
  // existing first-pass value; topmate gives us name/website/verified-LI/socials.
  const scrapeTargets = [];

  const emailSet = new Set(), phoneSet = new Set();
  for (const s of scrapeTargets) {
    const r = await scrapeSite(s);
    r.emails.forEach(e => emailSet.add(e));
    r.phones.forEach(p => phoneSet.add(p));
    for (const [k, v] of Object.entries(r.socials || {})) {
      const clean = v.filter(x => !BRAND_HANDLES.includes((x.match(/(?:\/|@)([A-Za-z0-9_.-]+)\/?$/)?.[1] || '').toLowerCase()));
      if (clean.length) tm.socials[k] = [...new Set([...(tm.socials[k] || []), ...clean])].slice(0, 3);
    }
  }
  if (row.primary_email) emailSet.add(row.primary_email);

  // drop platform corporate inboxes
  const emails = [...emailSet].filter(e => { const d = e.split('@')[1]?.toLowerCase() || ''; return !EMAIL_BLOCK.some(b => d === b || d.endsWith('.' + b)); });
  const primaryHost = hostOf(out.website) || row.domain;
  const pick = pickPrimary(emails.join(', '), primaryHost);
  out.discovered_emails = emails.join(', ');
  out.discovered_phones = [...phoneSet].join(', ');
  out.primary_email = pick.email || '';
  out.email_tier = pick.tier;
  out.all_socials = JSON.stringify(tm.socials);
  return out;
}

// ---------- run with a small concurrency pool ----------
const rows = parseCSV(fs.readFileSync(path.resolve(IN), 'utf8'));
console.log(`loaded ${rows.length} rows from ${IN}`);
const results = new Array(rows.length);
let done = 0, idx = 0; const T0 = Date.now();
async function worker() {
  while (idx < rows.length) {
    const i = idx++;
    try { results[i] = await enrichRow(rows[i]); }
    catch (e) { results[i] = { ...rows[i], tm_status: 'error:' + String(e).slice(0, 60) }; }
    done++;
    if (done % 10 === 0 || done === rows.length) console.log(`  enriched ${done}/${rows.length}  (${Math.round((Date.now()-T0)/1000)}s)`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
process.stdout.write('\n');

const EXTRA = ['india','india_signals','link_status'].filter(k => rows[0] && k in rows[0]);
const COLS = ['name','tm_name','linkedin_profile','topmate_profile','website','primary_email','email_tier',
  'discovered_emails','discovered_phones','verified_linkedin','confidence', ...EXTRA, 'company','domain',
  'ascore','all_socials','website_all','tm_status','linkedin_all','source_url'];
writeCSV(OUT, COLS, results);

// summary
const n = results.length;
const c = (f) => results.filter(f).length;
console.log(`\nwrote ${OUT}`);
console.log(`  topmate fetched ok : ${c(r => r.tm_status === 'ok')}/${n}`);
console.log(`  linkedin confirmed : ${c(r => r.verified_linkedin === 'confirmed')}`);
console.log(`  linkedin corrected : ${c(r => r.verified_linkedin === 'mismatch->corrected')}`);
console.log(`  website found      : ${c(r => r.website)}`);
console.log(`  has email          : ${c(r => r.primary_email)}  (was ${c(r => r.primary_email && rows.find(x=>x.topmate_profile===r.topmate_profile))})`);
console.log(`  NEW emails found   : ${c(r => r.primary_email) - rows.filter(r => r.primary_email).length}`);
