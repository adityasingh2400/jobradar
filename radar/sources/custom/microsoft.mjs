// Microsoft Careers (apply.careers.microsoft.com) — an Eightfold "PCSX" site.
//
// JSON search API used by the site itself:
//   GET /api/pcsx/search?domain=microsoft.com&query=&location=&start=N&sort_by=timestamp&filter_<name>=<value>
//   -> { data: { count, positions: [{ id, displayJobId, name, locations, standardizedLocations,
//                                    postedTs, creationTs, positionUrl: "/careers/job/<id>" }] } }
// Page size is fixed at 10. Cookieless requests share a very small rate-limit bucket (HTTP 429
// "Please try again later"); once the session cookies (_vs, _vscid, _vscidv2) set by the first
// response are sent back, paging is not throttled. We keep that cookie jar across polls.
//
// Coverage (verified against query=intern / internship / filter_seniority=Intern sweeps):
//   1. filter_employment_type=internship, newest first  (~80 postings)
//   2. query=intern restricted to the other employment types, catching the few intern-titled
//      jobs mis-typed as full-time (e.g. "Critical Environment Ops INTERN").
//
// Legacy jobs.careers.microsoft.com/global/en/job/<n> links (pre-2026 site) use a different id
// space and now redirect to the careers home page; canon() maps them to "msft:legacy-<n>" so they
// are still recognized as Microsoft but never collide with live postings.

const ORIGIN = 'https://apply.careers.microsoft.com';
const DOMAIN = 'microsoft.com';
const PAGE = 10;
const MAX_PAGES = 25; // per sweep

const SWEEPS = [
  { query: '', filters: [['employment_type', 'internship']] },
  {
    query: 'intern',
    filters: [['employment_type', 'full-time'], ['employment_type', 'temp/contract'], ['employment_type', 'post doc research']],
  },
];

const jar = new Map(); // module-level: session cookies survive across polls

function cookieHeader() { return [...jar].map(([k, v]) => `${k}=${v}`).join('; '); }
function absorbCookies(headers) {
  for (const c of headers?.getSetCookie?.() || []) {
    const kv = c.split(';')[0];
    const i = kv.indexOf('=');
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
}

function searchUrl(sweep, start) {
  const p = new URLSearchParams({ domain: DOMAIN, query: sweep.query, location: '', start: String(start), sort_by: 'timestamp' });
  for (const [k, v] of sweep.filters) p.append(`filter_${k}`, v);
  return `${ORIGIN}/api/pcsx/search?${p}`;
}

async function fetchPage(ctx, sweep, start) {
  const headers = { referer: `${ORIGIN}/careers?query=intern` };
  if (jar.size) headers.cookie = cookieHeader();
  const r = await ctx.http.request(searchUrl(sweep, start), { headers, retries: 3 });
  absorbCookies(r.headers);
  const d = r.data?.data;
  if (!d || !Array.isArray(d.positions)) throw new Error(`msft pcsx search: unexpected response ${JSON.stringify(r.data).slice(0, 200)}`);
  return d;
}

function sid(id) { return `msft:${id}`; }

export default {
  id: 'msft',
  label: 'Microsoft Careers',
  kind: 'company',
  interval: 300,
  instances: [{ key: 'msft', company: 'Microsoft' }],

  canon(url) {
    let u;
    try { u = new URL(url); } catch { return null; }
    const host = u.hostname.toLowerCase();
    if (host === 'apply.careers.microsoft.com' || host === 'microsoft.eightfold.ai') {
      // /careers/job/<id>[-slug], /careers?pid=<id>, /careers/apply?pid=<id>
      const m = u.pathname.match(/\/job\/(\d{6,})(?:[-/]|$)/);
      if (m) return sid(m[1]);
      const pid = u.searchParams.get('pid');
      return pid && /^\d{6,}$/.test(pid) ? sid(pid) : null;
    }
    if (host === 'jobs.careers.microsoft.com' || host === 'careers.microsoft.com') {
      const m = u.pathname.match(/\/job\/(\d{5,})(?:[/?#]|$)/);
      return m ? `msft:legacy-${m[1]}` : null;
    }
    return null;
  },

  async poll(instance, ctx) {
    const items = new Map();
    let complete = true;

    for (const sweep of SWEEPS) {
      let count = null;
      let fetched = 0;
      for (let page = 0; page < MAX_PAGES; page++) {
        const d = await fetchPage(ctx, sweep, page * PAGE);
        count = Number(d.count) || 0;
        fetched += d.positions.length;
        for (const p of d.positions) {
          const id = String(p.id || '');
          const title = String(p.name || '').trim();
          if (!/^\d+$/.test(id) || !title || items.has(id) || !ctx.isInternTitle(title)) continue;
          const locs = (p.standardizedLocations?.length ? p.standardizedLocations : p.locations) || [];
          const ts = Number(p.postedTs || p.creationTs);
          items.set(id, {
            sid: sid(id),
            title,
            url: `${ORIGIN}/careers/job/${id}`,
            company: 'Microsoft',
            locations: [...new Set(locs.map((l) => String(l).trim()).filter(Boolean))],
            postedAt: ts ? new Date(ts * 1000).toISOString() : null,
            comp: null,
          });
        }
        if (d.positions.length < PAGE || fetched >= count) break;
      }
      if (count == null || fetched < count) complete = false;
    }

    return { complete, items: [...items.values()] };
  },
};
