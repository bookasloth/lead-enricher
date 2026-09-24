// gmaps/tag-web.mjs — backfill web_kind / web_platform / web_group over all leads.
// Pure core (tagAll) with injected q; CLI entry opens leads.db. Idempotent.
import { classifyWeb } from './web-kind.mjs';
import { composePitch } from './pitch.mjs';

// Tag every lead's web segment AND refresh its tw_pitch so the pitch reflects the
// platform (free_site → "only on Instagram…"). Pitch is recomputed from the
// already-stored gaps (tw_gap_json) + website — no re-audit, no network.
export function tagAll(q) {
  const rows = q.allLeads.all();
  const counts = { none: 0, free_site: 0, own: 0 };
  const byPlatform = {};
  let pitched = 0;
  for (const row of rows) {
    const c = classifyWeb(row.website);
    q.updateWebKind.run({ key: row.key, web_kind: c.kind, web_platform: c.platform, web_group: c.group });
    counts[c.kind] = (counts[c.kind] || 0) + 1;
    if (c.kind === 'free_site') byPlatform[c.platform] = (byPlatform[c.platform] || 0) + 1;

    if (row.tw_grade != null) {
      let gaps = []; try { gaps = JSON.parse(row.tw_gap_json || '[]'); } catch {}
      const pitch = composePitch(row, gaps);
      if (pitch !== (row.tw_pitch || '')) { q.updateTwPitch.run({ key: row.key, tw_pitch: pitch }); pitched++; }
    }
  }
  return { total: rows.length, counts, byPlatform, pitches_refreshed: pitched };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('tag-web.mjs')) {
  const { DatabaseSync } = await import('node:sqlite');
  const { initGmaps } = await import('./db.mjs');
  const db = new DatabaseSync('leads.db');
  db.exec('PRAGMA busy_timeout=30000');
  const q = initGmaps(db);
  const out = tagAll(q);
  console.log('web tagging:', JSON.stringify(out, null, 2));
}
