// Grade the enriched leads into A/B/C/D and write one CSV per grade + a combined
// graded file. Grades key on how reachable + how verified each lead is.
//
//   A  best     — verified LinkedIn + on-domain personal/role email + a website  → cold email first
//   B  emailable — verified LinkedIn + any email (gmail/off-domain)              → cold email, softer
//   C  linkedin  — verified LinkedIn, no email                                   → LinkedIn DM / InMail
//   D  review    — LinkedIn unverified OR low-confidence pair                    → verify before touching
//
// Usage: node grade-split.mjs [enriched.csv]

import fs from 'node:fs';
import path from 'node:path';

const IN = process.argv[2] || 'linkedin_topmate_enriched.csv';
const PREFIX = process.argv[3] || 'leads';

function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i+1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c === '\r') {}
    else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  const hdr = rows.shift();
  return { hdr, rows: rows.filter(r => r.some(x => x && x.trim())).map(r => Object.fromEntries(hdr.map((h, i) => [h, r[i] ?? '']))) };
}
const esc = (v) => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
const writeCSV = (file, cols, rows) => fs.writeFileSync(file, [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n'), 'utf8');

const { hdr, rows } = parseCSV(fs.readFileSync(path.resolve(IN), 'utf8'));

const VERIFIED = new Set(['confirmed', 'mismatch->corrected', 'topmate_only']);
const ONDOMAIN = new Set(['personal', 'role']);

function grade(r) {
  const liOk = VERIFIED.has(r.verified_linkedin);
  const hasEmail = !!(r.primary_email && r.primary_email.trim());
  const lowConf = (r.confidence || '').toLowerCase() === 'low';
  if (!liOk || lowConf) return 'D';
  if (hasEmail && ONDOMAIN.has(r.email_tier) && r.website) return 'A';
  if (hasEmail) return 'B';
  return 'C';
}

for (const r of rows) r.grade = grade(r);

// order: strongest signals first within each file
const rank = { personal: 5, role: 4, personal_offdomain: 3.5, personal_free: 3, role_free: 2, none: 0, '': 0 };
const iRank = { yes: 0, maybe: 1, no: 2, '': 2, undefined: 2 };
const sortKey = (r) => [iRank[r.india] ?? 2, -(rank[r.email_tier] || 0), -(parseInt(r.ascore) || 0)];
rows.sort((a, b) => { const ka = sortKey(a), kb = sortKey(b); return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2]; });
const hasIndia = rows[0] && 'india' in rows[0];

const EXTRA = ['india', 'india_signals', 'link_status'].filter(k => rows[0] && k in rows[0]);
const COLS = ['grade', ...EXTRA, 'name', 'tm_name', 'linkedin_profile', 'topmate_profile', 'website', 'primary_email',
  'email_tier', 'discovered_emails', 'discovered_phones', 'verified_linkedin', 'confidence', 'company',
  'domain', 'ascore', 'all_socials', 'website_all', 'source_url'];

writeCSV(`${PREFIX}_graded.csv`, COLS, rows);
for (const g of ['A', 'B', 'C', 'D']) writeCSV(`${PREFIX}_grade_${g}.csv`, COLS, rows.filter(r => r.grade === g));
if (hasIndia) {
  writeCSV(`${PREFIX}_YES.csv`, COLS, rows.filter(r => r.india === 'yes'));
  writeCSV(`${PREFIX}_MAYBE.csv`, COLS, rows.filter(r => r.india === 'maybe'));
}

console.log(`graded ${rows.length} leads -> prefix "${PREFIX}"`);
for (const g of ['A', 'B', 'C', 'D']) {
  const s = rows.filter(r => r.grade === g);
  const em = s.filter(r => r.primary_email).length;
  const yes = s.filter(r => r.india === 'yes').length;
  console.log(`  ${g}: ${String(s.length).padStart(4)}  (${em} email${hasIndia ? `, ${yes} india-yes` : ''})  -> ${PREFIX}_grade_${g}.csv`);
}
if (hasIndia) console.log(`  YES: ${rows.filter(r => r.india === 'yes').length}  MAYBE: ${rows.filter(r => r.india === 'maybe').length}`);
