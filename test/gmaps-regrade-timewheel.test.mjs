import { test } from 'node:test';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { initGmaps } from '../gmaps/db.mjs';
import { regradeAll } from '../gmaps/regrade-timewheel.mjs';

function freshDb() { return initGmaps(new DatabaseSync(':memory:')); }

function seed(q) {
  const now = Date.now();
  const base = { job_id: 1, maps_url: '', place_id: '', cid: '', address: '', locality: '',
    lat: null, lng: null, category: '', hours_json: '{}', description: '', services_json: '[]',
    doctor_name: '', socials_json: '{}', email: '', booking_link: '', whatsapp: '',
    branch_count: 1, areas_json: '{}', queries_json: '{}', found_count: 1,
    first_seen: now, last_seen: now, ts: now };
  q.insertLead.run({ ...base, key: 'rich', name: 'Sharma Dental', phone: '911', website: '',
    rating: 4.6, review_count: 450, place_id: 'p1' });
  // reflect enrich flags (insertLead defaults them UNKNOWN; set no-website explicitly)
  q.updateEnrich.run({ key: 'rich', email: '', socials_json: '{}', booking_link: '', whatsapp: '',
    has_website: 'NO', has_phone: 'YES', has_email: 'UNKNOWN', has_social: 'NO',
    has_booking: 'UNKNOWN', has_whatsapp: 'UNKNOWN', enrich_status: 'skipped' });
}

test('regradeAll audits + grades every lead; no-website rich => A', async () => {
  const q = freshDb();
  seed(q);
  const deps = { fetchText: async () => null, fetchStatus: async () => 0 };
  const out = await regradeAll(q, deps);
  assert.equal(out.graded, 1);
  const row = q.getLead.get('rich');
  assert.equal(row.tw_grade, 'A');
  assert.equal(row.audit_status, 'skipped'); // no website
  assert.ok(JSON.parse(row.tw_gap_json).includes('no_website'));
});

test('concurrency pool grades all pending; resume skips already-graded', async () => {
  const q = freshDb();
  const now = Date.now();
  const base = { job_id: 1, maps_url: '', place_id: '', cid: '', address: '', locality: '',
    lat: null, lng: null, category: '', hours_json: '{}', description: '', services_json: '[]',
    doctor_name: '', socials_json: '{}', email: '', booking_link: '', whatsapp: '',
    branch_count: 1, areas_json: '{}', queries_json: '{}', found_count: 1,
    first_seen: now, last_seen: now, ts: now, website: '', rating: 4.5, review_count: 200 };
  for (const k of ['a', 'b', 'c', 'd', 'e']) {
    q.insertLead.run({ ...base, key: k, name: 'Biz ' + k, phone: '911', place_id: 'p_' + k });
    q.updateEnrich.run({ key: k, email: '', socials_json: '{}', booking_link: '', whatsapp: '',
      has_website: 'NO', has_phone: 'YES', has_email: 'UNKNOWN', has_social: 'NO',
      has_booking: 'UNKNOWN', has_whatsapp: 'UNKNOWN', enrich_status: 'skipped' });
  }
  const deps = { fetchText: async () => null, fetchStatus: async () => 0, concurrency: 3 };
  const out1 = await regradeAll(q, deps);
  assert.equal(out1.graded, 5);      // all five processed by the pool
  assert.equal(out1.skipped, 0);
  const out2 = await regradeAll(q, deps);
  assert.equal(out2.graded, 0);      // resume: all already graded
  assert.equal(out2.skipped, 5);
});
