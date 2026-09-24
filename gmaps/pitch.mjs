// gmaps/pitch.mjs — deterministic pitch one-liner (composePitch, used by the grader)
// + a Claude-API email seam (draftEmail). No network in composePitch. draftEmail
// returns a stub until ANTHROPIC_API_KEY is wired.

const GAP_PHRASES = {
  no_website: 'no website',
  dead_site: 'a dead/parked website',
  no_ssl: 'an insecure (no-HTTPS) site',
  not_mobile: 'a non-mobile site',
  weak_seo: 'weak on-page SEO',
  thin: 'thin content',
  no_schema: 'zero schema markup',
  ai_crawlers_blocked: 'AI crawlers blocked',
  no_llms_txt: 'no llms.txt',
  no_answer_content: 'no answerable content',
  no_sitemap: 'no sitemap',
  no_social: 'no social presence',
};
const AI_GAPS = new Set(['no_schema', 'ai_crawlers_blocked', 'no_llms_txt', 'no_answer_content']);

// Pure. Leads with the biggest proof-of-value (reviews) get the punchiest opener.
export function composePitch(lead, gaps) {
  if (!gaps || !gaps.length) return '';
  const rc = Number(lead.review_count) || 0;
  const rating = Number(lead.rating) || 0;
  const value = rc >= 25
    ? `${rc} reviews${rating ? `, ${rating}★` : ''}`
    : 'An established local business';
  const phrases = gaps.map(g => GAP_PHRASES[g]).filter(Boolean).slice(0, 3);
  const aiInvisible = gaps.some(g => AI_GAPS.has(g) || g === 'no_website');
  const tail = aiInvisible ? ' Invisible on Google and ChatGPT.' : '';
  return `${value} — but ${phrases.join(', ')}.${tail}`.trim();
}

// Seam. Live branch documented but inert until a key is provided.
export async function draftEmail(lead, { apiKey } = {}) {
  const key = apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
  const stub = `Subject: Quick note for ${lead.name}\n\n` +
    `Hi ${lead.name} team,\n\n${lead.tw_pitch || ''}\n\n` +
    `We help local businesses fix exactly this. Worth a 10-minute call?\n\n— Timewheel Internet`;
  if (!key) return { status: 'stub', body: stub };
  // ponytail: seam only. Wire the Claude API call here when the key lands:
  // POST https://api.anthropic.com/v1/messages with model 'claude-opus-4-8',
  // a prompt built from lead + audit_json + geo_json; return { status:'ok', body }.
  return { status: 'stub', body: stub };
}
