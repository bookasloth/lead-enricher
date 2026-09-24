import { test } from 'node:test';
import assert from 'node:assert';
import { auditHtml, auditSite } from '../gmaps/audit.mjs';

const GOOD = `<!doctype html><html><head><title>Sharma Dental Nagpur</title>
  <meta name="viewport" content="width=device-width">
  <meta name="description" content="Best dental clinic">
  <script type="application/ld+json">{"@type":"LocalBusiness","name":"Sharma"}</script>
  <script src="https://www.googletagmanager.com/gtag/js"></script></head>
  <body><h1>Welcome</h1><h2>Frequently Asked Questions</h2>
  ${'<p>content paragraph with real words here.</p>'.repeat(40)}</body></html>`;

const BAD = `<html><head><title></title></head><body>hi</body></html>`;

test('auditHtml: good site => no gaps', () => {
  const a = auditHtml(GOOD, 'https://sharmadental.in');
  assert.equal(a.web.not_mobile, false);
  assert.equal(a.web.no_seo, false);
  assert.equal(a.web.thin, false);
  assert.equal(a.web.no_analytics, false);
  assert.equal(a.geo.no_schema, false);
});

test('auditHtml: bad site => gaps flagged', () => {
  const a = auditHtml(BAD, 'http://x.in');
  assert.equal(a.web.not_mobile, true);
  assert.equal(a.web.no_seo, true);
  assert.equal(a.web.thin, true);
  assert.equal(a.web.no_analytics, true);
  assert.equal(a.geo.no_schema, true);
});

test('auditSite: no website => skipped, all null', async () => {
  const r = await auditSite({ website: '' }, { fetchText: async () => null, fetchStatus: async () => 0 });
  assert.equal(r.audit_status, 'skipped');
  const a = JSON.parse(r.audit_json);
  assert.equal(a.web.not_mobile, null);
});

test('auditSite: fetch fail => error, dead=true, rest null', async () => {
  const r = await auditSite({ website: 'https://x.in' },
    { fetchText: async () => null, fetchStatus: async () => 0 });
  assert.equal(r.audit_status, 'error');
  assert.equal(JSON.parse(r.audit_json).web.dead, true);
});

test('auditSite: robots blocking GPTBot => ai_crawlers_blocked true', async () => {
  const robots = 'User-agent: GPTBot\nDisallow: /';
  const deps = {
    fetchText: async (u) => u.endsWith('robots.txt') ? robots : GOOD,
    fetchStatus: async (u) => u.endsWith('sitemap.xml') ? 200 : 404, // llms.txt 404, sitemap 200
  };
  const r = await auditSite({ website: 'https://sharmadental.in' }, deps);
  assert.equal(r.audit_status, 'ok');
  const g = JSON.parse(r.geo_json);
  assert.equal(g.ai_crawlers_blocked, true);
  assert.equal(g.no_llms_txt, true);
  assert.equal(g.no_sitemap, false);
});
