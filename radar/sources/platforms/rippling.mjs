// Rippling Recruiting job boards (ats.rippling.com/<board-slug>/jobs).
//
// Job URLs:  https://ats.rippling.com[/<locale>]/<board-slug>/jobs/<uuid>[/apply][?...]
//   e.g.     https://ats.rippling.com/rev-robotics/jobs/9f4e5d99-0bba-4e03-8018-e312810a3dba
//            https://ats.rippling.com/en-GB/acme/jobs/<uuid>
// Also seen: api.rippling.com/platform/api/ats/v1/board/<slug>/jobs/<uuid>, ats.us1.rippling.com.
//
// List:   GET https://ats.rippling.com/api/v2/board/<slug>/jobs?page=0&pageSize=1000
//         (the board's own Next.js client calls this; pageSize is capped at 1000 server-side)
//         -> { items:[{id,name,url,department,locations:[{name,city,state,country,workplaceType}]}],
//              page, pageSize, totalItems, totalPages }
//         With groupJobsByLocation boards one job appears once per location (same id) -> merged here.
//         Fallback: GET https://api.rippling.com/platform/api/ats/v1/board/<slug>/jobs (flat array).
// Detail: GET https://api.rippling.com/platform/api/ats/v1/board/<slug>/jobs/<uuid>
//         -> createdOn + payRangeDetails. Fetched only for NEW intern jobs, at most
//         DETAIL_PER_POLL per poll, and cached for the life of the process.
//
// sid = rippling:<uuid lowercase>  (uuids are global across boards)

const UUID_RE = /\/jobs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=[/?#]|$)/i;
const HOST_RE = /(^|\.)rippling\.com$/i;
const DETAIL_PER_POLL = 4;
const detailCache = new Map(); // uuid -> { postedAt, comp }

function parse(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!HOST_RE.test(u.hostname)) return null;
  if (!/^(ats(\.[a-z0-9]+)?|api)\.rippling\.com$/i.test(u.hostname)) return null;
  const segs = u.pathname.split('/').filter(Boolean);
  const i = segs.indexOf('jobs');
  if (i < 1) return null;
  const slug = decodeURIComponent(segs[i - 1]);
  if (!/^[A-Za-z0-9._-]+$/.test(slug) || slug === 'board') return null;
  const m = u.pathname.match(UUID_RE);
  return { slug, uuid: m ? m[1].toLowerCase() : null };
}

const isoOrNull = (s) => {
  if (!s) return null;
  const d = new Date(String(s).replace(/(\.\d{3})\d+/, '$1'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const CUR = { USD: '$', CAD: 'CA$', EUR: '€', GBP: '£', AUD: 'A$', INR: '₹' };
const FREQ = { HOUR: '/hr', HOURLY: '/hr', MONTH: '/mo', MONTHLY: '/mo', YEAR: '/yr', YEARLY: '/yr', ANNUAL: '/yr', WEEK: '/wk', DAY: '/day' };
function fmtPay(ranges) {
  const r = (ranges || []).find((x) => x && (x.rangeStart || x.rangeEnd));
  if (!r) return null;
  const sym = CUR[r.currency] ?? (r.currency ? `${r.currency} ` : '');
  const n = (v) => `${sym}${Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  const lo = r.rangeStart || r.rangeEnd;
  const hi = r.rangeEnd || r.rangeStart;
  const per = FREQ[String(r.frequency || '').toUpperCase()] ?? '';
  return `${lo === hi ? n(lo) : `${n(lo)} - ${n(hi)}`}${per}`;
}

async function listJobs(slug, ctx) {
  const base = `https://ats.rippling.com/api/v2/board/${encodeURIComponent(slug)}/jobs`;
  try {
    const all = [];
    let complete = true;
    for (let page = 0; page < 3; page++) {
      const d = await ctx.http.json(`${base}?page=${page}&pageSize=1000`, { timeout: 30_000 });
      if (!d || !Array.isArray(d.items)) throw new Error('unexpected v2 payload');
      all.push(...d.items);
      if (page + 1 >= (d.totalPages ?? 1)) break;
      if (page === 2) complete = false;
    }
    return {
      complete,
      jobs: all.map((j) => ({
        id: String(j.id || '').toLowerCase(),
        title: String(j.name || '').trim(),
        url: j.url,
        locations: (j.locations || []).map((l) => l?.name).filter(Boolean),
      })),
    };
  } catch (e) {
    // "Job Board not found" -> v1 says the same; don't spend a second request on it.
    if (e?.status === 404 && /RESOURCE_NOT_FOUND|not found/i.test(e.body || '')) throw e;
    // v2 changed shape or failed: fall back to the older public v1 board API (one flat array).
    const d = await ctx.http.json(`https://api.rippling.com/platform/api/ats/v1/board/${encodeURIComponent(slug)}/jobs`, { timeout: 30_000 });
    if (!Array.isArray(d)) throw new Error('rippling: unexpected v1 payload');
    return {
      complete: true,
      jobs: d.map((j) => ({
        id: String(j.uuid || '').toLowerCase(),
        title: String(j.name || '').trim(),
        url: j.url,
        locations: [j.workLocation?.label].filter(Boolean),
      })),
    };
  }
}

export default {
  id: 'rippling',
  label: 'Rippling ATS',
  kind: 'platform',
  interval: 1200,

  instanceFromUrl(url, company) {
    const p = parse(url);
    if (!p) return null;
    return { key: `rippling:${p.slug.toLowerCase()}`, company: company || p.slug, slug: p.slug };
  },

  seedInstances: [],

  canon(url) {
    const p = parse(url);
    return p?.uuid ? `rippling:${p.uuid}` : null;
  },

  async poll(instance, ctx) {
    const slug = instance.slug || String(instance.key).replace(/^rippling:/, '');
    const { complete, jobs } = await listJobs(slug, ctx);

    // merge one-row-per-location duplicates
    const byId = new Map();
    for (const j of jobs) {
      if (!j.id || !j.title || !ctx.isInternTitle(j.title)) continue;
      const prev = byId.get(j.id);
      if (prev) {
        for (const l of j.locations) if (!prev.locations.includes(l)) prev.locations.push(l);
      } else {
        byId.set(j.id, { ...j, locations: [...j.locations] });
      }
    }

    // enrich new jobs with createdOn / pay (bounded per poll, cached)
    const todo = [...byId.keys()].filter((id) => !detailCache.has(id)).slice(0, DETAIL_PER_POLL);
    await ctx.http.mapLimit(todo, 2, async (id) => {
      try {
        const d = await ctx.http.json(`https://api.rippling.com/platform/api/ats/v1/board/${encodeURIComponent(slug)}/jobs/${id}`, { retries: 1 });
        detailCache.set(id, { postedAt: isoOrNull(d?.createdOn), comp: fmtPay(d?.payRangeDetails) });
      } catch (e) {
        if (e?.status === 404) detailCache.set(id, { postedAt: null, comp: null });
      }
    });
    if (detailCache.size > 20_000) detailCache.clear();

    const items = [...byId.values()].map((j) => {
      const d = detailCache.get(j.id) || {};
      return {
        sid: `rippling:${j.id}`,
        title: j.title.replace(/\s+/g, ' '),
        url: j.url && UUID_RE.test(j.url) ? j.url : `https://ats.rippling.com/${slug}/jobs/${j.id}`,
        locations: j.locations,
        postedAt: d.postedAt ?? null,
        comp: d.comp ?? null,
      };
    });
    return { complete, items };
  },
};
