import fs from 'node:fs';

const SRC = process.argv[2] || 'india_leads_YES.csv';
const OUT = process.argv[3] || 'import.csv';

// --- RFC-4180 parse ---
function parseCSV(s) {
  const rows = []; let f = '', row = [], q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else {
      if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
      else if (c === '\r') { /* skip */ }
      else f += c;
    }
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows;
}

// --- RFC-4180 emit ---
const esc = v => {
  v = (v ?? '').toString();
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
};

const decode = s => (s || '')
  .replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&nbsp;/g, ' ').trim();

// digits + country code; IN 10-digit -> 91xxxxxxxxxx
const normPhone = raw => {
  let d = (raw || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 10) d = '91' + d;
  else if (d.length === 11 && d[0] === '0') d = '91' + d.slice(1);
  if (d.length < 10 || d.length > 15) return ''; // ponytail: drop junk; widen if non-IN sources added
  return d;
};

const firstOf = s => (s || '').split(/[|,;]+/).map(x => x.trim()).filter(Boolean)[0] || '';
const httpsify = u => { u = (u || '').trim(); if (!u) return ''; return /^https?:\/\//i.test(u) ? u : 'https://' + u.replace(/^\/+/, ''); };

const normDom = d => (d || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*/, '').trim();
const normLi = u => (u || '').toLowerCase().replace(/\/+$/, '').replace(/^https?:\/\/(www\.)?/, '');

// --- donor index: domain|linkedin -> contacts, from other sources ---
const DONORS = ['leads.csv', 'linkedin_topmate_enriched.csv'];
const donorByDom = new Map(), donorByLi = new Map();
for (const fn of DONORS) {
  if (!fs.existsSync(fn)) continue;
  const R = parseCSV(fs.readFileSync(fn, 'utf8')); const h = R[0]; const c = n => h.indexOf(n);
  const g = (r, n) => { const i = c(n); return i < 0 ? '' : (r[i] || '').trim(); };
  // generic platform hosts: a donor "contact" on these is the platform's, not the person's
  const PLATFORM = new Set(['producthunt.com', 'medium.com', 'topmate.io', 'notion.so', 'linktr.ee', 'calendly.com', 'substack.com', 'github.com']);
  for (const r of R.slice(1)) {
    let email = (g(r, 'primary_email') || firstOf(g(r, 'emails')) || firstOf(g(r, 'discovered_emails'))).toLowerCase();
    if (email && PLATFORM.has(email.split('@')[1])) email = '';
    let soc = {}; try { soc = JSON.parse(g(r, 'socials') || g(r, 'all_socials') || '{}'); } catch { }
    const s1 = k => Array.isArray(soc[k]) ? (soc[k][0] || '') : '';
    let phone = normPhone(firstOf(g(r, 'phones') || g(r, 'discovered_phones')));
    let whatsapp = normPhone((s1('wa').match(/(\d[\d]{6,})/) || [])[1] || '');
    if (!phone && whatsapp) { phone = whatsapp; whatsapp = ''; }
    if (!email && !phone) continue;
    const e = { email, phone, whatsapp: whatsapp === phone ? '' : whatsapp, linkedin: s1('linkedin'), instagram: s1('instagram'), twitter: s1('twitter') || s1('x') };
    const d = normDom(g(r, 'domain')); if (d && !donorByDom.has(d)) donorByDom.set(d, e);
    const li = normLi(g(r, 'linkedin_profile') || s1('linkedin')); if (li && !donorByLi.has(li)) donorByLi.set(li, e);
  }
}

const rows = parseCSV(fs.readFileSync(SRC, 'utf8'));
const H = rows[0]; const col = n => H.indexOf(n);
const get = (r, n) => { const i = col(n); return i < 0 ? '' : (r[i] || '').trim(); };

const seenEmail = new Set(), seenPhone = new Set();
const out = [['name', 'email', 'phone', 'whatsapp', 'business', 'profession', 'website', 'linkedin', 'instagram', 'twitter', 'city', 'tags']];
let dropped = 0, dupes = 0, recoveredN = 0;

for (const r of rows.slice(1)) {
  if (!r.length || r.every(x => !x)) continue;

  const name = decode(get(r, 'name') || get(r, 'tm_name'));
  let email = (get(r, 'primary_email') || firstOf(get(r, 'discovered_emails'))).toLowerCase();

  // socials JSON
  let soc = {};
  try { soc = JSON.parse(get(r, 'all_socials') || '{}'); } catch { }
  const s1 = k => Array.isArray(soc[k]) ? (soc[k][0] || '') : '';

  let phone = normPhone(firstOf(get(r, 'discovered_phones')));
  // wa.me number -> whatsapp
  let whatsapp = normPhone((s1('wa').match(/(\d[\d]{6,})/) || [])[1] || '');
  if (!phone && whatsapp) { phone = whatsapp; whatsapp = ''; }
  if (whatsapp && whatsapp === phone) whatsapp = '';

  // --- recover no-contact rows from donor sources ---
  let recovered = false, donorSoc = null;
  let emailV = email;
  if (!emailV && !phone) {
    const rowDom = normDom(get(r, 'domain'));
    const li = donorByLi.get(normLi(get(r, 'linkedin_profile'))); // identity match: trust
    let d = donorByDom.get(rowDom);
    // domain match only trusted when donor email is on the same domain, or it has a phone
    if (d && !(d.phone || (d.email && d.email.split('@')[1] === rowDom))) d = null;
    const hit = li || d;
    if (hit) {
      emailV = hit.email; phone = hit.phone; whatsapp = hit.whatsapp;
      donorSoc = hit; recovered = true; recoveredN++;
    }
  }
  email = emailV;

  if (!email && !phone) { dropped++; continue; }
  if (email && seenEmail.has(email)) { dupes++; continue; }
  if (!email && phone && seenPhone.has(phone)) { dupes++; continue; }
  if (email) seenEmail.add(email);
  if (phone) seenPhone.add(phone);

  const linkedin = httpsify(get(r, 'linkedin_profile') || s1('linkedin') || (donorSoc && donorSoc.linkedin));
  const instagram = httpsify(s1('instagram') || (donorSoc && donorSoc.instagram));
  const twitter = httpsify(s1('twitter') || s1('x') || (donorSoc && donorSoc.twitter));

  const tags = ['india',
    (get(r, 'grade') && 'grade-' + get(r, 'grade')),
    get(r, 'email_tier'),
    (recovered && 'recovered')]
    .filter(Boolean).join('|');

  out.push([
    name, email, phone, whatsapp,
    decode(get(r, 'company')), '', // profession: not in source
    httpsify(get(r, 'website')),
    linkedin, instagram, twitter,
    '', // city: not in source
    tags,
  ]);
}

// --- dedupe recovered rows against non-recovered by identity (domain / linkedin) ---
const isRec = r => (r[11] || '').includes('recovered');
const dom = u => (u || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*/, '');
const li = u => (u || '').toLowerCase().replace(/\/+$/, '').replace(/^https?:\/\/(www\.)?/, '');
const body = out.slice(1);
const keepDom = new Set(body.filter(r => !isRec(r)).map(r => dom(r[6])).filter(Boolean));
const keepLi = new Set(body.filter(r => !isRec(r)).map(r => li(r[7])).filter(Boolean));
let idDupes = 0;
const deduped = body.filter(r => {
  if (!isRec(r)) return true;
  if ((dom(r[6]) && keepDom.has(dom(r[6]))) || (li(r[7]) && keepLi.has(li(r[7])))) { idDupes++; return false; }
  return true;
});
const final = [out[0], ...deduped];
if (idDupes) console.log(`removed ${idDupes} recovered rows duplicating existing by domain/linkedin`);

fs.writeFileSync(OUT, final.map(r => r.map(esc).join(',')).join('\r\n') + '\r\n');
console.log(`wrote ${OUT}: ${final.length - 1} rows | recovered from donors ${recoveredN} | dropped(no contact) ${dropped} | dupes ${dupes}`);

// --- self-check ---
import assert from 'node:assert';
assert.equal(normPhone('9876543210'), '919876543210');
assert.equal(normPhone('09876543210'), '919876543210');
assert.equal(normPhone('+91 98765 43210'), '919876543210');
assert.equal(esc('a,b'), '"a,b"');
assert.equal(esc('he said "hi"'), '"he said ""hi"""');
assert.equal(decode('Let&#x27;s &amp; Co'), "Let's & Co");
assert.equal(httpsify('foo.com'), 'https://foo.com');
const re = parseCSV('a,"b,c","d""e"\n1,2,3');
assert.deepEqual(re[0], ['a', 'b,c', 'd"e']);
console.log('self-check ok');
