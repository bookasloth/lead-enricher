import { test } from 'node:test';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { initGmaps } from '../gmaps/db.mjs';

function freshDb() { return initGmaps(new DatabaseSync(':memory:')); }

test('schema inits and job/search/lead round-trip', () => {
  const q = freshDb();
  const now = Date.now();
  const info = q.createJob.run({ city: 'Nagpur', params_json: '{}', total_cells: 2, started_at: now });
  const jobId = Number(info.lastInsertRowid);
  assert.equal(jobId > 0, true);

  q.addSearch.run({ job_id: jobId, area: 'Dharampeth', query: 'Dentist', ts: now });
  q.addSearch.run({ job_id: jobId, area: 'Sadar', query: 'Dentist', ts: now });
  assert.equal(q.pendingSearches.all(jobId).length, 2);

  q.insertLead.run({
    key: 'PLACE1', job_id: jobId, name: 'Smile Dental', maps_url: 'https://maps.google.com/?cid=1',
    place_id: 'PLACE1', cid: '1', address: 'X Rd, Dharampeth, Nagpur', locality: 'Dharampeth',
    lat: 21.1, lng: 79.0, phone: '919999999999', website: 'https://smiledental.in', category: 'Dentist',
    rating: 4.6, review_count: 210, hours_json: '{}', description: '', services_json: '[]',
    doctor_name: 'Dr A', socials_json: '{}', email: '', booking_link: '', whatsapp: '', branch_count: 1,
    areas_json: '{"Dharampeth":1}', queries_json: '{"Dentist":1}', found_count: 1,
    first_seen: now, last_seen: now, ts: now,
  });
  const lead = q.getLead.get('PLACE1');
  assert.equal(lead.name, 'Smile Dental');
  assert.equal(lead.review_count, 210);
  assert.equal(lead.has_email, 'UNKNOWN');

  // dedup lookup by phone / website / place_id
  assert.equal(q.getLeadBy.get({ v: 'PLACE1', phone: 'nope', website: 'nope' }).key, 'PLACE1');
  assert.equal(q.getLeadBy.get({ v: 'nope', phone: '919999999999', website: 'nope' }).key, 'PLACE1');
});

test('tw columns + statements exist and round-trip', () => {
  const q = freshDb();
  const now = Date.now();
  q.insertLead.run({ key: 'k1', job_id: 1, name: 'X', maps_url: '', place_id: 'p', cid: '',
    address: '', locality: '', lat: null, lng: null, phone: '', website: '', category: '',
    rating: null, review_count: 0, hours_json: '{}', description: '', services_json: '[]',
    doctor_name: '', socials_json: '{}', email: '', booking_link: '', whatsapp: '',
    branch_count: 1, areas_json: '{}', queries_json: '{}', found_count: 1,
    first_seen: now, last_seen: now, ts: now });
  q.updateAudit.run({ key: 'k1', audit_json: '{"web":{}}', psi_json: '{}', geo_json: '{}', audit_status: 'ok' });
  q.updateTwGrade.run({ key: 'k1', tw_score: 77, tw_grade: 'A', tw_priority: 'P1',
    tw_gap_json: '["no_website"]', tw_pitch: 'No website.' });
  const row = q.getLead.get('k1');
  assert.equal(row.audit_status, 'ok');
  assert.equal(row.tw_score, 77);
  assert.equal(row.tw_grade, 'A');
  assert.equal(row.tw_pitch, 'No website.');
});
