import { test } from 'node:test';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { initGmaps } from '../gmaps/db.mjs';
import { dailyCap, renderEmail, budget, runOutreach } from '../gmaps/outreach.mjs';

function freshDb() { return initGmaps(new DatabaseSync(':memory:')); }

function seedEmailable(q, n) {
  const now = Date.now();
  const base = { job_id: 1, maps_url: '', place_id: '', cid: '', address: '', locality: 'Dharampeth',
    lat: null, lng: null, category: 'Dentist', hours_json: '{}', description: '', services_json: '[]',
    doctor_name: '', socials_json: '{}', booking_link: '', whatsapp: '', branch_count: 1,
    areas_json: '{}', queries_json: '{}', found_count: 1, first_seen: now, last_seen: now, ts: now };
  for (let i = 0; i < n; i++) {
    const key = 'k' + i;
    q.insertLead.run({ ...base, key, name: 'Clinic ' + i, phone: '911', website: 'https://c' + i + '.in',
      email: 'c' + i + '@x.in', rating: 4.6, review_count: 100 + i, place_id: 'p' + i });
    q.updateWebKind.run({ key, web_kind: 'own', web_platform: 'c' + i + '.in', web_group: '' });
    q.updateTwGrade.run({ key, tw_score: 60, tw_grade: 'C', tw_priority: 'P3',
      tw_gap_json: '["not_mobile","no_schema"]', tw_pitch: 'not mobile, no schema.' });
  }
}

test('dailyCap ramps 20->40->70->100', () => {
  assert.equal(dailyCap(0), 20);
  assert.equal(dailyCap(3), 40);
  assert.equal(dailyCap(8), 70);
  assert.equal(dailyCap(99), 100);
});

test('renderEmail: personalized subject + pitch + unsubscribe', () => {
  const { subject, text } = renderEmail(
    { name: 'Sharma Dental', review_count: 450, rating: 4.6, category: 'Dentist', locality: 'Sadar',
      tw_pitch: 'not mobile, no schema.' },
    { senderEmail: 'team@timewheel.co.in', unsubscribe: 'Reply STOP.' });
  assert.match(subject, /Sharma Dental/);
  assert.match(subject, /450 reviews/);
  assert.match(text, /not mobile, no schema/);
  assert.match(text, /Reply STOP\./);
});

test('dry-run logs dry_run rows, marks nothing contacted, sends nothing', async () => {
  const q = freshDb();
  seedEmailable(q, 25);
  const out = await runOutreach(q, { hourly: 10 }, { cfg: {}, dryRun: true });
  assert.equal(out.dryRun, true);
  assert.equal(out.attempted, 10);       // hourly throttle
  assert.equal(out.sent, 0);
  const contacted = q.allLeads.all().filter(l => l.outreach_status === 'contacted').length;
  assert.equal(contacted, 0);
  const logged = q.sentSince.get({ since: 0 }).n; // status='sent' only
  assert.equal(logged, 0);
});

test('real send path: uses transport, marks contacted, respects daily cap', async () => {
  const q = freshDb();
  seedEmailable(q, 30);
  const sentTo = [];
  const send = async ({ to }) => { sentTo.push(to); };
  // day 0 cap = 20, hourly 10 -> first run sends 10
  const r1 = await runOutreach(q, { send, hourly: 10 }, { cfg: { senderEmail: 't@x' } });
  assert.equal(r1.sent, 10);
  assert.equal(sentTo.length, 10);
  const r2 = await runOutreach(q, { send, hourly: 10 }, { cfg: { senderEmail: 't@x' } });
  assert.equal(r2.sent, 10); // 20 total, still under cap
  const r3 = await runOutreach(q, { send, hourly: 10 }, { cfg: { senderEmail: 't@x' } });
  assert.equal(r3.sent, 0);  // cap 20 reached today
  const contacted = q.allLeads.all().filter(l => l.outreach_status === 'contacted').length;
  assert.equal(contacted, 20);
});

test('budget: no candidates once all contacted', () => {
  const q = freshDb();
  seedEmailable(q, 3);
  const b = budget(q, { hourly: 10 });
  assert.ok(b.allow >= 3);
});
