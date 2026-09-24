// test/gmaps-pitch.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { composePitch, draftEmail } from '../gmaps/pitch.mjs';

test('composePitch: value + no website + AI-blocked', () => {
  const s = composePitch({ name: 'Sharma Dental', review_count: 450, rating: 4.6 },
    ['no_website', 'ai_crawlers_blocked', 'no_schema']);
  assert.match(s, /450 reviews/);
  assert.match(s, /no website/i);
  assert.match(s, /AI/i);
});

test('composePitch: no gaps => empty', () => {
  assert.equal(composePitch({ name: 'X', review_count: 5 }, []), '');
});

test('draftEmail: no key => deterministic stub', async () => {
  const r = await draftEmail({ name: 'Sharma Dental', tw_pitch: 'No website.' }, { apiKey: '' });
  assert.equal(r.status, 'stub');
  assert.match(r.body, /Sharma Dental/);
});
