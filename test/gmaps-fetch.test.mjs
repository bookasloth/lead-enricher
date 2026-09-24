import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { fetchText } from '../gmaps/fetch.mjs';

// Offline, deterministic: spin up a local server serving text/plain so we can
// prove the anyType option changes fetchText's behavior without hitting the network.
test('fetchText: default rejects non-text/html, anyType:true accepts it', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('User-agent: *\nDisallow: /private');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/robots.txt`;
  try {
    const defaultResult = await fetchText(url, { timeoutMs: 2000 });
    assert.equal(defaultResult, null, 'text/plain is rejected without anyType');

    const relaxedResult = await fetchText(url, { timeoutMs: 2000, anyType: true });
    assert.equal(relaxedResult, 'User-agent: *\nDisallow: /private');
  } finally {
    server.close();
  }
});
