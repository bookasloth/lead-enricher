// gmaps/scoring.mjs — configurable lead score from OBSERVABLE signals only.
// Weights live in gmaps-scoring.json (not hardcoded). Emits score 0-100 + reasons
// so the UI/export can show WHY a lead scored what it did. UNKNOWN flags earn
// nothing and never penalize.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULTS = {
  weights: { reviewVolume: 22, rating: 12, hasWebsite: 15, multiBranch: 10, hasBooking: 12,
    hasWhatsapp: 8, hasSocial: 8, hasEmail: 10, hasPhone: 6 },
  reviewVolumeCap: 1000, ratingMinReviews: 10, highReviews: 100, moderateReviews: 25,
};

export function loadScoringConfig(file) {
  const f = file || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'gmaps-scoring.json');
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return { ...DEFAULTS, ...j, weights: { ...DEFAULTS.weights, ...(j.weights || {}) } };
  } catch { return DEFAULTS; }
}

const isYes = (v) => v === 'YES';

export function scoreLead(lead, cfg = DEFAULTS) {
  const W = cfg.weights;
  let score = 0; const reasons = [];

  const reviews = Number(lead.review_count) || 0;
  if (reviews > 0) {
    const frac = Math.min(1, Math.log10(reviews + 1) / Math.log10(cfg.reviewVolumeCap + 1));
    score += W.reviewVolume * frac;
    if (reviews >= cfg.highReviews) reasons.push('High review volume');
    else if (reviews >= cfg.moderateReviews) reasons.push('Moderate review volume');
  }

  const rating = Number(lead.rating) || 0;
  if (rating > 0 && reviews >= cfg.ratingMinReviews) {
    const frac = Math.max(0, Math.min(1, (rating - 3) / 2)); // 3.0->0, 5.0->1
    score += W.rating * frac;
    if (rating >= 4.5) reasons.push('Strong rating');
  }

  if (isYes(lead.has_website)) { score += W.hasWebsite; reasons.push('Website available'); }
  if ((Number(lead.branch_count) || 1) > 1) { score += W.multiBranch; reasons.push('Multiple locations'); }
  if (isYes(lead.has_booking)) { score += W.hasBooking; reasons.push('Online booking detected'); }
  if (isYes(lead.has_whatsapp)) { score += W.hasWhatsapp; reasons.push('WhatsApp present'); }
  if (isYes(lead.has_social)) { score += W.hasSocial; reasons.push('Social presence'); }
  if (isYes(lead.has_email)) { score += W.hasEmail; reasons.push('Email available'); }
  if (isYes(lead.has_phone)) { score += W.hasPhone; reasons.push('Phone available'); }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, reasons };
}
