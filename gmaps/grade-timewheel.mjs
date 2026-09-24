// gmaps/grade-timewheel.mjs — digital-gap opportunity grader for Timewheel.
// Parallel to gmaps/grade.mjs (Book A Sloth). Pure. High business_value + big
// gaps + reachable => A/P1. Gaps flagged only from evidence (true), never from
// null/UNKNOWN. Weights in timewheel-scoring.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { composePitch } from './pitch.mjs';

const DEFAULTS = {
  weights: { business_value: 30, web_gap: 18, mobile_seo_gap: 14, geo_aeo_gap: 18, social_gap: 8, contactability: 10 },
  reviewCap: 500, ratingMinReviews: 10, grades: { A: 72, B: 56, C: 40 },
};

export function loadTwConfig(file) {
  const f = file || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'timewheel-scoring.json');
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return { ...DEFAULTS, ...j, weights: { ...DEFAULTS.weights, ...(j.weights || {}) }, grades: { ...DEFAULTS.grades, ...(j.grades || {}) } };
  } catch { return DEFAULTS; }
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const isYes = (v) => v === 'YES';
const isNo = (v) => v === 'NO'; // explicit evidence of absence

// A gap is "present" only when we have positive evidence: the audit flag is true.
const on = (v) => v === true;

export function gradeTimewheel(lead, audit = {}, cfg = DEFAULTS) {
  const W = cfg.weights;
  const web = audit.web || {};
  const geo = audit.geo || {};
  const noSite = isNo(lead.has_website) || !lead.website;
  const gaps = [];
  let score = 0;

  // business_value: reviews (log) + rating + multi-branch. Proof they can pay.
  const rc = Number(lead.review_count) || 0;
  const rating = Number(lead.rating) || 0;
  let bvFrac = clamp(Math.log10(rc + 1) / Math.log10(cfg.reviewCap + 1), 0, 1) * 0.7;
  if (rating > 0 && rc >= cfg.ratingMinReviews) bvFrac += ((clamp((rating - 3) / 2, 0, 1)) * 0.2);
  if ((Number(lead.branch_count) || 1) > 1) bvFrac += 0.1;
  score += W.business_value * clamp(bvFrac, 0, 1);

  // web_gap: no site (max) or dead/insecure.
  let webFrac = 0;
  if (noSite) { webFrac = 1; gaps.push('no_website'); }
  else {
    if (on(web.dead)) { webFrac += 0.7; gaps.push('dead_site'); }
    if (on(web.no_ssl)) { webFrac += 0.3; gaps.push('no_ssl'); }
  }
  score += W.web_gap * clamp(webFrac, 0, 1);

  // mobile_seo_gap: only when a live site was observed.
  let msFrac = 0;
  if (noSite) msFrac = 1;
  else {
    if (on(web.not_mobile)) { msFrac += 0.4; gaps.push('not_mobile'); }
    if (on(web.no_seo)) { msFrac += 0.4; gaps.push('weak_seo'); }
    if (on(web.thin)) { msFrac += 0.2; gaps.push('thin'); }
  }
  score += W.mobile_seo_gap * clamp(msFrac, 0, 1);

  // geo_aeo_gap: no site => invisible to AI (max). Else from observed geo flags.
  let geoFrac = 0;
  if (noSite) geoFrac = 1;
  else {
    if (on(geo.no_schema)) { geoFrac += 0.3; gaps.push('no_schema'); }
    if (on(geo.ai_crawlers_blocked)) { geoFrac += 0.3; gaps.push('ai_crawlers_blocked'); }
    if (on(geo.no_answer_content)) { geoFrac += 0.2; gaps.push('no_answer_content'); }
    if (on(geo.no_llms_txt)) { geoFrac += 0.1; gaps.push('no_llms_txt'); }
    if (on(geo.no_sitemap)) { geoFrac += 0.1; gaps.push('no_sitemap'); }
  }
  score += W.geo_aeo_gap * clamp(geoFrac, 0, 1);

  // social_gap: explicit NO only.
  if (isNo(lead.has_social)) { score += W.social_gap; gaps.push('no_social'); }

  // contactability: can we reach them to pitch?
  const reachable = isYes(lead.has_phone) || isYes(lead.has_email) || isYes(lead.has_whatsapp);
  let cFrac = 0;
  if (isYes(lead.has_phone)) cFrac += 0.5;
  if (isYes(lead.has_email)) cFrac += 0.3;
  if (isYes(lead.has_whatsapp)) cFrac += 0.2;
  score += W.contactability * clamp(cFrac, 0, 1);

  const tw_score = clamp(Math.round(score), 0, 100);
  let tw_grade = 'D';
  if (tw_score >= cfg.grades.A) tw_grade = 'A';
  else if (tw_score >= cfg.grades.B) tw_grade = 'B';
  else if (tw_score >= cfg.grades.C) tw_grade = 'C';

  let tw_priority = 'P3';
  if (tw_grade === 'A' && reachable) tw_priority = 'P1';
  else if ((tw_grade === 'A' || tw_grade === 'B') && reachable) tw_priority = 'P2';

  return {
    tw_score, tw_grade, tw_priority,
    tw_gap_json: JSON.stringify(gaps),
    tw_pitch: composePitch(lead, gaps),
  };
}
