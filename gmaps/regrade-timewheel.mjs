// gmaps/regrade-timewheel.mjs — backfill Timewheel scoring over existing rows.
// audit -> tw grade -> deep GEO (A/B only). Idempotent. Pure core (regradeAll)
// with injected fetchers; CLI entry opens leads.db.
import { auditSite } from './audit.mjs';
import { gradeTimewheel, loadTwConfig } from './grade-timewheel.mjs';
import { deepGeo } from './geo-deep.mjs';

export async function regradeAll(q, deps) {
  const cfg = deps.cfg || loadTwConfig();
  const deepGrades = deps.deepGrades || ['A', 'B'];
  const force = deps.force || false; // re-grade rows already done (default: resume/skip them)
  const rows = q.allLeads.all();
  let audited = 0, graded = 0, deep = 0, skipped = 0, errored = 0;

  for (const row of rows) {
    // resume: a row already tw-graded is done — skip so re-runs make forward progress
    if (!force && row.tw_grade != null) { skipped++; continue; }
    try {
      const a = await auditSite(row, deps);
      q.updateAudit.run({ key: row.key, audit_json: a.audit_json, psi_json: row.psi_json || '{}',
        geo_json: a.geo_json, audit_status: a.audit_status });
      if (a.audit_status !== 'skipped') audited++;

      let audit = {}; try { audit = JSON.parse(a.audit_json); } catch {}
      const g = gradeTimewheel(row, audit, cfg);
      q.updateTwGrade.run({ key: row.key, ...g });
      graded++;

      // deep GEO for A/B leads with a live site (needs the HTML again)
      if (deepGrades.includes(g.tw_grade) && row.website && a.audit_status === 'ok') {
        const html = await deps.fetchText(row.website);
        if (html) {
          const dg = await deepGeo(row, html, deps);
          let geo = {}; try { geo = JSON.parse(a.geo_json); } catch {}
          geo.deep = dg;
          q.updateAudit.run({ key: row.key, audit_json: a.audit_json, psi_json: row.psi_json || '{}',
            geo_json: JSON.stringify(geo), audit_status: a.audit_status });
          deep++;
        }
      }
    } catch (e) {
      // one bad lead (transient lock, odd HTML) must not kill the whole backfill;
      // it stays tw_grade=null and a later run retries it.
      errored++;
    }
  }
  return { audited, graded, deep, skipped, errored };
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('regrade-timewheel.mjs')) {
  const { DatabaseSync } = await import('node:sqlite');
  const { fetchText, fetchStatus } = await import('./fetch.mjs');
  const { initGmaps } = await import('./db.mjs');
  const db = new DatabaseSync('leads.db');
  db.exec('PRAGMA busy_timeout=30000'); // wait out the server's writes instead of crashing on SQLITE_BUSY
  const q = initGmaps(db);
  const out = await regradeAll(q, { fetchText, fetchStatus });
  console.log('Timewheel regrade:', out);
}
