// gmaps/enrich.mjs — chain the existing website scraper onto each Maps lead.
// Reuses server.mjs fetchText+extract (email/socials) and adds booking + whatsapp
// detectors. Flags are YES | NO | UNKNOWN: never claim NO without evidence
// (no website, or fetch failed => UNKNOWN, not NO).

const BOOKING_HOSTS = ['calendly.com','cal.com','setmore.com','topmate.io','zcal.co','tidycal.com',
  'acuityscheduling.com','squareup.com/appointments','book.squareup.com','practo.com','zocdoc.com',
  'simplybook.me','appointlet.com','savvycal.com','calendar.google.com','calendar.app.google'];
const BOOKING_RE = new RegExp('https?:\\/\\/(?:www\\.)?(?:' +
  BOOKING_HOSTS.map(h => h.replace(/[.\/]/g, m => '\\' + m)).join('|') + ')[^"\'<>\\s]*', 'i');
const WHATSAPP_RE = /https?:\/\/(?:wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com)\/[^"'<>\s]+/i;

export function detectBooking(html) { const m = String(html || '').match(BOOKING_RE); return m ? m[0] : ''; }
export function detectWhatsapp(html) { const m = String(html || '').match(WHATSAPP_RE); return m ? m[0] : ''; }

const yn = (b) => (b ? 'YES' : 'NO');

// derive flags from a lead's known fields + whether the website was observed.
// observed=false => contact-derived flags stay UNKNOWN.
export function deriveFlags(lead, observed) {
  const hasSocial = (() => { try { return Object.keys(JSON.parse(lead.socials_json || '{}')).length > 0; } catch { return false; } })();
  return {
    has_phone: yn(!!lead.phone),
    has_website: yn(!!lead.website),
    has_email: observed ? yn(!!lead.email) : (lead.email ? 'YES' : 'UNKNOWN'),
    has_social: observed ? yn(hasSocial) : (hasSocial ? 'YES' : 'UNKNOWN'),
    has_booking: observed ? yn(!!lead.booking_link) : (lead.booking_link ? 'YES' : 'UNKNOWN'),
    has_whatsapp: observed ? yn(!!lead.whatsapp) : (lead.whatsapp ? 'YES' : 'UNKNOWN'),
  };
}

// enrich one lead in place. deps = { fetchText, extract } injected (default: server.mjs).
// Returns the enrichment patch (email, socials_json, booking_link, whatsapp, flags, enrich_status).
export async function enrichWebsite(lead, deps) {
  const { fetchText, extract } = deps;
  const base = {
    email: lead.email || '', socials_json: lead.socials_json || '{}',
    booking_link: lead.booking_link || '', whatsapp: lead.whatsapp || '',
  };
  if (!lead.website) {
    return { ...base, ...deriveFlags({ ...lead, ...base }, false), enrich_status: 'skipped' };
  }
  let host = ''; try { host = new URL(lead.website).hostname.replace(/^www\./, ''); } catch {}
  const html = await fetchText(lead.website);
  if (!html) {
    // couldn't observe the site — leave contact flags UNKNOWN
    return { ...base, ...deriveFlags({ ...lead, ...base }, false), enrich_status: 'error' };
  }
  const r = extract(html, host);
  const merged = {
    email: base.email || (r.emails[0] || ''),
    socials_json: JSON.stringify(r.socials || {}),
    booking_link: base.booking_link || detectBooking(html),
    whatsapp: base.whatsapp || detectWhatsapp(html),
  };
  const flags = deriveFlags({ ...lead, ...merged }, true);
  const hasContact = !!(merged.email || (r.phones && r.phones.length) || Object.keys(r.socials || {}).length);
  return { ...merged, ...flags, enrich_status: hasContact ? 'ok' : 'no_contact' };
}
