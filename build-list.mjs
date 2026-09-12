import fs from 'node:fs';
import assert from 'node:assert';

// ---------- CSV parse / emit (RFC-4180) ----------
function parseCSV(s) {
  const rows = []; let f = '', row = [], q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else { if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; } else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; } else if (c === '\r') { } else f += c; }
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const esc = v => { v = (v ?? '').toString(); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };

// ---------- normalizers ----------
const decode = s => (s || '').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim();
const normPhone = raw => {
  let d = (raw || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 10) d = '91' + d;
  else if (d.length === 11 && d[0] === '0') d = '91' + d.slice(1);
  if (d.length < 10 || d.length > 15) return '';
  return d;
};
const firstOf = s => (s || '').split(/[|,;\s]+/).map(x => x.trim()).filter(Boolean)[0] || '';
const httpsify = u => { u = (u || '').trim(); if (!u) return ''; return /^https?:\/\//i.test(u) ? u : 'https://' + u.replace(/^\/+/, ''); };
const domOf = u => (u || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*/, '').trim();
const liKey = u => (u || '').toLowerCase().replace(/\/+$/, '').replace(/^https?:\/\/(www\.)?/, '');
const PLATFORM_EMAIL = new Set(['producthunt.com', 'medium.com', 'topmate.io', 'setmore.com', 'notion.so', 'linktr.ee', 'calendly.com', 'substack.com', 'github.com']);
// scrape-artifact placeholder emails (example text baked into page templates)
const JUNK_EMAIL_HOST = new Set(['yourmail.com', 'example.com', 'example.org', 'email.com', 'domain.com', 'yourdomain.com', 'test.com', 'sample.com', 'sentry.io', 'wixpress.com']);
const JUNK_EMAIL_LOCAL = new Set(['johndoe', 'john.doe', 'jane.doe', 'name', 'your', 'yourname', 'email', 'user', 'username', 'firstname', 'no-reply', 'noreply', 'donotreply']);
const isJunkEmail = e => { if (!e) return true; const [l, h] = e.split('@'); return !h || JUNK_EMAIL_HOST.has(h) || JUNK_EMAIL_LOCAL.has(l); };
// Scrub scraper artefacts the source pages bake in: leaked >, >, &gt; prefixes;
// provider concat bugs (gmail.comviews -> gmail.com); and anything that isn't a real
// user@domain.tld. Returns '' when unusable (placeholder/junk-host filtering stays in
// isJunkEmail above). Protects cold-email deliverability — junk in = bounces.
const cleanEmail = raw => {
  let e = (raw || '').trim().toLowerCase().replace(/^(?:\\?u003e|&gt;|>)+/i, '').replace(/\s+/g, '');
  e = e.replace(/@(gmail|yahoo|outlook|hotmail|live|icloud|proton|ymail|rediffmail)\.com[a-z]+$/i, '@$1.com');
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,24}$/i.test(e) ? e : '';
};

// which competitor does this record point at?
const detectPlatform = blob => {
  const b = (blob || '').toLowerCase();
  if (b.includes('setmore')) return 'setmore';
  if (b.includes('topmate')) return 'topmate';
  return '';
};

// pull first social of a kind from a parsed socials object
const soc1 = (o, ...keys) => { for (const k of keys) if (Array.isArray(o[k]) && o[k][0]) return o[k][0]; return ''; };

