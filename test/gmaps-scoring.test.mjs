import { test } from 'node:test';
import assert from 'node:assert';
import { scoreLead, loadScoringConfig } from '../gmaps/scoring.mjs';

const cfg = loadScoringConfig();

test('config loads from gmaps-scoring.json', () => {
  assert.equal(cfg.weights.hasWebsite, 15);
  assert.equal(cfg.reviewVolumeCap, 1000);
});

test('strong lead scores high with reasons', () => {
  const { score, reasons } = scoreLead({
    review_count: 214, rating: 4.7, branch_count: 2,
    has_website: 'YES', has_booking: 'YES', has_whatsapp: 'YES', has_social: 'YES', has_email: 'YES', has_phone: 'YES',
  }, cfg);
  assert.ok(score >= 70, `expected >=70 got ${score}`);
  assert.ok(reasons.includes('High review volume'));
  assert.ok(reasons.includes('Website available'));
  assert.ok(reasons.includes('Multiple locations'));
  assert.ok(reasons.includes('Online booking detected'));
});

test('weak lead scores low', () => {
  const { score } = scoreLead({ review_count: 3, rating: 5.0, branch_count: 1,
    has_website: 'NO', has_booking: 'UNKNOWN', has_whatsapp: 'UNKNOWN', has_social: 'UNKNOWN',
    has_email: 'UNKNOWN', has_phone: 'YES' }, cfg);
  assert.ok(score < 30, `expected <30 got ${score}`);
});

test('UNKNOWN flags earn nothing (no penalty, no credit)', () => {
  const unknown = scoreLead({ review_count: 50, rating: 4.6, has_website: 'YES',
    has_email: 'UNKNOWN', has_social: 'UNKNOWN', has_booking: 'UNKNOWN', has_whatsapp: 'UNKNOWN', has_phone: 'YES' }, cfg);
  const no = scoreLead({ review_count: 50, rating: 4.6, has_website: 'YES',
    has_email: 'NO', has_social: 'NO', has_booking: 'NO', has_whatsapp: 'NO', has_phone: 'YES' }, cfg);
  assert.equal(unknown.score, no.score); // UNKNOWN treated same as NO for points
  assert.ok(!unknown.reasons.includes('Email available'));
});

test('rating ignored when too few reviews', () => {
  const { reasons } = scoreLead({ review_count: 2, rating: 5.0, has_phone: 'YES' }, cfg);
  assert.ok(!reasons.includes('Strong rating'));
});

test('weights are configurable', () => {
  const custom = { ...cfg, weights: { ...cfg.weights, hasWebsite: 0 } };
  const a = scoreLead({ review_count: 0, has_website: 'YES', has_phone: 'NO' }, custom);
  assert.equal(a.score, 0);
});
