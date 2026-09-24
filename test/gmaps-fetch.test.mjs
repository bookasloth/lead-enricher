import { test } from 'node:test';
import assert from 'node:assert';
import { fetchText, fetchStatus } from '../gmaps/fetch.mjs';

test('fetchText returns null on abort/error', async () => {
  const r = await fetchText('http://127.0.0.1:1/nope', { timeoutMs: 50 });
  assert.equal(r, null);
});

test('fetchStatus returns 0 on error', async () => {
  const s = await fetchStatus('http://127.0.0.1:1/nope', { timeoutMs: 50 });
  assert.equal(s, 0);
});
