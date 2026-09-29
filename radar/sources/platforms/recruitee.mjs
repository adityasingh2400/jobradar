// Recruitee career sites (<company>.recruitee.com).
//
// Job URLs:  https://<co>.recruitee.com/o/<offer-slug>[/c/new][?...]
//            https://<co>.recruitee.com/l/<lang>/o/<offer-slug>
// Offer slugs are unique per company -> sid = recruitee:<co>:<slug>.
//
// List:   GET https://<co>.recruitee.com/api/offers/ -> { offers:[{ id, slug, title, careers_url,
//         published_at, status, location, locations:[{name,city,state,country}], remote, salary{min,max,
//         period,currency} }] } — every published offer in one response (public careers-site API).

const HOST_RE = /^([a-z0-9][a-z0-9-]*)\.recruitee\.com$/i;
const RESERVED = new Set(['www', 'app', 'api', 'help', 'status', 'docs', 'blog', 'support', 'careers']);

function parse(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const m = u.hostname.match(HOST_RE);
  if (!m || RESERVED.has(m[1].toLowerCase())) return null;
  const pm = u.pathname.match(/^(?:\/l\/[a-z]{2}(?:-[a-z]{2})?)?\/o\/([^/?#]+)/i);
  return { co: m[1].toLowerCase(), slug: pm ? decodeURIComponent(pm[1]).toLowerCase() : null };
}

function fmtSalary(s) {
  if (!s || (!s.min && !s.max)) return null;
  const cur = !s.currency || s.currency === 'USD' ? '$' : `${s.currency} `;
  const f = (n) => `${cur}${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  const lo = s.min || s.max;
  const hi = s.max || s.min;
  const per = { hour: '/hr', month: '/mo', year: '/yr', week: '/wk', day: '/day' }[String(s.period || '').toLowerCase()] || '';
  return `${lo === hi ? f(lo) : `${f(lo)} - ${f(hi)}`}${per}`;
}

export default {
  id: 'recruitee',
  label: 'Recruitee',
  kind: 'platform',
  interval: 1800,

  instanceFromUrl(url, company) {
    const p = parse(url);
    if (!p) return null;
    return { key: `recruitee:${p.co}`, company: company || p.co, co: p.co };
  },

  seedInstances: [],

  canon(url) {
    const p = parse(url);
    return p?.slug ? `recruitee:${p.co}:${p.slug}` : null;
  },

  async poll(instance, ctx) {
    const co = instance.co || String(instance.key).replace(/^recruitee:/, '');
    const d = await ctx.http.json(`https://${co}.recruitee.com/api/offers/`);
    if (!Array.isArray(d?.offers)) throw new Error(`recruitee: unexpected /api/offers payload for ${co}`);

    const seen = new Set();
    const items = [];
    for (const o of d.offers) {
      if (o?.status && o.status !== 'published') continue;
      const title = String(o?.title || '').replace(/\s+/g, ' ').trim();
      const slug = String(o?.slug || '').toLowerCase();
      if (!slug || seen.has(slug) || !title || !ctx.isInternTitle(title)) continue;
      seen.add(slug);
      const locs = (Array.isArray(o.locations) && o.locations.length
        ? o.locations.map((l) => [l.city, l.state, l.country].filter(Boolean).join(', ') || l.name)
        : [o.location || [o.city, o.state_name, o.country].filter(Boolean).join(', ')]).filter(Boolean);
      if (o.remote && !locs.some((l) => /remote/i.test(l))) locs.push('Remote');
      const dt = o.published_at ? new Date(String(o.published_at).replace(' UTC', 'Z').replace(' ', 'T')) : null;
      items.push({
        sid: `recruitee:${co}:${slug}`,
        title,
        url: `https://${co}.recruitee.com/o/${encodeURIComponent(slug)}`,
        locations: [...new Set(locs)],
        postedAt: dt && !Number.isNaN(dt.getTime()) ? dt.toISOString() : null,
        comp: fmtSalary(o.salary),
      });
    }
    return { complete: true, items };
  },
};
