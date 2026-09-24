// gmaps/web-kind.mjs — classify a lead's `website` into a real owned site vs a
// stand-in (social profile, free page builder, or directory listing). Pure.
// Feeds a per-lead segment (web_kind) + the specific platform (web_platform) so
// outreach can be tailored: an Instagram-only shop gets a different pitch than a
// business sitting on a JustDial listing or one with no presence at all.

// Ordered: first match wins. label = what we tag; group = pitch bucket.
const STANDINS = [
  { m: 'instagram',        label: 'instagram',    group: 'social' },
  { m: 'facebook',         label: 'facebook',     group: 'social' },
  { m: 'fb.com',           label: 'facebook',     group: 'social' },
  { m: 'x.com',            label: 'twitter_x',    group: 'social' },
  { m: 'twitter',          label: 'twitter_x',    group: 'social' },
  { m: 'youtube',          label: 'youtube',      group: 'social' },
  { m: 'youtu.be',         label: 'youtube',      group: 'social' },
  { m: 'wa.me',            label: 'whatsapp',     group: 'social' },
  { m: 'whatsapp',         label: 'whatsapp',     group: 'social' },
  { m: 'linktr',           label: 'linktree',     group: 'social' },
  { m: 't.me',             label: 'telegram',     group: 'social' },
  { m: 'sites.google.com', label: 'google_sites', group: 'free_builder' },
  { m: 'business.site',    label: 'google_business_site', group: 'free_builder' },
  { m: 'wixsite.com',      label: 'wix',          group: 'free_builder' },
  { m: 'wix.com',          label: 'wix',          group: 'free_builder' },
  { m: 'wordpress.com',    label: 'wordpress_com', group: 'free_builder' },
  { m: 'blogspot',         label: 'blogspot',     group: 'free_builder' },
  { m: 'weebly',           label: 'weebly',       group: 'free_builder' },
  { m: 'godaddysites',     label: 'godaddy',      group: 'free_builder' },
  { m: 'dudaone',          label: 'duda',         group: 'free_builder' },
  { m: 'justdial',         label: 'justdial',     group: 'directory' },
  { m: 'practo',           label: 'practo',       group: 'directory' },
  { m: 'sulekha',          label: 'sulekha',      group: 'directory' },
  { m: 'indiamart',        label: 'indiamart',    group: 'directory' },
  { m: 'tradeindia',       label: 'tradeindia',   group: 'directory' },
  { m: 'zomato',           label: 'zomato',       group: 'directory' },
  { m: 'swiggy',           label: 'swiggy',       group: 'directory' },
  { m: 'tripadvisor',      label: 'tripadvisor',  group: 'directory' },
  { m: 'urbanpro',         label: 'urbanpro',     group: 'directory' },
  { m: 'yellowpages',      label: 'yellowpages',  group: 'directory' },
  { m: '99acres',          label: '99acres',      group: 'directory' },
  { m: 'magicbricks',      label: 'magicbricks',  group: 'directory' },
  { m: 'housing.com',      label: 'housing',      group: 'directory' },
  { m: 'olx',              label: 'olx',          group: 'directory' },
  { m: 'quikr',            label: 'quikr',        group: 'directory' },
  { m: 'near.in',          label: 'nearin',       group: 'directory' },
  { m: 'askme',            label: 'askme',        group: 'directory' },
  { m: 'maps.google',      label: 'google_maps',  group: 'directory' },
  { m: 'goo.gl',           label: 'google_maps',  group: 'directory' },
];

// classifyWeb(website) -> { kind, platform, group }
//   kind:     'none' | 'free_site' | 'own'
//   platform: '' (none) | the stand-in service (free_site) | the real hostname (own)
//   group:    '' (none/own) | 'social' | 'free_builder' | 'directory' (free_site)
export function classifyWeb(website) {
  const raw = String(website || '').trim();
  if (!raw) return { kind: 'none', platform: '', group: '' };
  let host = raw.toLowerCase();
  try { host = new URL(raw).hostname.replace(/^www\./, '').toLowerCase(); } catch { /* keep raw */ }
  const hit = STANDINS.find(s => host.includes(s.m));
  if (hit) return { kind: 'free_site', platform: hit.label, group: hit.group };
  return { kind: 'own', platform: host, group: '' };
}
