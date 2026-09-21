import { test } from 'node:test';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { initGmaps } from '../gmaps/db.mjs';
import { createJob, runJob, coverageReport } from '../gmaps/runner.mjs';
import { mapGosom } from '../gmaps/provider.mjs';

function q() { return initGmaps(new DatabaseSync(':memory:')); }

// fake provider: returns businesses per (area,query). Sharma appears in every cell
// (dedup target); a per-area unique clinic also appears.
function fakeRunCell(cell) {
  const shared = mapGosom({
    place_id: 'SHARED', link: 'https://maps/shared', title: 'Sharma Dental',
    web_site: 'https://sharmadental.in', phone: '+91 98765 43210', review_count: 214, review_rating: 4.7,
    complete_address: { city: 'Nagpur' },
  }, cell);
  const uniq = mapGosom({
    place_id: 'U-' + cell.area, link: 'https://maps/' + cell.area, title: cell.area + ' Dental',
    web_site: '', phone: '071200' + cell.area.length, review_count: 8, review_rating: 4.0,
  }, cell);
  return Promise.resolve([shared, uniq]);
}
// fake website enrichment: sharmadental has email+booking; others nothing.
const enrichDeps = {
  fetchText: async (url) => url.includes('sharmadental')
    ? '<a href="mailto:dr@sharmadental.in">m</a><a href="https://calendly.com/x">b</a>' : null,
  extract: (html) => html && html.includes('mailto')
    ? { emails: ['dr@sharmadental.in'], phones: [], socials: { instagram: ['https://instagram.com/x'] } }
    : { emails: [], phones: [], socials: {} },
};

test('matrix job: dedup, counters, enrich, score, coverage', async () => {
  const d = q();
  const jobId = createJob(d, { city: 'Nagpur', areas: ['Dharampeth', 'Sadar'], queries: ['Dentist', 'Dental clinic'], cap: 60 });
  assert.equal(d.allSearches.all(jobId).length, 4); // 2 areas × 2 queries

  const events = [];
  await runJob(d, jobId, { runCell: fakeRunCell, enrichDeps, broadcast: e => events.push(e) });

  const job = d.getJob.get(jobId);
  assert.equal(job.status, 'done');
  assert.equal(job.done_cells, 4);
  assert.equal(job.raw_results, 8);          // 4 cells × 2 businesses
  // SHARED found in all 4 cells => 1 unique + 3 dupes; 2 area-unique clinics => 2 unique
  assert.equal(job.unique_leads, 3);
  assert.equal(job.duplicates, 5);

  const shared = d.getLead.get('SHARED');
  assert.equal(shared.found_count, 4);
  assert.equal(shared.has_email, 'YES');
  assert.equal(shared.has_booking, 'YES');
  assert.ok(shared.score >= 70, `shared score ${shared.score}`);
  assert.deepEqual(JSON.parse(shared.queries_json), { Dentist: 2, 'Dental clinic': 2 });

  // progress events: 4 cell updates + 1 done
  assert.equal(events.filter(e => e.type === 'gmaps_progress').length, 4);
  assert.equal(events.filter(e => e.type === 'gmaps_done').length, 1);

  const cov = coverageReport(d, jobId);
  assert.equal(cov.unique_businesses, 3);
  assert.equal(cov.with_website, 1);   // only sharma has a website
  assert.equal(cov.with_booking, 1);
  assert.equal(cov.total_searches, 4);
});

test('resume: already-done cells are skipped, provider not re-called for them', async () => {
  const d = q();
  const jobId = createJob(d, { city: 'Nagpur', areas: ['Dharampeth', 'Sadar'], queries: ['Dentist'], cap: 60 });
  // mark first cell done manually (simulate a crash after 1 cell)
  const cells = d.allSearches.all(jobId);
  d.setSearch.run({ id: cells[0].id, status: 'ok', result_count: 2, error: '', ts: Date.now() });

  let calls = 0;
  const counting = (cell) => { calls++; return fakeRunCell(cell); };
  await runJob(d, jobId, { runCell: counting, enrichDeps, broadcast: () => {} });
  assert.equal(calls, 1); // only the remaining pending cell ran
  assert.equal(d.getJob.get(jobId).status, 'done');
});

test('a cell error is counted, job still completes', async () => {
  const d = q();
  const jobId = createJob(d, { city: 'Nagpur', areas: ['A', 'B'], queries: ['Dentist'], cap: 60 });
  const flaky = (cell) => cell.area === 'A' ? Promise.reject(new Error('gosom blocked')) : fakeRunCell(cell);
  await runJob(d, jobId, { runCell: flaky, enrichDeps, broadcast: () => {} });
  const job = d.getJob.get(jobId);
  assert.equal(job.status, 'done');
  assert.equal(job.errors, 1);
  assert.equal(d.allSearches.all(jobId).find(s => s.area === 'A').status, 'error');
});
