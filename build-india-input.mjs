// NDJSON (scrape output) -> india_input.csv for the India subset only.
// linkedin from scraped socials, topmate_profile from the backlink target(s).
// Feeds enrich-topmate.mjs (verified LI + website) then grade-split.mjs.
//
// Usage: node build-india-input.mjs [in.ndjson] [out.csv] [yes|all]

import fs from 'node:fs';

const IN = process.argv[2] || 'topmate_india_leads.ndjson';
const OUT = process.argv[3] || 'india_input.csv';
const WHICH = process.argv[4] || 'all'; // 'yes' = india===yes only; 'all' = yes+maybe

const esc = (v) => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
const clean = (u) => String(u).split('?')[0].replace(/\/+$/, '').replace(/^http:/, 'https:');

function pickLinkedin(socialsJson) {
  let li = [];
  try { li = (JSON.parse(socialsJson || '{}').linkedin || []).map(clean); } catch {}
  li = [...new Set(li)];
  const personal = li.filter(x => /\/in\//i.test(x));
  return { primary: personal[0] || li[0] || '', all: li };
}

const rows = [];
for (const line of fs.readFileSync(IN, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let o; try { o = JSON.parse(line); } catch { continue; }
  const keep = WHICH === 'yes' ? o.india === 'yes' : (o.india === 'yes' || o.india === 'maybe');
  if (!keep) continue;
  const { primary, all } = pickLinkedin(o.socials);
  const tms = (o.topmate_profiles || '').split(',').map(s => s.trim()).filter(Boolean);
  rows.push({
    linkedin_profile: primary,
    topmate_profile: tms[0] || '',
    confidence: /\/in\//i.test(primary) ? 'high' : (primary ? 'medium' : 'low'),
    name: o.name || '', company: o.company || '', domain: o.domain || '',
    primary_email: o.primary_email || '', email_tier: o.email_tier || 'none',
    ascore: o.ascore || '', status: o.scrape_status || '',
    india: o.india, india_signals: o.india_signals || '', link_status: o.link_status || '',
    topmate_all_profiles: tms.join(', '), linkedin_all: all.join(', '),
    phones: o.phones || '', source_url: o.source_url || '',
  });
}

// india=yes first, then on-domain email, then authority
const rank = { personal: 5, role: 4, personal_offdomain: 3.5, personal_free: 3, role_free: 2, none: 0, '': 0 };
rows.sort((a, b) => (a.india === b.india ? 0 : a.india === 'yes' ? -1 : 1)
  || (rank[b.email_tier] || 0) - (rank[a.email_tier] || 0)
  || (parseInt(b.ascore) || 0) - (parseInt(a.ascore) || 0));

const cols = ['linkedin_profile','topmate_profile','confidence','name','company','domain','primary_email',
  'email_tier','ascore','status','india','india_signals','link_status','topmate_all_profiles','linkedin_all','phones','source_url'];
fs.writeFileSync(OUT, [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n'), 'utf8');

const c = (f) => rows.filter(f).length;
console.log(`wrote ${OUT}: ${rows.length} india leads (${c(r => r.india === 'yes')} yes, ${c(r => r.india === 'maybe')} maybe)`);
console.log(`  with email: ${c(r => r.primary_email)}  | with linkedin: ${c(r => r.linkedin_profile)}  | with topmate: ${c(r => r.topmate_profile)}`);
