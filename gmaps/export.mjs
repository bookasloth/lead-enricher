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

export function flatten(lead, includeRaw = false) {
  const reasons = (() => { try { return JSON.parse(lead.score_reasons_json || '[]').join('; '); } catch { return ''; } })();
  const gradeReasons = (() => { try { return (JSON.parse(lead.grade_json || '{}').reasons || []).join('; '); } catch { return ''; } })();
  const derived = { score_reasons: reasons, grade_reasons: gradeReasons };
  const row = {};
  for (const c of SALES_COLS) row[c] = c in derived ? derived[c] : (lead[c] ?? '');
  if (includeRaw) for (const c of RAW_COLS) row[c] = lead[c] ?? '';
  return row;
}

export function exportRows(leads, includeRaw = false) { return leads.map(l => flatten(l, includeRaw)); }

export function toCSV(leads, includeRaw = false) {
  const cols = includeRaw ? [...SALES_COLS, ...RAW_COLS] : SALES_COLS;
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = exportRows(leads, includeRaw);
  return cols.join(',') + '\n' + rows.map(r => cols.map(c => esc(r[c])).join(',')).join('\n');
}

export function toJSON(leads, includeRaw = false) {
  return JSON.stringify(exportRows(leads, includeRaw), null, 2);
}
