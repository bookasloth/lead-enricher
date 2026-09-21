import { test } from 'node:test';
import assert from 'node:assert';
import { flatten, toCSV, toJSON, SALES_COLS, RAW_COLS } from '../gmaps/export.mjs';

const lead = {
  name: 'Sharma Dental', category: 'Dentist', locality: 'Dharampeth', address: 'X Rd', phone: '919876543210',
  whatsapp: '', email: 'dr@sharmadental.in', website: 'https://sharmadental.in', booking_link: 'https://calendly.com/x',
  rating: 4.7, review_count: 214, has_website: 'YES', has_phone: 'YES', has_email: 'YES', has_social: 'YES',
  has_booking: 'YES', has_whatsapp: 'NO', branch_count: 1, score: 78,
  score_reasons_json: '["High review volume","Website available"]', maps_url: 'https://maps/x', found_count: 4,
  place_id: 'P1', cid: '1', lat: 21.1, lng: 79.0, socials_json: '{}', job_id: 3, enrich_status: 'ok',
};

test('flatten: sales cols only by default; score_reasons joined', () => {
  const r = flatten(lead);
  assert.equal(r.score_reasons, 'High review volume; Website available');
  assert.equal(r.name, 'Sharma Dental');
  assert.equal('place_id' in r, false); // raw excluded
  assert.deepEqual(Object.keys(r), SALES_COLS);
});

test('flatten includeRaw adds internal cols', () => {
  const r = flatten(lead, true);
  assert.equal(r.place_id, 'P1');
  assert.equal(Object.keys(r).length, SALES_COLS.length + RAW_COLS.length);
});

test('toCSV header + escaping', () => {
  const csv = toCSV([lead]);
  const [header, row] = csv.split('\n');
  assert.equal(header, SALES_COLS.join(','));
  assert.ok(row.includes('"Sharma Dental"'));
  assert.ok(row.includes('"High review volume; Website available"'));
});

test('toJSON emits sales objects', () => {
  const arr = JSON.parse(toJSON([lead]));
  assert.equal(arr[0].name, 'Sharma Dental');
  assert.equal(arr[0].place_id, undefined);
});
