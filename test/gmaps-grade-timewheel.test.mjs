// test/gmaps-grade-timewheel.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { gradeTimewheel, loadTwConfig } from '../gmaps/grade-timewheel.mjs';

const cfg = loadTwConfig();

test('config loads', () => {
  assert.equal(cfg.weights.business_value, 30);
  assert.equal(cfg.grades.A, 72);
});

test('rich business, no website => A / P1 with gaps + pitch', () => {
  const lead = { name: 'Sharma Dental', review_count: 450, rating: 4.6, branch_count: 2,
    has_website: 'NO', has_phone: 'YES', has_email: 'YES', has_social: 'NO', website: '' };
  const r = gradeTimewheel(lead, {}, cfg);
  assert.equal(r.tw_grade, 'A');
  assert.equal(r.tw_priority, 'P1');
  const gaps = JSON.parse(r.tw_gap_json);
  assert.ok(gaps.includes('no_website'));
  assert.match(r.tw_pitch, /450 reviews/);
});

test('poor business, great site => low grade', () => {
  const lead = { name: 'X', review_count: 3, rating: 5, branch_count: 1,
    has_website: 'YES', has_phone: 'YES', has_email: 'YES', has_social: 'YES', website: 'https://x.in' };
  const audit = { web: { dead: false, no_ssl: false, not_mobile: false, no_seo: false, thin: false },
    geo: { no_schema: false, ai_crawlers_blocked: false, no_llms_txt: false, no_answer_content: false, no_sitemap: false } };
  const r = gradeTimewheel(lead, audit, cfg);
  assert.ok(['C', 'D'].includes(r.tw_grade), `got ${r.tw_grade}`);
});

test('unobserved (null) audit signals earn nothing, no false pitch', () => {
  const lead = { name: 'Y', review_count: 200, rating: 4.5, has_website: 'YES',
    has_phone: 'YES', has_social: 'YES', website: 'https://y.in' };
  const nulls = { web: { dead: null, no_ssl: null, not_mobile: null, no_seo: null, thin: null },
    geo: { no_schema: null, ai_crawlers_blocked: null, no_llms_txt: null, no_answer_content: null, no_sitemap: null } };
  const r = gradeTimewheel(lead, nulls, cfg);
  const gaps = JSON.parse(r.tw_gap_json);
  assert.ok(!gaps.includes('not_mobile'));
  assert.ok(!gaps.includes('ai_crawlers_blocked'));
});
