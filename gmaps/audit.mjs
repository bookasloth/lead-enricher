// gmaps/audit.mjs — site + GEO/AEO quality probe. Pure HTML detectors (auditHtml)
// + orchestration (auditSite) that also checks robots.txt/llms.txt/sitemap.xml.
// Every signal is boolean when observed, null when not. Never assert a gap without
// evidence: fetch failure => dead=true, everything else null, status 'error'.

const AI_BOTS = ['GPTBot', 'ClaudeBot', 'Claude-Web', 'PerplexityBot', 'Google-Extended', 'CCBot', 'anthropic-ai'];
const THIN_CHARS = 600;

const stripText = (html) => String(html || '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function sniffPlatform(html) {
  const h = String(html || '').toLowerCase();
  if (h.includes('wix.com') || h.includes('_wix')) return 'wix';
  if (h.includes('wp-content') || h.includes('wp-includes')) return 'wordpress';
  if (h.includes('squarespace')) return 'squarespace';
  if (h.includes('cdn.shopify')) return 'shopify';
  return 'unknown';
}

function ldTypes(html) {
  const types = [];
  for (const m of String(html || '').matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1].trim());
      const arr = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const n of arr) if (n && n['@type']) types.push(String(n['@type']).toLowerCase());
    } catch { /* bad json-ld */ }
  }
  return types;
}

// Pure: signals derivable from the HTML + its URL alone.
export function auditHtml(html, siteUrl) {
  const h = String(html || '');
  const text = stripText(h);
  const hasViewport = /<meta[^>]+name=["']viewport["']/i.test(h);
  const hasTitle = /<title[^>]*>[^<]{1,}<\/title>/i.test(h);
  const hasDesc = /<meta[^>]+name=["']description["'][^>]+content=["'][^"']{1,}["']/i.test(h);
  const hasH1 = /<h1[\s>]/i.test(h);
  const hasAnalytics = /gtag\(|googletagmanager|google-analytics|gtm\.js|fbq\(|clarity\.ms/i.test(h);
  const types = ldTypes(h);
  const hasBizSchema = types.some(t => /localbusiness|organization|product|faqpage/.test(t));
  const hasFaq = types.includes('faqpage') || /frequently asked questions|<h[23][^>]*>\s*faq/i.test(h);
  const headings = (h.match(/<h[1-3][\s>]/gi) || []).length;
  return {
    web: {
      dead: false,
      no_ssl: !/^https:/i.test(siteUrl || ''),
      not_mobile: !hasViewport,
      no_seo: !(hasTitle && hasDesc && hasH1),
      thin: text.length < THIN_CHARS,
      no_analytics: !hasAnalytics,
      platform: sniffPlatform(h),
    },
    geo: {
      no_schema: !hasBizSchema,
      no_answer_content: !(hasFaq || headings >= 3),
      ai_crawlers_blocked: null, // set by auditSite from robots.txt
      no_llms_txt: null,         // set by auditSite
      no_sitemap: null,          // set by auditSite
    },
  };
}

const NULL_WEB = { dead: null, no_ssl: null, not_mobile: null, no_seo: null, thin: null, no_analytics: null, platform: null };
const NULL_GEO = { no_schema: null, no_answer_content: null, ai_crawlers_blocked: null, no_llms_txt: null, no_sitemap: null };

function robotsBlocksAI(robotsTxt) {
  if (!robotsTxt) return false; // absent robots => not blocked
  const lines = String(robotsTxt).split(/\r?\n/).map(l => l.trim());
  let uaMatch = false, blocked = false;
  for (const line of lines) {
    const ua = line.match(/^user-agent:\s*(.+)$/i);
    if (ua) { const v = ua[1].trim(); uaMatch = v === '*' || AI_BOTS.some(b => v.toLowerCase() === b.toLowerCase()); continue; }
    if (uaMatch && /^disallow:\s*\/\s*$/i.test(line)) blocked = true;
  }
  return blocked;
}

// Orchestrate all fetches. deps = { fetchText, fetchStatus }.
export async function auditSite(lead, deps) {
  const site = lead.website || '';
  if (!site) {
    return { audit_json: JSON.stringify({ web: NULL_WEB, geo: NULL_GEO }),
      geo_json: JSON.stringify(NULL_GEO), audit_status: 'skipped' };
  }
  let origin = ''; try { origin = new URL(site).origin; } catch {}
  const html = await deps.fetchText(site);
  if (!html) {
    const web = { ...NULL_WEB, dead: true, no_ssl: !/^https:/i.test(site) };
    return { audit_json: JSON.stringify({ web, geo: NULL_GEO }),
      geo_json: JSON.stringify(NULL_GEO), audit_status: 'error' };
  }
  const a = auditHtml(html, site);
  if (origin) {
    const robots = await deps.fetchText(origin + '/robots.txt');
    a.geo.ai_crawlers_blocked = robotsBlocksAI(robots);
    a.geo.no_llms_txt = (await deps.fetchStatus(origin + '/llms.txt')) !== 200;
    a.geo.no_sitemap = (await deps.fetchStatus(origin + '/sitemap.xml')) !== 200;
  }
  return { audit_json: JSON.stringify(a), geo_json: JSON.stringify(a.geo), audit_status: 'ok' };
}
