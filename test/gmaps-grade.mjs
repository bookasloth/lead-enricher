// Verifies the step-3 grader port (gmaps/grade.mjs) matches Leader's logic:
// hand-computed golden cases + the same invariants Leader's scripts/selfcheck.ts asserts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gradeLead, scoreLead, leadToNormalized } from '../gmaps/grade.mjs';

test('golden: reachable active dentist, no booking -> A+ / P1', () => {
  const g = gradeLead({
    name: 'Sunrise Dental', category: 'Dentist', address: 'MG Road',
    phone: '+91...', website: 'sunrise.example', review_count: 120, rating: 4.6,
    has_phone: 'YES', has_website: 'YES', has_booking: 'NO', has_email: 'NO', has_social: 'UNKNOWN',
  });
  assert.equal(g.fit_score, 87);
  assert.equal(g.grade, 'A+');
  assert.equal(g.priority, 'P1');
  assert.equal(g.marketing_eligible, 'YES');
  assert.equal(g.opportunity, 'High');
});

test('golden: grocery store (LOW fit) -> X / EXCLUDE', () => {
  const g = gradeLead({
    name: 'Daily Grocery', category: 'Grocery store', phone: '123',
    review_count: 50, rating: 4, has_phone: 'YES', has_website: 'NO',
  });
  assert.equal(g.grade, 'X');
  assert.equal(g.priority, 'EXCLUDE');
  assert.equal(g.marketing_eligible, 'NO');
  assert.equal(g.opportunity, 'Low');
});

test('golden: unclear category -> MAYBE / P3 / needs_review', () => {
  const g = gradeLead({
    name: 'Guru Astro', category: 'Astrologer', phone: '999', has_phone: 'YES',
  });
  assert.equal(g.marketing_eligible, 'MAYBE');
  assert.equal(g.priority, 'P3');
  assert.equal(g.opportunity, 'Unknown');
  assert.equal(JSON.parse(g.grade_json).needs_review, true);
});

test('invariants hold across varied rows (Leader selfcheck parity)', () => {
  const rows = [
    { name: 'A', category: 'Physiotherapist', phone: '1', has_phone: 'YES', has_website: 'YES', review_count: 200, rating: 4.8, has_booking: 'NO' },
    { name: 'B', category: 'Chartered accountant', email: 'x@y.z', has_email: 'YES', review_count: 5, rating: 4.1 },
    { name: 'C', category: 'Restaurant', phone: '2', has_phone: 'YES', review_count: 3000, rating: 4.5 },
    { name: 'D', category: '', review_count: null, rating: null },
    { name: 'E', category: 'ENT specialist', phone: '3', whatsapp: 'wa', has_phone: 'YES', has_whatsapp: 'YES', booking_link: 'https://calendly.com/e', review_count: 40, rating: 4.4 },
    { name: 'F', category: 'Beauty parlour', has_website: 'YES', has_social: 'YES', review_count: 80, rating: 4.2, has_booking: 'UNKNOWN' },
  ];
  for (const r of rows) {
    const s = scoreLead(leadToNormalized(r));
    assert.ok(s.fit_score >= 0 && s.fit_score <= 100, `fit range ${s.fit_score}`);
    const sum = Object.values(s.breakdown).reduce((a, b) => a + b, 0);
    assert.equal(Math.min(sum, 100), s.fit_score, 'breakdown sum == fit');
    assert.ok(['A+', 'A', 'B', 'C', 'D', 'X'].includes(s.grade), `grade ${s.grade}`);
    // eligible NO  <=>  priority EXCLUDE
    assert.equal(s.eligible === 'NO', s.priority === 'EXCLUDE', 'NO <=> EXCLUDE');
    if (s.eligible === 'YES') assert.notEqual(s.priority, 'EXCLUDE');
  }
});

test('booking platform detected from calendly link', () => {
  const s = scoreLead(leadToNormalized({ name: 'E', category: 'ENT specialist', booking_link: 'https://calendly.com/e', has_booking: 'YES' }));
  assert.equal(s.booking, 'DETECTED');
  assert.equal(s.booking_platform, 'Calendly');
});
