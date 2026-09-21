import { test } from 'node:test';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { initGmaps } from '../gmaps/db.mjs';
import { ingestLead, nameRatio } from '../gmaps/dedup.mjs';

function q() { return initGmaps(new DatabaseSync(':memory:')); }
function lead(over = {}) {
  const base = {
    key: '', job_id: 1, name: '', maps_url: '', place_id: '', cid: '', address: '', locality: 'Dharampeth',
    lat: null, lng: null, phone: '', website: '', category: 'Dentist', rating: 4.0, review_count: 10,
    hours_json: '{}', description: '', services_json: '[]', doctor_name: '', socials_json: '{}', email: '',
    booking_link: '', whatsapp: '', branch_count: 1, areas_json: '{"Dharampeth":1}', queries_json: '{"Dentist":1}',
    found_count: 1, first_seen: 1, last_seen: 1, ts: 1,
  };
  return { ...base, ...over };
}

test('nameRatio catches near-duplicates', () => {
  assert.equal(nameRatio('Sharma Dental Clinic', 'Sharma Dental Clinic'), 1);
  assert.ok(nameRatio('Sharma Dental Clinic', 'Sharma Dental Clinic.') >= 0.9);
  assert.ok(nameRatio('Sharma Dental', 'City Dental') < 0.9);
});

test('same place_id from two cells => one lead, attribution merged', () => {
  const d = q();
  assert.deepEqual(ingestLead(d, lead({ key: 'P1', place_id: 'P1', name: 'Sharma', queries_json: '{"Dentist":1}' })),
    { inserted: true, merged: false, key: 'P1' });
  // found again under a different query
  const r = ingestLead(d, lead({ key: 'P1', place_id: 'P1', name: 'Sharma', areas_json: '{"Dharampeth":1}', queries_json: '{"Dental clinic":1}' }));
  assert.equal(r.merged, true);
  const row = d.getLead.get('P1');
  assert.equal(row.found_count, 2);
  assert.deepEqual(JSON.parse(row.queries_json), { Dentist: 1, 'Dental clinic': 1 });
  assert.deepEqual(JSON.parse(row.areas_json), { Dharampeth: 2 });
});

test('dedup by phone, then website host, then fuzzy name', () => {
  const d = q();
  ingestLead(d, lead({ key: 'P1', place_id: 'P1', name: 'Sharma Dental Clinic', phone: '919876543210', website: 'https://sharmadental.in/' }));

  // different key, same phone -> merge
  let r = ingestLead(d, lead({ key: 'P2', place_id: 'P2', name: 'Sharma Dental', phone: '919876543210' }));
  assert.equal(r.key, 'P1');
  // different key, same website host (www + path variance) -> merge
  r = ingestLead(d, lead({ key: 'P3', place_id: 'P3', name: 'X', website: 'https://www.sharmadental.in/contact' }));
  assert.equal(r.key, 'P1');
  // no ids, fuzzy name in same locality -> merge
  r = ingestLead(d, lead({ key: '', name: 'Sharma Dental Clinic!', locality: 'Dharampeth' }));
  assert.equal(r.key, 'P1');
  assert.equal(d.getLead.get('P1').found_count, 4);
  assert.equal(d.allLeads.all().length, 1);
});

test('distinct businesses stay separate', () => {
  const d = q();
  ingestLead(d, lead({ key: 'P1', place_id: 'P1', name: 'Sharma Dental', phone: '911111111111' }));
  ingestLead(d, lead({ key: 'P2', place_id: 'P2', name: 'City Dental Care', phone: '912222222222', locality: 'Sadar' }));
  assert.equal(d.allLeads.all().length, 2);
});
