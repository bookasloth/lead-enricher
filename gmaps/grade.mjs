// gmaps/grade.mjs — STEP 3: product-fit grading for Book A Sloth.
// Faithful Node/ESM port of Leader's deterministic grader (D:/My Development/Leader
// src/lib/score.ts + the classifyCategory/detectStatus/config bits it needs).
// Pure, zero-dep, synchronous. Input maps 1:1 from a gmaps_leads row.
//
// Keep in sync with Leader/src/lib/{score,normalize,config}.ts. Ported verbatim
// (types stripped) so behaviour matches; the parity test asserts the same
// invariants Leader's scripts/selfcheck.ts checks.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---- config (from Leader/src/lib/config.ts) ----
export const DEFAULT_PROFILE = {
  name: 'Book A Sloth — Nagpur',
  weights: {
    appointment_fit: 30, automation_opportunity: 20, business_activity: 15,
    customer_volume: 15, online_presence: 10, contactability: 10,
  },
  aggressiveness: 'balanced', // conservative | balanced | strict
  booking_policy: 'equal',    // equal | lower | exclude
  review_weight: 'supporting', // supporting | strong | ignore
};

// Normalized category groups + appointment-fit tier, matched by keyword against
// the raw category. First match wins; order matters (specific → general).
const CATEGORY_RULES = [
  { group: 'Dental / Ortho', tier: 'VERY_HIGH', kws: ['dental', 'dentist', 'orthodont', 'endodont', 'prosthodont', 'periodont'] },
  { group: 'Beauty & Salon', tier: 'VERY_HIGH', kws: ['beauty', 'salon', 'hairdress', 'hair salon', 'make-up', 'makeup', 'nail', 'spa', 'waxing', 'eyebrow', 'lash', 'barber', 'parlour', 'parlor', 'beautician', 'threading', 'tattoo', 'piercing'] },
  { group: 'Skin / Derma', tier: 'VERY_HIGH', kws: ['skin', 'derma', 'cosmetolog', 'laser', 'aesthet', 'tricholog', 'hair transplant', 'slimming'] },
  { group: 'Physio / Rehab', tier: 'VERY_HIGH', kws: ['physio', 'physical therap', 'rehab', 'chiroprac', 'occupational therap', 'speech therap', 'osteopath'] },
  { group: 'Doctor / Clinic', tier: 'HIGH', kws: ['doctor', 'clinic', 'physician', 'surgeon', 'gynecolog', 'gynaecolog', 'pediatric', 'paediatric', 'orthoped', 'orthopaed', 'ophthalm', 'eye ', 'ent ', 'cardiolog', 'neurolog', 'nephrolog', 'urolog', 'oncolog', 'psychiat', 'psycholog', 'homeopath', 'ayurved', 'unani', 'diabetolog', 'endocrin', 'gastroenter', 'pulmonolog', 'nutrition', 'dietician', 'dietitian', 'veterinar', 'wellness', 'ivf', 'fertility', 'medical', 'hospital', 'diagnostic', 'pathology', 'radiolog', 'dental laborator'] },
  { group: 'Fitness / Sports', tier: 'HIGH', kws: ['gym', 'fitness', 'yoga', 'pilates', 'zumba', 'crossfit', 'aerobic', 'sports club', 'sports complex', 'playground', 'stadium', 'arena', 'academy', 'coaching center', 'coaching centre', 'dance', 'martial', 'karate', 'swim', 'turf', 'badminton', 'cricket', 'basketball court', 'tennis court', 'football', 'skating', 'boxing', 'personal trainer'] },
  { group: 'Accounting / Finance', tier: 'MEDIUM', kws: ['chartered accountant', 'accountant', 'accounting', 'tax consultant', 'tax ', 'cpa', 'certified public', 'audit', 'financial', 'gst', 'bookkeep', 'loan', 'insurance agen', 'investment', 'wealth', 'mutual fund'] },
  { group: 'Legal / Consulting', tier: 'MEDIUM', kws: ['legal', 'lawyer', 'advocate', 'attorney', 'notary', 'consultant', 'consulting', 'immigration', 'architect', 'interior design', 'company secretar'] },
  { group: 'Education / Tutoring', tier: 'HIGH', kws: ['tutor', 'tuition', 'coaching classes', 'education', 'institute', 'training', 'learning', 'music class', 'music school', 'driving school', 'preschool', 'play school'] },
  { group: 'Photography / Events', tier: 'HIGH', kws: ['photograph', 'videograph', 'wedding', 'event', 'catering', 'banquet', 'studio'] },
  { group: 'Repair / Home Services', tier: 'MEDIUM', kws: ['repair', 'service center', 'service centre', 'plumber', 'electrician', 'pest control', 'cleaning', 'car wash', 'auto '] },
  { group: 'Retail / Store', tier: 'LOW', kws: ['store', 'shop', 'mart', 'supermarket', 'grocery', 'wholesale', 'dealer', 'showroom', 'boutique', 'goods'] },
  { group: 'Food & Dining', tier: 'LOW', kws: ['restaurant', 'cafe', 'coffee', 'bakery', 'sweet', 'hotel', 'dhaba', 'fast food', 'bar ', 'pub', 'canteen', 'tiffin'] },
];

