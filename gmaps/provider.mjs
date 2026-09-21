// gmaps/provider.mjs — GoogleMaps provider backed by gosom/google-maps-scraper.
// Pure parts (buildQueryLine, parseGosomOutput, mapGosom) are unit-tested.
// The docker spawn (runCell) takes an injectable `exec` so tests never need Docker.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
export function normPhone(raw) {
  const d = String(raw || '').replace(/[^\d+]/g, '').replace(/^\+/, '');
  const digits = d.replace(/\D/g, '');
  return (digits.length >= 8 && digits.length <= 15) ? digits : '';
}

// one gosom input line per search cell: "Dentist in Dharampeth, Nagpur"
export function buildQueryLine(query, area, city) {
  const where = [area, city].filter(Boolean).join(', ');
  return where ? `${query} in ${where}` : query;
}

// gosom -json may emit a JSON array OR ndjson (one object per line). Handle both.
export function parseGosomOutput(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  try { const j = JSON.parse(t); return Array.isArray(j) ? j : [j]; } catch { /* try ndjson */ }
  const out = [];
  for (const line of t.split('\n')) {
    const s = line.trim(); if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* skip bad line */ }
  }
  return out;
}

// map one gosom Entry -> our lead shape (discovery attribution seeded from the cell)
export function mapGosom(raw, cell = {}) {
  const { area = '', query = '', job_id = null } = cell;
  const place_id = raw.place_id || '';
  const cid = raw.cid || '';
  const maps_url = raw.link || '';
  const key = place_id || cid || maps_url || (raw.title || '') + '|' + (raw.address || '');
  const website = raw.web_site || '';
  const phone = normPhone(raw.phone);
  const lng = (raw.longitude ?? raw.longtitude ?? null); // gosom struct carries both spellings
  const ca = raw.complete_address || {};
  const locality = area || ca.borough || ca.city || '';
  // booking candidate from gosom "reservations" link-sources
  const booking = Array.isArray(raw.reservations) && raw.reservations.length ? raw.reservations[0].link || '' : '';
  const now = Date.now();
  return {
    key, job_id,
    name: raw.title || '',
    maps_url, place_id, cid,
    address: raw.address || '',
    locality,
    lat: raw.latitude ?? null,
    lng,
    phone,
    website,
    category: raw.category || (Array.isArray(raw.categories) ? raw.categories[0] : '') || '',
    rating: Number(raw.review_rating) || 0,
    review_count: Number(raw.review_count) || 0,
    hours_json: JSON.stringify(raw.open_hours || {}),
    description: raw.description || '',
    services_json: JSON.stringify(raw.about || []),
    doctor_name: (raw.owner && raw.owner.name) || '',
    socials_json: '{}',
    email: Array.isArray(raw.emails) && raw.emails.length ? raw.emails[0] : '',
    booking_link: booking,
    whatsapp: '',
    branch_count: 1,
    areas_json: JSON.stringify(area ? { [area]: 1 } : {}),
    queries_json: JSON.stringify(query ? { [query]: 1 } : {}),
    found_count: 1,
    first_seen: now, last_seen: now, ts: now,
  };
}

// default exec: spawn gosom via docker for a single query line, return stdout text.
// Reads results from a mounted temp dir. Injectable so the runner/tests can fake it.
function dockerExec(line, opts) {
  // ponytail: c=3/depth=2 — 2 parallel jobs fit under 8GB RAM ceiling (RAM, not CPU, is the crash limit here)
  const { image = 'gosom/google-maps-scraper', depth = 2, concurrency = 3, timeoutMs = 300000, proxies = '' } = opts;
  const name = 'gmaps-' + Math.random().toString(36).slice(2, 10);
  const dockerKill = () => { try { spawn('docker', ['kill', name], { stdio: 'ignore' }); } catch {} };
  return new Promise((resolve, reject) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmaps-'));
    const rfile = path.join(tmp, 'r.json');
    fs.writeFileSync(path.join(tmp, 'q.txt'), line + '\n');
    const args = ['run', '--rm', '--name', name, '-v', `${tmp}:/out`, image,
      '-input', '/out/q.txt', '-json', '-results', '/out/r.json',
      '-depth', String(depth), '-c', String(concurrency)];
    if (proxies) args.push('-proxies', proxies);
    const p = spawn('docker', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '', settled = false;
    const readText = () => { try { return fs.readFileSync(rfile, 'utf8'); } catch { return ''; } };
    const cleanup = () => { clearTimeout(timer); clearInterval(poll); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
    const ok = () => { if (settled) return; settled = true; const t = readText(); cleanup(); resolve(t); };
    const fail = (e) => { if (settled) return; settled = true; cleanup(); reject(e); };
    const timer = setTimeout(() => { dockerKill(); fail(new Error('gosom timeout')); }, timeoutMs);
    // gosom sometimes hangs the container after "scrapemate exited"; once the result
    // file is written and stable, kill the container so `docker run` returns.
    // ponytail: stable-size poll fits one query per cell; revisit if a cell streams for minutes.
    let lastSize = -1, stableHits = 0;
    const poll = setInterval(() => {
      let size = -1; try { size = fs.statSync(rfile).size; } catch {}
      if (size > 0 && size === lastSize) { if (++stableHits >= 2) dockerKill(); } else stableHits = 0;
      lastSize = size;
    }, 3000);
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => { dockerKill(); fail(e); });
    p.on('close', (code) => {
      if (code !== 0 && !readText()) return fail(new Error(`gosom exit ${code}: ${err.slice(0, 200)}`));
      ok();
    });
  });
}

// run one cell -> mapped leads (capped). exec injectable for tests.
export async function runCell(cell, opts = {}, exec = dockerExec) {
  const { city = '', cap = 60 } = opts;
  const line = buildQueryLine(cell.query, cell.area, city);
  const text = await exec(line, opts);
  const raw = parseGosomOutput(text).slice(0, cap);
  return raw.map(r => mapGosom(r, cell));
}

export const provider = { id: 'google_maps', buildQueryLine, parseGosomOutput, mapGosom, runCell };
