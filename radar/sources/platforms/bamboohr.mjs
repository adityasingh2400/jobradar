// BambooHR ATS career pages (<company>.bamboohr.com/careers).
//
// Job URLs:  https://<co>.bamboohr.com/careers/<id>[/][detail]
//            https://<co>.bamboohr.com/jobs/view.php?id=<id>      (legacy)
//            https://<co>.bamboohr.com/hiring/jobs/<id>            (rare)
// Job ids are small per-company integers, so sid = bamboo:<co>:<id>.
//
// List:   GET https://<co>.bamboohr.com/careers/list
//         -> { meta:{totalCount}, result:[{ id, jobOpeningName, location:{city,state},
//              atsLocation:{country,state,province,city}, isRemote, employmentStatusLabel, ... }] }
//         Every open job in one response (no paging).
// Detail: GET https://<co>.bamboohr.com/careers/<id>/detail
//         -> result.jobOpening.{ datePosted, compensation, location{...,addressCountry} }.
//         Fetched only for NEW intern jobs, at most DETAIL_PER_POLL per poll, cached per process.

const HOST_RE = /^([a-z0-9][a-z0-9-]*)\.bamboohr\.com$/i;
const RESERVED = new Set(['www', 'api', 'app', 'help', 'marketplace', 'partners', 'status', 'go']);
const DETAIL_PER_POLL = 4;
const detailCache = new Map(); // "co:id" -> { postedAt, comp, loc }

function parse(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const m = u.hostname.match(HOST_RE);
  if (!m || RESERVED.has(m[1].toLowerCase())) return null;
  const co = m[1].toLowerCase();
  let id = null;
  const p = u.pathname;
  let mm = p.match(/^\/(?:careers|hiring\/jobs|jobs)\/(\d+)(?:[/?#]|$)/i);
  if (mm) id = mm[1];
  if (!id && /\/jobs\/view\.php$/i.test(p)) id = (u.searchParams.get('id') || '').match(/^\d+$/)?.[0] || null;
  return { co, id };
}

function locString(l = {}, ats = {}) {
  const city = l.city || ats.city;
  const state = l.state || ats.state || ats.province;
  const country = l.addressCountry || ats.country;
  return [city, state, country].filter(Boolean).join(', ');
}

const isoOrNull = (s) => {
  if (!s) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export default {
  id: 'bamboo',
  label: 'BambooHR',
  kind: 'platform',
  interval: 1500,

  instanceFromUrl(url, company) {
    const p = parse(url);
    if (!p) return null;
    return { key: `bamboo:${p.co}`, company: company || p.co, co: p.co };
  },

  seedInstances: [],

  canon(url) {
    const p = parse(url);
    return p?.id ? `bamboo:${p.co}:${p.id}` : null;
  },

  async poll(instance, ctx) {
    const co = instance.co || String(instance.key).replace(/^bamboo:/, '');
    const origin = `https://${co}.bamboohr.com`;
    const res = await ctx.http.request(`${origin}/careers/list`, { as: 'json' });
    const d = res.data;
    // Disabled career sites redirect to bamboohr.com marketing pages / return HTML -> request() throws badjson.
    if (!d || !Array.isArray(d.result)) throw new Error(`bamboo: unexpected /careers/list payload for ${co}`);

    const interns = d.result.filter((j) => j && j.id != null && ctx.isInternTitle(String(j.jobOpeningName || '')));

    const todo = interns.map((j) => `${co}:${j.id}`).filter((k) => !detailCache.has(k)).slice(0, DETAIL_PER_POLL);
    await ctx.http.mapLimit(todo, 2, async (k) => {
      const id = k.split(':')[1];
      try {
        const dd = await ctx.http.json(`${origin}/careers/${id}/detail`, { retries: 1 });
        const jo = dd?.result?.jobOpening || {};
        detailCache.set(k, {
          postedAt: isoOrNull(jo.datePosted),
          comp: jo.compensation ? String(jo.compensation).trim() : null,
          loc: locString(jo.location, jo.atsLocation),
        });
      } catch (e) {
        if (e?.status === 404) detailCache.set(k, {});
      }
    });
    if (detailCache.size > 20_000) detailCache.clear();

    const seen = new Set();
    const items = [];
    for (const j of interns) {
      const id = String(j.id);
      if (seen.has(id)) continue;
      seen.add(id);
      const det = detailCache.get(`${co}:${id}`) || {};
      const locs = [];
      const loc = locString(j.location, j.atsLocation) || det.loc;
      if (loc) locs.push(loc);
      if (j.isRemote || String(j.locationType) === '1') locs.push(loc ? `Remote (${loc})` : 'Remote');
      items.push({
        sid: `bamboo:${co}:${id}`,
        title: String(j.jobOpeningName).replace(/\s+/g, ' ').trim(),
        url: `${origin}/careers/${id}`,
        locations: [...new Set(locs)],
        postedAt: det.postedAt ?? null,
        comp: det.comp ?? null,
      });
    }
    return { complete: true, items };
  },
};
