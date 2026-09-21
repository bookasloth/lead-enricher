import { test } from 'node:test';
import assert from 'node:assert';
import { detectBooking, detectWhatsapp, deriveFlags, enrichWebsite } from '../gmaps/enrich.mjs';

test('detectors find booking + whatsapp links', () => {
  const html = `<a href="https://calendly.com/sharma/consult">Book</a>
    <a href="https://wa.me/919876543210">Chat</a>`;
  assert.equal(detectBooking(html), 'https://calendly.com/sharma/consult');
  assert.equal(detectWhatsapp(html), 'https://wa.me/919876543210');
  assert.equal(detectBooking('<p>no booking here</p>'), '');
});

test('deriveFlags: phone/website definite; contact flags UNKNOWN when unobserved', () => {
  const noSite = deriveFlags({ phone: '911', website: '', email: '', socials_json: '{}', booking_link: '', whatsapp: '' }, false);
  assert.equal(noSite.has_phone, 'YES');
  assert.equal(noSite.has_website, 'NO');
  assert.equal(noSite.has_email, 'UNKNOWN'); // no evidence -> not NO
  assert.equal(noSite.has_booking, 'UNKNOWN');
});

test('enrichWebsite: no website => skipped, flags UNKNOWN', async () => {
  const r = await enrichWebsite({ website: '', phone: '911', socials_json: '{}' }, { fetchText: async () => null, extract: () => ({}) });
  assert.equal(r.enrich_status, 'skipped');
  assert.equal(r.has_email, 'UNKNOWN');
});

test('enrichWebsite: fetch fail => error, flags UNKNOWN', async () => {
  const r = await enrichWebsite({ website: 'https://x.in', socials_json: '{}' },
    { fetchText: async () => null, extract: () => ({ emails: [], phones: [], socials: {} }) });
  assert.equal(r.enrich_status, 'error');
  assert.equal(r.has_email, 'UNKNOWN');
});

test('enrichWebsite: scrapes email/social/booking/whatsapp => YES/NO from evidence', async () => {
  const html = `<a href="mailto:dr@sharmadental.in">mail</a>
    <a href="https://calendly.com/sharma">book</a>
    <a href="https://wa.me/919876543210">wa</a>`;
  const deps = {
    fetchText: async () => html,
    extract: () => ({ emails: ['dr@sharmadental.in'], phones: [], socials: { instagram: ['https://instagram.com/x'] } }),
  };
  const r = await enrichWebsite({ website: 'https://sharmadental.in', socials_json: '{}', email: '', booking_link: '', whatsapp: '' }, deps);
  assert.equal(r.enrich_status, 'ok');
  assert.equal(r.email, 'dr@sharmadental.in');
  assert.equal(r.has_email, 'YES');
  assert.equal(r.has_social, 'YES');
  assert.equal(r.has_booking, 'YES');
  assert.equal(r.has_whatsapp, 'YES');
});

test('enrichWebsite: site with no contacts => no_contact, flags NO (observed)', async () => {
  const deps = { fetchText: async () => '<html>nothing</html>', extract: () => ({ emails: [], phones: [], socials: {} }) };
  const r = await enrichWebsite({ website: 'https://x.in', socials_json: '{}' }, deps);
  assert.equal(r.enrich_status, 'no_contact');
  assert.equal(r.has_email, 'NO');
  assert.equal(r.has_booking, 'NO');
});
