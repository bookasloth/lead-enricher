// gmaps/send-outreach.mjs — CLI: send one throttled outreach batch from Gmail/Workspace.
// Dry-run by DEFAULT. Real sends require SEND=1 plus SMTP creds in env:
//   SMTP_USER=team@timewheel.co.in  SMTP_PASS=<16-char Gmail App Password>  SEND=1
// Meant to be run hourly (Task Scheduler / run-outreach.cmd). Ramp + daily cap +
// idempotency live in gmaps/outreach.mjs; this file only wires transport + db.
import fs from 'node:fs';
import { runOutreach } from './outreach.mjs';

function loadCfg() {
  try { return JSON.parse(fs.readFileSync('outreach.config.json', 'utf8')); } catch { return {}; }
}

const { DatabaseSync } = await import('node:sqlite');
const { initGmaps } = await import('./db.mjs');
const db = new DatabaseSync('leads.db');
db.exec('PRAGMA busy_timeout=30000');
const q = initGmaps(db);

const cfg = loadCfg();
const user = process.env.SMTP_USER || cfg.senderEmail || '';
const pass = process.env.SMTP_PASS || '';
const wantSend = process.env.SEND === '1';
cfg.senderEmail = user || cfg.senderEmail;

let deps = { hourly: Number(process.env.HOURLY) || 10 };
if (wantSend && user && pass) {
  const nodemailer = (await import('nodemailer')).default;
  const transport = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass },
  });
  deps.send = ({ from, to, subject, text }) =>
    transport.sendMail({ from: from || user, to, subject, text });
} else if (wantSend) {
  console.error('SEND=1 but SMTP_USER/SMTP_PASS missing — refusing to send. Running dry.');
}

const out = await runOutreach(q, deps, { cfg, dryRun: !deps.send });
console.log('outreach run:', JSON.stringify(out));
if (out.dryRun) console.log('(dry-run — set SEND=1 + SMTP_USER/SMTP_PASS to actually send)');
