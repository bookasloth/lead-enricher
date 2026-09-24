// gmaps/outreach.mjs — cold-email outreach for emailable has-website leads.
// Pure logic + an orchestrator that takes an injected `send` transport, so tests
// never touch the network and nothing sends unless a real transport is provided.
//
// Channel reality: no-website leads have 0 emails, so this targets web_kind='own'
// emailable leads with the SEO/AEO/GEO pitch (their site exists but is invisible).

const DAY_MS = 24 * 60 * 60 * 1000;

// Ramp to protect the primary domain's reputation: ease into volume over ~2 weeks.
// dayIndex is 0-based days since the first successful send (0 on day one).
export function dailyCap(dayIndex) {
  if (dayIndex <= 2) return 20;   // days 1-3
  if (dayIndex <= 6) return 40;   // days 4-7
  if (dayIndex <= 10) return 70;  // days 8-11
  return 100;                     // day 12+
}

export function startOfDay(now = Date.now()) {
  const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime();
}

// How many we may send in THIS run: min(hourly throttle, daily cap remaining).
export function budget(q, { now = Date.now(), hourly = 10 } = {}) {
  const first = q.firstSendTs.get().t;
  const dayIndex = first ? Math.floor((now - startOfDay(first)) / DAY_MS) : 0;
  const cap = dailyCap(dayIndex);
  const sentToday = q.sentSince.get({ since: startOfDay(now) }).n;
  const remaining = Math.max(0, cap - sentToday);
  return { allow: Math.min(hourly, remaining), cap, sentToday, dayIndex };
}

const esc = (s) => String(s ?? '').trim();

// Deterministic email from a lead row + config. Uses the lead's own tw_pitch as
// the personalized problem line. cfg supplies sender identity + unsubscribe.
export function renderEmail(lead, cfg = {}) {
  const name = esc(lead.name) || 'there';
  const rc = Number(lead.review_count) || 0;
  const rating = Number(lead.rating) || 0;
  const cat = esc(lead.category) || 'business';
  const loc = esc(lead.locality) || 'your area';
  const proof = rc >= 25 ? `${rc} reviews${rating ? ` at ${rating}★` : ''}` : `a strong local reputation`;
  const pitch = esc(lead.tw_pitch);

  const subject = `${name} — ${rc >= 25 ? `${rc} reviews` : 'great reviews'}, but hard to find online`;
  const from = cfg.fromName || 'Timewheel Internet';
  const signoff = cfg.signoff || `— ${from}\n${cfg.senderEmail || ''}${cfg.senderPhone ? ' · ' + cfg.senderPhone : ''}`;
  const unsub = cfg.unsubscribe || 'Not relevant? Reply "STOP" and I won\'t email again.';
  const addr = cfg.address ? `\n${cfg.address}` : '';

  const text = [
    `Hi ${name} team,`,
    ``,
    `You've got ${proof} — clearly one of the better ${cat}s in ${loc}. But when someone searches for you on Google (or asks ChatGPT / Gemini), your site isn't doing you justice.`,
    pitch ? `\nWhat we see: ${pitch}` : ``,
    ``,
    `We fix exactly this for local businesses — a fast, mobile, SEO'd site that ranks and gets picked up by AI search, so the customers already looking for you actually find you. Done-for-you in ~2 weeks.`,
    ``,
    `Want a 2-minute Loom showing what people see when they search for you right now? Just reply "yes".`,
    ``,
    signoff,
    ``,
    unsub + addr,
  ].filter(l => l !== null && l !== undefined).join('\n');

  return { subject, text };
}

// Orchestrate one run. deps = { send?(from,to,subject,text)->Promise, now?, hourly? }.
// Without deps.send (or dryRun) it records dry_run rows and marks nothing contacted.
export async function runOutreach(q, deps = {}, opts = {}) {
  const now = deps.now || Date.now();
  const hourly = deps.hourly || 10;
  const cfg = opts.cfg || {};
  const dryRun = opts.dryRun || typeof deps.send !== 'function';

  const { allow, cap, sentToday, dayIndex } = budget(q, { now, hourly });
  const out = { attempted: 0, sent: 0, errors: 0, dryRun, cap, sentToday, dayIndex, allow };
  if (allow <= 0) return out;

  const leads = q.outreachCandidates.all({ limit: allow });
  for (const lead of leads) {
    const { subject, text } = renderEmail(lead, cfg);
    out.attempted++;
    if (dryRun) {
      q.logSend.run({ key: lead.key, email: lead.email, subject, status: 'dry_run', error: '', ts: now });
      continue;
    }
    try {
      await deps.send({ from: cfg.senderEmail, to: lead.email, subject, text });
      q.logSend.run({ key: lead.key, email: lead.email, subject, status: 'sent', error: '', ts: Date.now() });
      q.updateOutreach.run({ key: lead.key, outreach_status: 'contacted', notes: lead.notes || '', contacted_at: Date.now() });
      out.sent++;
    } catch (e) {
      q.logSend.run({ key: lead.key, email: lead.email, subject, status: 'error', error: String(e).slice(0, 200), ts: Date.now() });
      out.errors++;
    }
  }
  return out;
}