// ---------- source readers -> array of raw lead objects ----------
function readCSV(fn, map) {
  if (!fs.existsSync(fn)) return [];
  const R = parseCSV(fs.readFileSync(fn, 'utf8')); const H = R[0]; const c = n => H.indexOf(n);
  const g = (r, n) => { const i = c(n); return i < 0 ? '' : (r[i] || '').trim(); };
  return R.slice(1).filter(r => r.some(x => x)).map(r => map(g.bind(null, r)));
}
function readNDJSON(fn) {
  if (!fs.existsSync(fn)) return [];
  return fs.readFileSync(fn, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// normalize any raw object with named accessors into the import shape
function shape({ name, email, emailsRaw, phonesRaw, waRaw, socialsRaw, linkedin, website, company, title, domain, grade, emailTier, platformBlob }) {
  let soc = {}; try { soc = typeof socialsRaw === 'object' && socialsRaw ? socialsRaw : JSON.parse(socialsRaw || '{}'); } catch { }
  let em = cleanEmail(email || firstOf(emailsRaw));   // strip artefacts + shape-validate first
  if (em && (PLATFORM_EMAIL.has(em.split('@')[1]) || isJunkEmail(em))) em = '';
  let phone = normPhone(firstOf(phonesRaw));
  let whatsapp = normPhone((String(waRaw || soc1(soc, 'wa')).match(/(\d[\d]{6,})/) || [])[1] || '');
  if (!phone && whatsapp) { phone = whatsapp; whatsapp = ''; }
  if (whatsapp && whatsapp === phone) whatsapp = '';
  const web = httpsify(website || (domain ? domain : ''));
  const platform = detectPlatform([platformBlob, website, domain, JSON.stringify(soc)].join(' '));
  const tags = [platform, grade && 'grade-' + grade, emailTier && emailTier !== 'none' && emailTier].filter(Boolean).join('|');
  return {
    name: decode(name), email: em, phone, whatsapp,
    business: decode(company), profession: '', // ponytail: no source has a real profession; page-title != profession
    website: web,
    linkedin: httpsify(linkedin || soc1(soc, 'linkedin')),
    instagram: httpsify(soc1(soc, 'instagram')),
    twitter: httpsify(soc1(soc, 'twitter', 'x')),
    city: '',
    tags, _dom: domOf(web || domain),
  };
}

// ---------- ingest all sources ----------
const raw = [];

// master crawl
for (const o of readNDJSON('topmate_india_leads.ndjson')) raw.push(shape({
  name: o.name, email: o.primary_email, emailsRaw: o.emails, phonesRaw: o.phones,
  socialsRaw: o.socials, website: '', company: o.company, title: o.title, domain: o.domain,
  emailTier: o.email_tier, platformBlob: [o.source_url, o.anchor, o.topmate_profiles].join(' '),
}));

// global leads.csv
for (const g of readCSV('leads.csv', g => g)) { }
raw.push(...readCSV('leads.csv', g => shape({
  name: g('name'), email: g('primary_email'), emailsRaw: g('emails'), phonesRaw: g('phones'),
  socialsRaw: g('socials'), company: g('company'), title: g('title'), domain: g('domain'),
  emailTier: g('email_tier'), platformBlob: [g('links_to'), g('source_url'), g('anchor'), g('intent')].join(' '),
})));

// India graded YES/MAYBE + enriched (discovered_* + all_socials + linkedin_profile + grade)
for (const fn of ['india_leads_graded.csv', 'linkedin_topmate_enriched.csv']) {
  raw.push(...readCSV(fn, g => shape({
    name: g('name') || g('tm_name'), email: g('primary_email'), emailsRaw: g('discovered_emails'),
    phonesRaw: g('discovered_phones'), socialsRaw: g('all_socials'), linkedin: g('linkedin_profile'),
    website: g('website'), company: g('company'), title: '', domain: g('domain'),
    grade: g('grade'), emailTier: g('email_tier'),
    platformBlob: [g('source_url'), g('topmate_profile'), g('website')].join(' '),
  })));
}

// ---------- merge-fill + dedup by email -> phone -> domain ----------
const byEmail = new Map(), byPhone = new Map(), byDom = new Map();
const list = [];
const better = (a, b) => { // fill empty fields of a from b; keep richer email/name
  for (const k of ['name', 'email', 'phone', 'whatsapp', 'business', 'profession', 'website', 'linkedin', 'instagram', 'twitter', 'tags']) {
    if (!a[k] && b[k]) a[k] = b[k];
  }
  // merge tags unique
  const t = new Set([...(a.tags ? a.tags.split('|') : []), ...(b.tags ? b.tags.split('|') : [])].filter(Boolean));
  a.tags = [...t].join('|');
};

for (const r of raw) {
  if (!r.email && !r.phone) continue;
  let hit = (r.email && byEmail.get(r.email)) || (r.phone && byPhone.get(r.phone))
    || (!r.email && !r.phone) || (r._dom && !r.email && !r.phone ? byDom.get(r._dom) : null);
  // domain-only merge when neither has an email (avoid merging different people on shared platform domains)
  if (!hit && r._dom && !r.email) hit = byDom.get(r._dom);
  if (hit) { better(hit, r); if (r.email) byEmail.set(r.email, hit); if (r.phone) byPhone.set(r.phone, hit); continue; }
  list.push(r);
  if (r.email) byEmail.set(r.email, r);
  if (r.phone) byPhone.set(r.phone, r);
  if (r._dom && !r.email) byDom.set(r._dom, r); // index platform-less domain rows only
}

// ---------- emit ----------
const COLS = ['name', 'email', 'phone', 'whatsapp', 'business', 'profession', 'website', 'linkedin', 'instagram', 'twitter', 'city', 'tags'];
const out = [COLS, ...list.map(r => COLS.map(k => r[k] || ''))];
const OUT = process.argv[2] || 'upload_list.csv';
fs.writeFileSync(OUT, out.map(r => r.map(esc).join(',')).join('\r\n') + '\r\n');

const withEmail = list.filter(r => r.email).length;
const withPhone = list.filter(r => r.phone).length;
const sm = list.filter(r => (r.tags || '').includes('setmore')).length;
const tm = list.filter(r => (r.tags || '').includes('topmate')).length;
console.log(`wrote ${OUT}: ${list.length} leads | email ${withEmail} | phone ${withPhone} | topmate-tagged ${tm} | setmore-tagged ${sm} | ingested ${raw.length} raw`);

// ---------- self-check ----------
assert.equal(normPhone('09876543210'), '919876543210');
assert.equal(firstOf('a@x.com | b@y.com'), 'a@x.com');
assert.equal(domOf('https://www.Foo.com/x'), 'foo.com');
assert.equal(detectPlatform('booked via aquayemi.setmore.com'), 'setmore');
assert.equal(detectPlatform('links to topmate.io/x'), 'topmate');
assert.equal(isJunkEmail('johndoe@yourmail.com'), true);
assert.equal(isJunkEmail('care@striacademy.com'), false);
assert.equal(cleanEmail('u003ehelp@skool.com'), 'help@skool.com');   // leaked > stripped
assert.equal(cleanEmail('x@gmail.comviews'), 'x@gmail.com');          // provider concat repaired
assert.equal(cleanEmail('no@atsign'), '');                            // no TLD -> dropped
assert.equal(cleanEmail('team@lets-code.co.in'), 'team@lets-code.co.in'); // multi-part TLD kept
assert.equal(cleanEmail('good@domain.io'), 'good@domain.io');
assert.deepEqual(parseCSV('a,"b,c"\n1,2')[0], ['a', 'b,c']);
// no duplicate emails in output
const emails = list.map(r => r.email).filter(Boolean);
assert.equal(emails.length, new Set(emails).size, 'duplicate emails leaked');
console.log('self-check ok');
