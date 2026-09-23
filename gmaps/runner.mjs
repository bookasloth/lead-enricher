// gmaps/runner.mjs — orchestrates a Google Maps job over the CITY×AREA×QUERY matrix.
// provider(runCell) -> dedup(ingestLead) -> enrich(website) -> score. Tracks per-cell
// `searches` for resume + coverage, per-job counters, and streams progress via an
// injected broadcast. Everything external is injectable so tests need no Docker/network.
import { ingestLead } from './dedup.mjs';
import { enrichWebsite } from './enrich.mjs';
import { scoreLead, loadScoringConfig } from './scoring.mjs';
import { gradeLead } from './grade.mjs';

// build the matrix: one `searches` cell per area×query. Returns jobId.
export function createJob(q, { city, areas, queries, cap = 60 }) {
  const now = Date.now();
  const cells = [];
  for (const area of areas) for (const query of queries) cells.push({ area, query });
  const info = q.createJob.run({
    city, params_json: JSON.stringify({ areas, queries, cap }),
    total_cells: cells.length, started_at: now,
  });
  const jobId = Number(info.lastInsertRowid);
  for (const c of cells) q.addSearch.run({ job_id: jobId, area: c.area, query: c.query, ts: now });
  return jobId;
}

// run (or resume) a job. deps: { runCell, enrichDeps:{fetchText,extract}, cfg?, broadcast?, shouldStop? }
export async function runJob(q, jobId, deps) {
  const job = q.getJob.get(jobId);
  if (!job) throw new Error('no such job');
  const cap = JSON.parse(job.params_json || '{}').cap || 60;
  const city = job.city || '';
  const cfg = deps.cfg || loadScoringConfig();
  const broadcast = deps.broadcast || (() => {});
  const shouldStop = deps.shouldStop || (() => false);

  q.setJobStatus.run({ id: jobId, status: 'running', completed_at: null });
  // counters carry across resume
  let done = countDone(q, jobId), raw = job.raw_results, uniq = job.unique_leads, dup = job.duplicates, err = job.errors;

  for (const cell of q.pendingSearches.all(jobId)) {
    if (shouldStop()) { q.setJobStatus.run({ id: jobId, status: 'stopped', completed_at: Date.now() }); return; }
    let leads = [];
    try {
      leads = await deps.runCell({ area: cell.area, query: cell.query, job_id: jobId }, { city, cap });
    } catch (e) {
      err++;
      q.setSearch.run({ id: cell.id, status: 'error', result_count: 0, error: String(e).slice(0, 200), ts: Date.now() });
      done++;
      bump(q, jobId, { done, raw, uniq, dup, err });
      broadcast({ type: 'gmaps_progress', job_id: jobId, done_cells: done, total_cells: job.total_cells,
        raw_results: raw, unique_leads: uniq, duplicates: dup, errors: err, area: cell.area, query: cell.query, started_at: job.started_at });
      continue;
    }

    raw += leads.length;
    const touched = new Set();
    for (const lead of leads) {
      const res = ingestLead(q, { ...lead, job_id: jobId });
      if (res.inserted) uniq++; else dup++;
      touched.add(res.key);
    }
    // enrich + score any lead not yet enriched (idempotent across cells/resume)
    for (const key of touched) {
      const row = q.getLead.get(key);
      if (!row) continue;
      if (row.enrich_status === 'pending') {
        const patch = await enrichWebsite(row, deps.enrichDeps);
        q.updateEnrich.run({ key, ...patch });
      }
      const fresh = q.getLead.get(key);
      const scored = scoreLead(fresh, cfg);
      q.updateScore.run({ key, score: scored.score, score_reasons_json: JSON.stringify(scored.reasons) });
      // step 3: product-fit grade (grade/priority/eligibility) on the same fresh row
      q.updateGrade.run({ key, ...gradeLead(fresh) });
    }

    q.setSearch.run({ id: cell.id, status: 'ok', result_count: leads.length, error: '', ts: Date.now() });
    done++;
    bump(q, jobId, { done, raw, uniq, dup, err });
    broadcast({ type: 'gmaps_progress', job_id: jobId, done_cells: done, total_cells: job.total_cells,
      raw_results: raw, unique_leads: uniq, duplicates: dup, errors: err, area: cell.area, query: cell.query, started_at: job.started_at });
  }

  q.setJobStatus.run({ id: jobId, status: 'done', completed_at: Date.now() });
  broadcast({ type: 'gmaps_done', job_id: jobId, ...coverageReport(q, jobId) });
}

function countDone(q, jobId) {
  return q.allSearches.all(jobId).filter(s => s.status !== 'pending').length;
}
function bump(q, jobId, { done, raw, uniq, dup, err }) {
  q.bumpJob.run({ id: jobId, done_cells: done, raw_results: raw, unique_leads: uniq, duplicates: dup, errors: err });
}

// post-job coverage: totals, per-locality counts, contact-flag tallies.
export function coverageReport(q, jobId) {
  const job = q.getJob.get(jobId);
  const leads = q.leadsByJob.all(jobId);
  const byLocality = {};
  const yes = (v) => v === 'YES';
  let phone = 0, website = 0, email = 0, booking = 0, whatsapp = 0, social = 0;
  for (const l of leads) {
    byLocality[l.locality || '(unknown)'] = (byLocality[l.locality || '(unknown)'] || 0) + 1;
    if (yes(l.has_phone)) phone++;
    if (yes(l.has_website)) website++;
    if (yes(l.has_email)) email++;
    if (yes(l.has_booking)) booking++;
    if (yes(l.has_whatsapp)) whatsapp++;
    if (yes(l.has_social)) social++;
  }
  const searches = q.allSearches.all(jobId);
  return {
    city: job.city,
    areas_searched: new Set(searches.map(s => s.area)).size,
    queries: new Set(searches.map(s => s.query)).size,
    total_searches: searches.length,
    completed_searches: searches.filter(s => s.status !== 'pending').length,
    raw_results: job.raw_results,
    unique_businesses: leads.length,
    duplicates_removed: job.duplicates,
    errors: job.errors,
    with_phone: phone, with_website: website, with_email: email,
    with_booking: booking, with_whatsapp: whatsapp, with_social: social,
    by_locality: byLocality,
  };
}