export function classifyCategory(cat) {
  const c = ` ${(cat || '').toLowerCase()} `;
  for (const rule of CATEGORY_RULES) {
    if (rule.kws.some((k) => c.includes(k))) return { group: rule.group, tier: rule.tier };
  }
  return { group: 'Other / Unclear', tier: 'UNCLEAR' };
}

function detectStatus(n) {
  const s = (n.business_status || '').toLowerCase();
  if (/perman/.test(s) || s === 'closed_permanently' || s === 'permanently_closed') return 'PERM_CLOSED';
  if (/temp/.test(s)) return 'TEMP_CLOSED';
  if (s === 'true') return 'PERM_CLOSED';
  if (/open|operational/.test(s)) return 'OPEN';
  return n.business_status ? 'UNKNOWN' : 'OPEN';
}

// ---- scoring (from Leader/src/lib/score.ts) ----
function detectPlatform(url) {
  const u = (url || '').toLowerCase();
  for (const [k, name] of [
    ['calendly', 'Calendly'], ['setmore', 'Setmore'], ['acuity', 'Acuity'],
    ['fresha', 'Fresha'], ['zocdoc', 'Zocdoc'], ['practo', 'Practo'],
    ['justdial', 'JustDial'], ['bookings', 'Generic'], ['appointlet', 'Appointlet'],
    ['wa.me', 'WhatsApp'], ['whatsapp', 'WhatsApp'],
  ]) if (u.includes(k)) return name;
  return url ? 'Unknown' : '';
}

function presence(n) {
  const phone = !!n.phone || n.has_phone === 'YES';
  const website = !!n.website || n.has_website === 'YES';
  const email = !!n.email || n.has_email === 'YES';
  const whatsapp = !!n.whatsapp || n.has_whatsapp === 'YES';
  const social = n.has_social === 'YES';

  let booking, platform = '';
  if (n.booking_link || n.has_booking === 'YES') { booking = 'DETECTED'; platform = detectPlatform(n.booking_link); }
  else if (n.has_booking === 'NO') booking = 'NOT_DETECTED';
  else if (n.has_booking === 'UNKNOWN') booking = 'NOT_CHECKED';
  else booking = website ? 'UNCLEAR' : 'NOT_CHECKED';

  return { phone, website, email, whatsapp, social, reachable: phone || email || whatsapp, booking, platform };
}

const TIER_FRAC = { VERY_HIGH: 1, HIGH: 0.73, MEDIUM: 0.47, UNCLEAR: 0.3, LOW: 0.07 };

function volumeFrac(reviews, policy) {
  if (policy === 'ignore' || reviews == null) return 0.4;
  const cap = policy === 'strong' ? 200 : 500;
  return clamp(Math.log10((reviews || 0) + 1) / Math.log10(cap), 0, 1);
}

