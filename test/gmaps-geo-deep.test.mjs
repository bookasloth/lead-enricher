// test/gmaps-geo-deep.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { citabilityScore, brandMentions } from '../gmaps/geo-deep.mjs';

test('citabilityScore: rich structured page scores higher than thin', () => {
  const rich = `<h1>A</h1><h2>Frequently Asked Questions</h2><h2>Services</h2>
    <ul><li>x</li><li>y</li></ul>
    <script type="application/ld+json">{"@type":"FAQPage"}</script>
    ${'<p>real informative sentence with plenty of words.</p>'.repeat(60)}`;
  const thin = `<p>hi</p>`;
  assert.ok(citabilityScore(rich).score > citabilityScore(thin).score);
  assert.equal(citabilityScore(rich).signals.hasFaq, true);
});

test('brandMentions: no key => skipped', async () => {
  const r = await brandMentions({ name: 'Sharma Dental Nagpur' }, { apiKey: '' });
  assert.equal(r.status, 'skipped');
});
