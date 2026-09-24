// gmaps/pitch.mjs — deterministic pitch one-liner (composePitch, used by the grader)
// + a Claude-API email seam (draftEmail). No network in composePitch. draftEmail
// returns a stub until ANTHROPIC_API_KEY is wired.
import { classifyWeb } from './web-kind.mjs';

// How to name a free_site stand-in in the pitch (falls back to the raw platform label).
const PLATFORM_PHRASE = {
  instagram: 'Instagram', facebook: 'Facebook', twitter_x: 'X/Twitter', youtube: 'YouTube',
  whatsapp: 'WhatsApp', linktree: 'a Linktree', telegram: 'Telegram',
  google_sites: 'a free Google Sites page', google_business_site: 'a free Google business page',
  wix: 'a free Wix page', wordpress_com: 'a free WordPress.com page', blogspot: 'a Blogspot page',
  weebly: 'a free Weebly page', godaddy: 'a GoDaddy builder page', duda: 'a builder page',
  justdial: 'a JustDial listing', practo: 'a Practo listing', sulekha: 'a Sulekha listing',
  indiamart: 'an IndiaMART listing', zomato: 'a Zomato listing', swiggy: 'a Swiggy listing',
  tripadvisor: 'a TripAdvisor listing', urbanpro: 'an UrbanPro listing',
};

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
  const gapList = gaps || [];
  const rc = Number(lead.review_count) || 0;
  const rating = Number(lead.rating) || 0;
  const value = rc >= 25
    ? `${rc} reviews${rating ? `, ${rating}★` : ''}`
    : 'An established local business';

  // free_site: the business only has a social/builder/directory stand-in, not a
  // real owned website. Lead the pitch with WHERE they are so it's tailored.
  const cls = classifyWeb(lead.website);
  if (cls.kind === 'free_site') {
    const where = PLATFORM_PHRASE[cls.platform] || cls.platform;
    const extra = gapList.map(g => GAP_PHRASES[g]).filter(Boolean).slice(0, 2);
    const extraStr = extra.length ? ` (also ${extra.join(', ')})` : '';
    return `${value} — but only on ${where}, no real website${extraStr}. Losing customers who Google you.`.trim();
  }

  if (!gapList.length) return '';
  const phrases = gapList.map(g => GAP_PHRASES[g]).filter(Boolean).slice(0, 3);
  const aiInvisible = gapList.some(g => AI_GAPS.has(g) || g === 'no_website');
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
