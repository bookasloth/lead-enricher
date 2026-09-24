// gmaps/export.mjs — outreach-ready export. Sales fields up front; internal scraper
// metadata only when includeRaw. CSV + JSON here; xlsx is built client-side from the
// JSON with the SheetJS already loaded in the page.

export const SALES_COLS = ['grade', 'priority', 'marketing_eligible', 'fit_score', 'opportunity',
  'name', 'category', 'locality', 'address', 'phone', 'whatsapp', 'email',
  'website', 'booking_link', 'rating', 'review_count', 'has_website', 'has_phone', 'has_email',
  'has_social', 'has_booking', 'has_whatsapp', 'branch_count', 'score', 'grade_reasons', 'score_reasons',
  'maps_url', 'found_count'];
export const RAW_COLS = ['place_id', 'cid', 'lat', 'lng', 'hours_json', 'services_json', 'socials_json',
  'areas_json', 'queries_json', 'job_id', 'enrich_status', 'status', 'first_seen', 'last_seen'];
export const TW_SALES_COLS = ['tw_grade', 'tw_priority', 'tw_score', 'tw_pitch', 'tw_gaps',
  'web_kind', 'web_platform', 'web_group',
  'name', 'category', 'locality', 'address', 'phone', 'whatsapp', 'email', 'website',
  'rating', 'review_count', 'has_website', 'has_social', 'audit_summary', 'maps_url'];

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
