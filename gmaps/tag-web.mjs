// gmaps/tag-web.mjs — backfill web_kind / web_platform / web_group over all leads.
// Pure core (tagAll) with injected q; CLI entry opens leads.db. Idempotent.
import { classifyWeb } from './web-kind.mjs';

export function tagAll(q) {
  const rows = q.allLeads.all();
  const counts = { none: 0, free_site: 0, own: 0 };
  const byPlatform = {};
  for (const row of rows) {
    const c = classifyWeb(row.website);
    q.updateWebKind.run({ key: row.key, web_kind: c.kind, web_platform: c.platform, web_group: c.group });
    counts[c.kind]++;
    if (c.kind === 'free_site') byPlatform[c.platform] = (byPlatform[c.platform] || 0) + 1;
  }
  return { total: rows.length, counts, byPlatform };
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