// Grade one NormalizedRow. Returns the full audit object (matches Leader's Scored).
export function scoreLead(n, profile = DEFAULT_PROFILE) {
  const W = profile.weights;
  const { group, tier } = classifyCategory(n.google_category);
  const status = detectStatus(n);
  const p = presence(n);
  const reviews = n.review_count;
  const closed = status === 'PERM_CLOSED';
  const reasons = [];
  const concerns = [];

  const appointment_fit = Math.round(W.appointment_fit * TIER_FRAC[tier]);

  let autoFrac = { VERY_HIGH: 0.6, HIGH: 0.45, MEDIUM: 0.3, UNCLEAR: 0.25, LOW: 0.05 }[tier];
  if (p.booking === 'DETECTED') autoFrac = Math.min(autoFrac, 0.25);
  else if (tier === 'VERY_HIGH' || tier === 'HIGH') autoFrac += 0.3;
  if ((p.phone || p.whatsapp) && (tier === 'VERY_HIGH' || tier === 'HIGH')) autoFrac += 0.1;
  const automation_opportunity = Math.round(W.automation_opportunity * clamp(autoFrac, 0, 1));

  let actFrac = 0;
  if (!closed) {
    actFrac = 0.4;
    if ((n.rating ?? 0) > 0) actFrac += 0.25;
    if ((reviews ?? 0) > 0) actFrac += 0.2;
    if ((reviews ?? 0) >= 10) actFrac += 0.15;
  }
  const business_activity = Math.round(W.business_activity * clamp(actFrac, 0, 1));

  const customer_volume = Math.round(W.customer_volume * volumeFrac(reviews, profile.review_weight));

  let onFrac = 0;
  if (p.website) onFrac += 0.5;
  if (p.social) onFrac += 0.25;
  if (p.whatsapp) onFrac += 0.15;
  if (n.booking_link) onFrac += 0.1;
  const online_presence = Math.round(W.online_presence * clamp(onFrac, 0, 1));

  let cFrac = 0;
  if (p.phone) cFrac += 0.5;
  if (p.email) cFrac += 0.3;
  if (p.whatsapp) cFrac += 0.2;
  const contactability = Math.round(W.contactability * clamp(cFrac, 0, 1));

  const breakdown = { appointment_fit, automation_opportunity, business_activity, customer_volume, online_presence, contactability };
  const fit_score = clamp(appointment_fit + automation_opportunity + business_activity + customer_volume + online_presence + contactability, 0, 100);

  let confidence = tier === 'UNCLEAR' ? (n.google_category ? 50 : 30) : 90;
  const needs_review = confidence < 60;

  let opportunity;
  if (closed || tier === 'LOW') opportunity = 'Low';
  else if (p.booking === 'DETECTED') opportunity = 'Low';
  else if (tier === 'UNCLEAR') opportunity = 'Unknown';
  else if (p.booking === 'NOT_DETECTED') opportunity = 'High';
  else opportunity = 'Medium';

  const yesFit = profile.aggressiveness === 'strict' ? 68 : profile.aggressiveness === 'conservative' ? 50 : 58;
  const apptOk = tier === 'VERY_HIGH' || tier === 'HIGH' || tier === 'MEDIUM';
  const strictAppt = tier === 'VERY_HIGH' || tier === 'HIGH';
  let eligible;
  if (closed || tier === 'LOW' || (!p.reachable && fit_score < 44)) eligible = 'NO';
  else if (p.reachable && (profile.aggressiveness === 'strict' ? strictAppt : apptOk) && fit_score >= yesFit) eligible = 'YES';
  else eligible = 'MAYBE';

  let grade;
  if (fit_score >= 85) grade = 'A+';
  else if (fit_score >= 72) grade = 'A';
  else if (fit_score >= 58) grade = 'B';
  else if (fit_score >= 44) grade = 'C';
  else grade = 'D';
  if (eligible === 'NO' && (closed || tier === 'LOW')) grade = 'X';

  let priority;
  if (eligible === 'NO') priority = 'EXCLUDE';
  else if (eligible === 'MAYBE') priority = 'P3';
  else {
    const p1min = profile.aggressiveness === 'strict' ? 82 : profile.aggressiveness === 'conservative' ? 70 : 76;
    const strongAppt = tier === 'VERY_HIGH' || (tier === 'HIGH' && fit_score >= 72);
    const strong = strongAppt && p.reachable && fit_score >= p1min && opportunity !== 'Low' && !needs_review;
    priority = strong ? 'P1' : 'P2';
  }
  if (profile.booking_policy === 'lower' && p.booking === 'DETECTED' && priority === 'P1') priority = 'P2';
  if (profile.booking_policy === 'exclude' && p.booking === 'DETECTED') { priority = 'EXCLUDE'; eligible = 'NO'; }

  let dq = 0;
  if (n.name) dq += 10;
  if (n.google_category) dq += 10;
  if (p.phone) dq += 20;
  if (n.address) dq += 15;
  if (p.website) dq += 15;
  if (p.email) dq += 10;
  if (n.rating != null || reviews != null) dq += 10;
  if (n.maps_url || n.place_id) dq += 10;
  const data_quality = clamp(dq, 0, 100);

  if (apptOk) reasons.push(`${tier === 'MEDIUM' ? 'Consultation' : 'Appointment'}-driven business (${group})`);
  if (!closed && (reviews ?? 0) > 0) reasons.push(`Active local business (${reviews} reviews, ${n.rating ?? '?'}★)`);
  if (opportunity === 'High') reasons.push('No booking system detected — automation opportunity');
  if (opportunity === 'Medium' && p.booking === 'NOT_CHECKED') reasons.push('Booking status not verified (no website to check)');
  if (p.website) reasons.push('Website present');
  if (p.reachable) reasons.push('Reachable (' + [p.phone && 'phone', p.email && 'email', p.whatsapp && 'WhatsApp'].filter(Boolean).join('/') + ')');
  if (p.booking === 'DETECTED') reasons.push(`Existing booking system${p.platform && p.platform !== 'Unknown' ? ' (' + p.platform + ')' : ''} — lower opportunity`);

  if (closed) concerns.push('Permanently closed');
  if (tier === 'UNCLEAR') concerns.push('Category unclear — needs review');
  if (tier === 'LOW') concerns.push('Low product-fit category (retail/food)');
  if (!p.reachable) concerns.push('No usable contact channel');
  if (data_quality < 50) concerns.push('Incomplete data');

  return {
    normalized_category: group, appt_tier: tier, status, breakdown, fit_score,
    grade, eligible, priority, opportunity, booking: p.booking, booking_platform: p.platform,
    data_quality, confidence, needs_review, reasons, concerns,
  };
}

