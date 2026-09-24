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

test('composePitch: free_site leads with the platform name', () => {
  const s = composePitch(
    { name: 'Glow Salon', review_count: 300, rating: 4.5, website: 'https://instagram.com/glowsalon' },
    ['no_schema']);
  assert.match(s, /300 reviews/);
  assert.match(s, /only on Instagram/);
  assert.match(s, /no real website/);
});

test('composePitch: directory stand-in named', () => {
  const s = composePitch(
    { name: 'City Clinic', review_count: 120, website: 'https://www.justdial.com/Nagpur/city-clinic' },
    []);
  assert.match(s, /JustDial listing/);
});

test('draftEmail: no key => deterministic stub', async () => {
  const r = await draftEmail({ name: 'Sharma Dental', tw_pitch: 'No website.' }, { apiKey: '' });
  assert.equal(r.status, 'stub');
  assert.match(r.body, /Sharma Dental/);
});
