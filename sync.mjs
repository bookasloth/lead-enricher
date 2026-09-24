// sync.mjs — push locally-scraped leads to the online (Render) app.
// Home box scrapes (residential IP, Docker), then this streams the results up.
// Idempotent: safe to run repeatedly. Online owns CRM fields (outreach/notes) —
// the server preserves those on conflict, so re-syncing never clobbers them.
//
//   SYNC_URL=https://your-app.onrender.com SYNC_TOKEN=xxxx node sync.mjs
//
// Or drop a sync.config.json next to this file: {"url":"...","token":"..."}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let URL_ = process.env.SYNC_URL || '';
let TOKEN = process.env.SYNC_TOKEN || '';
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'sync.config.json'), 'utf8'));
  URL_ = URL_ || cfg.url; TOKEN = TOKEN || cfg.token;
} catch { /* no config file — env only */ }

if (!URL_ || !TOKEN) {
  console.error('Missing SYNC_URL / SYNC_TOKEN (env or sync.config.json). Aborting.');
  process.exit(1);
}
URL_ = URL_.replace(/\/+$/, '');
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'leads.db');
const BATCH = 500;

const db = new DatabaseSync(DB_FILE);
const jobs = db.prepare('SELECT * FROM jobs').all();
const leads = db.prepare('SELECT * FROM gmaps_leads').all();
console.log(`Local DB: ${leads.length} leads, ${jobs.length} jobs → ${URL_}`);

async function post(payload) {
  const r = await fetch(URL_ + '/api/sync/leads', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

let sent = 0;
for (let i = 0; i < leads.length; i += BATCH) {
  const batch = leads.slice(i, i + BATCH);
  const payload = { leads: batch, jobs: i === 0 ? jobs : [] }; // jobs once, with the first batch
  const res = await post(payload);
  sent += res.upserted || batch.length;
  console.log(`  batch ${i / BATCH + 1}: ${sent}/${leads.length} leads synced`);
}
// no leads but jobs still worth pushing (e.g. fresh job history)
if (leads.length === 0 && jobs.length) { await post({ leads: [], jobs }); console.log('  jobs synced'); }
console.log('Done.');