// ---- adapter: a stored gmaps_leads row -> Leader's NormalizedRow ----
// gmaps_leads already carries these columns 1:1; only `category` is renamed and
// business_status is absent (detectStatus then defaults to OPEN, which is correct
// for Google Maps rows — closed businesses are dropped by the scraper).
export function leadToNormalized(row) {
  return {
    name: row.name || '',
    google_category: row.category || '',
    locality: row.locality || '',
    address: row.address || '',
    city: '', state: '', country: '',
    phone: row.phone || '',
    whatsapp: row.whatsapp || '',
    email: row.email || '',
    website: row.website || '',
    booking_link: row.booking_link || '',
    rating: row.rating == null ? null : Number(row.rating),
    review_count: row.review_count == null ? null : Number(row.review_count),
    business_status: '',
    maps_url: row.maps_url || '',
    place_id: row.place_id || '',
    lat: row.lat ?? null, lng: row.lng ?? null,
    has_website: row.has_website, has_phone: row.has_phone, has_email: row.has_email,
    has_social: row.has_social, has_booking: row.has_booking, has_whatsapp: row.has_whatsapp,
  };
}

// STEP 3 entry point: grade one stored lead row. Returns the columns to persist.
export function gradeLead(row, profile = DEFAULT_PROFILE) {
  const s = scoreLead(leadToNormalized(row), profile);
  return {
    fit_score: s.fit_score,
    grade: s.grade,
    priority: s.priority,
    marketing_eligible: s.eligible,
    opportunity: s.opportunity,
    grade_confidence: s.confidence,
    grade_json: JSON.stringify({
      appt_tier: s.appt_tier, normalized_category: s.normalized_category,
      breakdown: s.breakdown, data_quality: s.data_quality, needs_review: s.needs_review,
      booking: s.booking, booking_platform: s.booking_platform,
      reasons: s.reasons, concerns: s.concerns,
    }),
  };
}
