import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildQueryLine, parseGosomOutput, mapGosom, runCell, normPhone } from '../gmaps/provider.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = fs.readFileSync(path.join(here, '../gmaps/fixtures/gosom-sample.json'), 'utf8');

test('buildQueryLine composes query + area + city', () => {
  assert.equal(buildQueryLine('Dentist', 'Dharampeth', 'Nagpur'), 'Dentist in Dharampeth, Nagpur');
  assert.equal(buildQueryLine('Dentist', '', 'Nagpur'), 'Dentist in Nagpur');
});

test('parseGosomOutput handles array and ndjson', () => {
  assert.equal(parseGosomOutput(FIX).length, 2);
  const nd = '{"title":"A","place_id":"p1"}\n{"title":"B","place_id":"p2"}';
  assert.equal(parseGosomOutput(nd).length, 2);
  assert.deepEqual(parseGosomOutput(''), []);
});

test('mapGosom maps fields, seeds attribution, normalizes phone/lng', () => {
  const [a, b] = parseGosomOutput(FIX);
  const cell = { area: 'Dharampeth', query: 'Dentist', job_id: 7 };
  const m = mapGosom(a, cell);
  assert.equal(m.key, 'ChIJdentist1');
  assert.equal(m.name, 'Sharma Dental Clinic');
  assert.equal(m.phone, '919876543210');
  assert.equal(m.website, 'https://sharmadental.in/');
  assert.equal(m.rating, 4.7);
  assert.equal(m.review_count, 214);
  assert.equal(m.locality, 'Dharampeth');
  assert.equal(m.booking_link, 'https://calendly.com/sharmadental');
  assert.equal(m.doctor_name, 'Dr. Anil Sharma');
  assert.equal(m.lng, 79.0682);
  assert.deepEqual(JSON.parse(m.areas_json), { Dharampeth: 1 });
  assert.deepEqual(JSON.parse(m.queries_json), { Dentist: 1 });
  assert.equal(m.found_count, 1);

  // second entry: no website, longtitude typo field, city fallback (area still wins if given)
  const m2 = mapGosom(b, { area: '', query: 'Dental clinic' });
  assert.equal(m2.website, '');
  assert.equal(m2.lng, 79.09);
  assert.equal(m2.locality, 'Nagpur'); // falls back to complete_address.city
});

test('normPhone', () => {
  assert.equal(normPhone('+91 98765 43210'), '919876543210');
  assert.equal(normPhone('0712-2345678'), '07122345678');
  assert.equal(normPhone('abc'), '');
});

test('runCell uses injected exec, applies cap', async () => {
  const fakeExec = async () => FIX;
  const leads = await runCell({ area: 'Dharampeth', query: 'Dentist' }, { city: 'Nagpur', cap: 1 }, fakeExec);
  assert.equal(leads.length, 1);
  assert.equal(leads[0].key, 'ChIJdentist1');
});
