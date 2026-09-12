// Build a self-contained admin HTML from a graded leads CSV (offline snapshot).
// The app also serves this live at /admin/lists/:name/:period — same renderer.
// Usage: node build-admin.mjs [graded.csv] [out.html] [title]

import fs from 'node:fs';
import { parseCSV, renderAdminHTML } from './admin-template.mjs';

const IN = process.argv[2] || 'india_leads_graded.csv';
const OUT = process.argv[3] || 'india_admin.html';
const TITLE = process.argv[4] || 'Lead Admin';

const rows = parseCSV(fs.readFileSync(IN, 'utf8'));
const html = renderAdminHTML(rows, { title: TITLE, subtitle: `${rows.length} leads` });
fs.writeFileSync(OUT, html, 'utf8');
console.log(`wrote ${OUT} (${rows.length} rows, ${(html.length / 1024).toFixed(0)}KB)`);
