// gmaps/fetch.mjs — shared HTTP helpers for the Google Maps enrichment/audit path.
// Extracted from server.mjs so the audit module and CLIs can fetch without booting
// the server. Returns null/0 on any failure; callers must treat that as UNKNOWN.

const DEF = { timeoutMs: 12000, ua: 'Mozilla/5.0 (compatible; LeadBot/1.0)',
  maxHtml: 2_000_000, accept: 'text/html' };

export async function fetchText(url, opts = {}) {
  const { timeoutMs, ua, maxHtml, accept, anyType } = { ...DEF, ...opts };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow',
      headers: { 'User-Agent': ua, 'Accept': accept } });
    const ct = res.headers.get('content-type') || '';
    if (!res.ok || (!anyType && !ct.includes('text/html'))) return null;
    const reader = res.body?.getReader();
    if (!reader) return await res.text();
    let received = 0, html = ''; const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      html += dec.decode(value, { stream: true });
      if (received > maxHtml) { ctrl.abort(); break; }
    }
    return html;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

// GET that returns only the HTTP status (0 on error). Used to test existence of
// /llms.txt, /sitemap.xml, /robots.txt without downloading large bodies.
export async function fetchStatus(url, opts = {}) {
  const { timeoutMs, ua } = { ...DEF, ...opts };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow',
      headers: { 'User-Agent': ua } });
    return res.status;
  } catch { return 0; }
  finally { clearTimeout(timer); }
}
