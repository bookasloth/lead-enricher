// gmaps/geo-deep.mjs — deep GEO "convincing data" for A/B leads, Node-computable.
// citabilityScore: how quotable/citable the page is to AI answer engines (pure
// heuristic). brandMentions: entity/citation strength off-site — a gated seam
// (needs a search API key) that returns 'skipped' until wired.
//
// NOTE: The richer Claude geo-* skills (geo-citability, geo-brand-mentions) remain
// a MANUAL deep-dive for building the final per-lead pitch deck; they run in a
// Claude session, not in this autonomous pipeline.

const stripText = (html) => String(html || '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

export function citabilityScore(html) {
  const h = String(html || '');
  const text = stripText(h);
  const wordCount = text ? text.split(/\s+/).length : 0;
  const headingCount = (h.match(/<h[1-3][\s>]/gi) || []).length;
  const listCount = (h.match(/<(ul|ol)[\s>]/gi) || []).length;
  const hasSchema = /application\/ld\+json/i.test(h);
  const hasFaq = /faqpage/i.test(h) || /frequently asked questions/i.test(h);
  const hasDirectAnswers = /\b(what|how|why|when|where)\b[^.?!]{0,80}\?/i.test(text);
  let score = 0;
  score += Math.min(30, Math.round(wordCount / 40));   // depth up to 30
  score += Math.min(20, headingCount * 4);             // structure up to 20
  score += Math.min(10, listCount * 5);                // scannability up to 10
  if (hasSchema) score += 15;
  if (hasFaq) score += 15;
  if (hasDirectAnswers) score += 10;
  return { score: Math.min(100, score),
    signals: { hasFaq, headingCount, listCount, hasSchema, wordCount, hasDirectAnswers } };
}

// Gated seam. Wire a search API (e.g. Brave/Serper) here to count off-site
// mentions of the business name; strong pitch input ("AI has no data on you").
export async function brandMentions(lead, { apiKey } = {}) {
  const key = apiKey ?? process.env.SEARCH_API_KEY ?? '';
  if (!key) return { status: 'skipped', count: 0, note: 'no SEARCH_API_KEY' };
  // ponytail: seam only. Implement the search call + count when the key lands.
  return { status: 'skipped', count: 0, note: 'not implemented' };
}

export async function deepGeo(lead, html, opts = {}) {
  const citability = citabilityScore(html || '');
  const mentions = await brandMentions(lead, opts);
  return { citability, mentions };
}
