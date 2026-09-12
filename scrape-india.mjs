// Scrape each Topmate source domain for contacts + India signals.
// Reuses fetchText/extract/pickPrimary from server.mjs. Resumable: appends one
// JSON line per domain to topmate_india_leads.ndjson; re-running skips done ones.
//
// Usage: node scrape-india.mjs [sources.csv]

import fs from 'node:fs';
import { fetchText, extract, pickPrimary } from './server.mjs';

const IN = process.argv[2] || 'topmate_sources.csv';
const NDJSON = 'topmate_india_leads.ndjson';
const CONC = 20;
const CAP_MS = 8000;
const HTML_CAP = 150_000; // slice before any regex -> bounds ReDoS worst case
const CONTACT = ['/contact', '/contact-us', '/about', '/about-us'];
const SKIP_HOSTS = ['linkedin.com','instagram.com','facebook.com','twitter.com','x.com','youtube.com','t.me','pinterest.com','reddit.com','medium.com'];

// ---------- India signal detection ----------
const CITY_RE = /\b(mumbai|delhi|new delhi|bengaluru|bangalore|hyderabad|chennai|kolkata|pune|ahmedabad|surat|jaipur|lucknow|kanpur|nagpur|indore|thane|bhopal|visakhapatnam|patna|vadodara|ghaziabad|noida|gurugram|gurgaon|faridabad|coimbatore|kochi|cochin|chandigarh|mysuru|mysore|trivandrum|thiruvananthapuram|guwahati|dehradun|nashik|rajkot|vijayawada|madurai|maharashtra|karnataka|kerala|tamil nadu|telangana|gujarat|rajasthan|punjab|haryana|uttar pradesh|madhya pradesh|west bengal|bihar|odisha|assam|jharkhand|uttarakhand)\b/i;
const GSTIN_RE = /\b\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z\d]Z[A-Z\d]\b/;
const PHONE91_RE = /(?:\+?91[\-\s]?\d{5}[\-\s]?\d{5}|tel:\+?91)/i;

function indiaSignals(html, domain, phonesCsv) {
  const h = (html || '').slice(0, HTML_CAP);
  const sig = [];
  // strong
  if (/\.(in|co\.in|org\.in|net\.in|ac\.in|gov\.in|edu\.in)$/i.test(domain)) sig.push('tld_in');
  if (PHONE91_RE.test(h) || /\+?91[\-\s]?\d{5}/.test(phonesCsv || '')) sig.push('phone_+91');
  if (GSTIN_RE.test(h)) sig.push('gstin');
  if (/"addresscountry"\s*:\s*"?(IN|india)"?/i.test(h) || /geo\.region"?\s*content=["']?IN/i.test(h)) sig.push('geo_IN');
  if (/asia\/kolkata|asia\/calcutta/i.test(h)) sig.push('tz_kolkata');
  if (/(?:wa\.me|whatsapp[^"']{0,40}phone=)\/?\+?91/i.test(h)) sig.push('wa_91');
  // medium
  if (/₹|&#8377;|&#x20b9;|\bINR\b|\bRs\.?\s?\d/i.test(h)) sig.push('rupee');
  if (CITY_RE.test(h)) sig.push('india_city');
  if (/["' ]en[-_]IN\b|hreflang=["']?en-in/i.test(h)) sig.push('en_IN');

  const STRONG = new Set(['tld_in','phone_+91','gstin','geo_IN','tz_kolkata','wa_91']);
  const strong = sig.filter(s => STRONG.has(s)).length;
  const medium = sig.length - strong;
  let verdict = 'no';
  if (strong >= 1 || medium >= 2) verdict = 'yes';
  else if (medium === 1) verdict = 'maybe';
  return { india: verdict, india_signals: sig.join('|') };
}

const hostOf = (u) => { try { return new URL(u.startsWith('http') ? u : 'https://' + u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const isSkip = (h) => SKIP_HOSTS.some(s => h === s || h.endsWith('.' + s));
const fetchCapped = (u) => Promise.race([fetchText(u), new Promise(r => setTimeout(() => r(null), CAP_MS))]);

async function scrape(rec) {
  const dom = rec.domain;
  const out = { ...rec, name: '', company: '', title: '', emails: '', phones: '', socials: '{}',
    primary_email: '', email_tier: 'none', india: 'no', india_signals: '', scrape_status: '' };
  if (isSkip(dom)) { out.scrape_status = 'social_source'; Object.assign(out, indiaSignals('', dom, '')); return out; }

  const url = rec.source_url && rec.source_url.startsWith('http') ? rec.source_url : 'https://' + dom + '/';
  const origin = (() => { try { return new URL(url).origin; } catch { return 'https://' + dom; } })();
  let html = await fetchCapped(url);
  if (!html && url !== origin) html = await fetchCapped(origin);
  if (!html) { out.scrape_status = 'error'; Object.assign(out, indiaSignals('', dom, '')); return out; }

  let r = extract(html.slice(0, HTML_CAP), dom);
  let allHtml = html;
  if (!r.emails.length) {
    for (const p of CONTACT) {
      const h2 = await fetchCapped(origin + p);
      if (!h2) continue;
      allHtml += ' ' + h2;
      const r2 = extract(h2.slice(0, HTML_CAP), dom);
      r.emails = [...new Set([...r.emails, ...r2.emails])];
      r.phones = [...new Set([...r.phones, ...r2.phones])];
      for (const [k, v] of Object.entries(r2.socials)) r.socials[k] = [...new Set([...(r.socials[k] || []), ...v])].slice(0, 3);
      if (!r.name && r2.name) r.name = r2.name;
      if (r2.emails.length) break;
    }
  }
  out.name = r.name; out.company = r.company; out.title = r.title;
  out.emails = r.emails.join(', '); out.phones = r.phones.join(', ');
  out.socials = JSON.stringify(r.socials);
  const pick = pickPrimary(r.emails.join(', '), dom);
  out.primary_email = pick.email; out.email_tier = pick.tier;
  out.scrape_status = r.emails.length ? 'ok' : (r.phones.length ? 'ok' : 'no_contact');
  Object.assign(out, indiaSignals(allHtml, dom, out.phones));
  return out;
}

// ---------- CSV parse ----------
function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (q) { if (c === '"' && text[i+1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c === '\r') {}
    else cell += c; }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  const hdr = rows.shift();
  return rows.filter(r => r.some(x => x && x.trim())).map(r => Object.fromEntries(hdr.map((h, i) => [h, r[i] ?? ''])));
}

// ---------- run (resumable) ----------
const all = parseCSV(fs.readFileSync(IN, 'utf8'));
const done = new Set();
if (fs.existsSync(NDJSON)) {
  for (const line of fs.readFileSync(NDJSON, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { done.add(JSON.parse(line).domain); } catch {}
  }
}
const todo = all.filter(r => !done.has(r.domain));
console.log(`${all.length} domains, ${done.size} already done, ${todo.length} to scrape`);

const ws = fs.createWriteStream(NDJSON, { flags: 'a' });
let n = 0, idx = 0; const T0 = Date.now();
async function worker() {
  while (idx < todo.length) {
    const rec = todo[idx++];
    let res;
    try { res = await scrape(rec); }
    catch (e) { res = { ...rec, scrape_status: 'crash:' + String(e).slice(0, 50), india: 'no', india_signals: '' }; }
    ws.write(JSON.stringify(res) + '\n');
    n++;
    if (n % 25 === 0 || n === todo.length) console.log(`  ${n}/${todo.length}  (${Math.round((Date.now()-T0)/1000)}s)`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
ws.end();
console.log('scrape complete');
