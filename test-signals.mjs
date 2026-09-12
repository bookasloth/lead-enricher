// Self-check for lead-scoring signals. Run: node test-signals.mjs
import assert from 'node:assert';
import { deriveSignals, classifyEmail, pickPrimary, isPlatform, intentOf } from './server.mjs';

// email tiers
assert.equal(classifyEmail('jane@acme.com', 'acme.com'), 'personal');
assert.equal(classifyEmail('info@acme.com', 'acme.com'), 'role');
assert.equal(classifyEmail('jane@gmail.com', 'acme.com'), 'personal_free');
assert.equal(classifyEmail('info@gmail.com', 'acme.com'), 'role_free');
assert.equal(classifyEmail('jane@other.com', 'acme.com'), 'personal_offdomain');

// primary picks best tier
assert.equal(pickPrimary('info@acme.com, jane@acme.com', 'acme.com').email, 'jane@acme.com');
assert.equal(pickPrimary('', 'acme.com').tier, 'none');

// platform detection
assert.equal(isPlatform('medium.com', 'website', 'https://medium.com/'), true);
assert.equal(isPlatform('rathod.medium.com', 'medium', 'https://rathod.medium.com/'), false); // person subdomain
assert.equal(isPlatform('github.com', 'github', 'https://github.com/'), true);          // root
assert.equal(isPlatform('github.com', 'github', 'https://github.com/realuser'), false); // profile
assert.equal(isPlatform('acme.com', 'website', 'https://acme.com/'), false);

// intent from anchor / competitor count
assert.equal(intentOf({ anchor: 'best Calendly alternatives', links_to: 'Calendly' }).pts > 0, true);
assert.equal(intentOf({ anchor: 'my link', links_to: 'Topmate, Calendly' }).pts > 0, true);
assert.equal(intentOf({ anchor: 'hello', links_to: 'Topmate' }).pts, 0);

// scoring: personal-on-domain + high DA + review intent should beat generic gmail
const strong = deriveSignals({ domain:'acme.com', type:'website', source_url:'https://acme.com/',
  emails:'jane@acme.com', phones:'', anchor:'best Topmate alternatives', links_to:'Topmate', ascore:65, name:'Jane', socials:'{}' });
const weak = deriveSignals({ domain:'blah.com', type:'website', source_url:'https://blah.com/',
  emails:'someone@gmail.com', phones:'', anchor:'link', links_to:'Topmate', ascore:5, name:'', socials:'{}' });
assert.equal(strong.email_tier, 'personal');
assert.equal(strong.score > weak.score, true);
assert.equal(strong.score > 70, true);

// platform row is crushed even with an email present
const plat = deriveSignals({ domain:'medium.com', type:'website', source_url:'https://medium.com/',
  emails:'press@medium.com', phones:'', anchor:'x', links_to:'Topmate', ascore:96, name:'', socials:'{}' });
assert.equal(plat.is_platform, true);
assert.equal(plat.score < 30, true);

console.log('all signal checks passed');
