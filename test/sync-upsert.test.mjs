// Verifies the home→cloud sync upsert: scrape fields update, but CRM fields
// (outreach_status/notes/contacted_at) the ONLINE app owns are never clobbered.
import { test } from 'node:test';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { initGmaps } from '../gmaps/db.mjs';

const COLS = ['key','job_id','name','maps_url','place_id','cid','address','locality','lat','lng','phone','website',
  'category','rating','review_count','hours_json','description','services_json','doctor_name','socials_json','email',
  'booking_link','whatsapp','branch_count','areas_json','queries_json','found_count','first_seen','last_seen',
  'has_website','has_phone','has_email','has_social','has_booking','has_whatsapp','score','score_reasons_json',
  'enrich_status','status','note','ts','grade','fit_score','priority','marketing_eligible','opportunity',
  'grade_confidence','grade_json','outreach_status','notes','contacted_at'];
const row = (over = {}) => { const o = {}; for (const c of COLS) o[c] = null; o.key = 'k1'; o.branch_count = 1; o.found_count = 1; return { ...o, ...over }; };

test('sync preserves online CRM fields but updates scrape data', () => {
  const db = new DatabaseSync(':memory:');
  const G = initGmaps(db);

  // 1. home's first sync: fresh lead, no CRM state yet
  G.syncUpsertLead.run(row({ name: 'Old Name', phone: '111', grade: 'B', outreach_status: 'new', notes: null }));

  // 2. online user works the lead: marks won + adds a note
  db.prepare(`UPDATE gmaps_leads SET outreach_status='won', notes='closed the deal', contacted_at=999 WHERE key='k1'`).run();

  // 3. home re-scrapes + re-syncs: new phone/grade, and home's stale CRM ('new'/null)
  G.syncUpsertLead.run(row({ name: 'New Name', phone: '222', grade: 'A+', outreach_status: 'new', notes: null, contacted_at: null }));

  const r = db.prepare(`SELECT * FROM gmaps_leads WHERE key='k1'`).get();
  assert.equal(r.name, 'New Name', 'scrape field should update');
  assert.equal(r.phone, '222', 'scrape field should update');
  assert.equal(r.grade, 'A+', 'grade should update');
  assert.equal(r.outreach_status, 'won', 'CRM status must be preserved');
  assert.equal(r.notes, 'closed the deal', 'CRM notes must be preserved');
  assert.equal(r.contacted_at, 999, 'contacted_at must be preserved');
});
