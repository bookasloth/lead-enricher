// gmaps/laya-client.mjs — thin client to the isolated Python Laya decision
// service. Only server.mjs talks to this; the browser never does. Uses no laya/
// torch itself, so Node boots fine whether or not the Python service is up.
// Fails loud (throws) so callers can degrade — Laya is optional.
const LAYA_URL = process.env.LAYA_URL || 'http://127.0.0.1:8077';

export const layaHealth = (timeoutMs = 2000) => fetchJson('GET', '/health', null, timeoutMs);
export const layaDecide = (lead, timeoutMs = 30000) => fetchJson('POST', '/decide', lead, timeoutMs);

async function fetchJson(method, pathname, body, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(LAYA_URL + pathname, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`laya ${pathname} -> ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}
