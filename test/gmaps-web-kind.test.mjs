import { test } from 'node:test';
import assert from 'node:assert';
import { classifyWeb } from '../gmaps/web-kind.mjs';

test('no website => none', () => {
  assert.deepEqual(classifyWeb(''), { kind: 'none', platform: '', group: '' });
  assert.deepEqual(classifyWeb(null), { kind: 'none', platform: '', group: '' });
});

test('social stand-in => free_site + platform + group', () => {
  assert.deepEqual(classifyWeb('https://www.instagram.com/sharma_dental'),
    { kind: 'free_site', platform: 'instagram', group: 'social' });
  assert.deepEqual(classifyWeb('https://wa.me/919876543210'),
    { kind: 'free_site', platform: 'whatsapp', group: 'social' });
});

test('free builder + directory classified', () => {
  assert.equal(classifyWeb('https://sharma.wixsite.com/clinic').platform, 'wix');
  assert.equal(classifyWeb('https://sharma.wixsite.com/clinic').group, 'free_builder');
  assert.equal(classifyWeb('https://www.justdial.com/Nagpur/x').platform, 'justdial');
  assert.equal(classifyWeb('https://www.justdial.com/Nagpur/x').group, 'directory');
});

test('real owned domain => own + hostname', () => {
  assert.deepEqual(classifyWeb('https://www.sharmadental.in/services'),
    { kind: 'own', platform: 'sharmadental.in', group: '' });
});
