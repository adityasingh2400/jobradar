// Eightfold.ai career sites: <tenant>.eightfold.ai/careers/job/<id> plus custom domains
// (explore.jobs.netflix.net, careers.qualcomm.com, ...). Microsoft runs on Eightfold too but has
// its own adapter (custom/microsoft.mjs), so its hosts are deliberately NOT claimed here.
//
// Eightfold serves two generations of public JSON search APIs; a tenant only answers one of them
// (the other returns 403, e.g. {"message": "Not authorized for PCSX"}):
//   PCSX (most tenants): GET /api/pcsx/search?domain=<d>&query=<q>&location=&start=<n>&sort_by=timestamp
//        -> { data: { count, positions: [{ id, name, locations, standardizedLocations, postedTs, positionUrl }] } }
//        `domain` is required (422 without it); we read it from the /careers page config.
//   legacy ("apply v2", e.g. Netflix): GET /api/apply/v2/jobs?domain=<d>&start=<n>&num=10&query=<q>&sort_by=timestamp
//        -> { count, positions: [{ id, name, locations, t_create, canonicalPositionUrl }] }
// Both page 10 results at a time. Cookieless requests share a tight rate-limit bucket (429), so we
// keep the session cookies each host sets and send them back.
//
// Eightfold's search is semantic: "intern" also matches internship / apprentice / trainee titles,
// but not "Co-op" titles, so we sweep "intern" and "co-op" and filter with isInternTitle.

const ALIASES = {
  // custom domain -> tenant (the <tenant>.eightfold.ai subdomain serving the same site)
  'explore.jobs.netflix.net': 'netflix',
  'jobs.netflix.net': 'netflix',
  'careers.qualcomm.com': 'qualcomm',
};
// Hosts/tenants that are not company career sites, or that another adapter owns.
const EXCLUDED_TENANT = /^(www|app|api|static|docs|help|support|status|microsoft(-.*)?)$/;

const QUERIES = ['intern', 'co-op'];
const PAGE = 10;
const MAX_PAGES = 30; // per query

const hostState = new Map(); // host -> { domain, mode: 'pcsx'|'legacy', cookies: Map }

function tenantOfHost(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (ALIASES[h]) return ALIASES[h];
  const m = h.match(/^([a-z0-9][a-z0-9-]*)\.eightfold\.ai$/);
  if (!m || EXCLUDED_TENANT.test(m[1])) return null;
  return m[1];
}

function jobIdOf(u) {
  const m = u.pathname.match(/\/careers\/job\/(\d{5,})(?:[-/]|$)/i);
  if (m) return m[1];
  const pid = u.searchParams.get('pid');
  if (pid && /^\d{5,}$/.test(pid) && /\/careers/i.test(u.pathname)) return pid;
  return null;
}

const sidOf = (tenant, id) => `ef:${tenant}:${id}`;

function stateFor(host) {
  let s = hostState.get(host);
  if (!s) { s = { domain: null, domainGuessed: false, mode: null, cookies: new Map() }; hostState.set(host, s); }
  return s;
}

function absorbCookies(st, headers) {
  for (const c of headers?.getSetCookie?.() || []) {
    const kv = c.split(';')[0];
    const i = kv.indexOf('=');
    if (i > 0) st.cookies.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
}

async function get(ctx, st, host, url, as = 'json') {
  const headers = { referer: `https://${host}/careers` };
  if (st.cookies.size) headers.cookie = [...st.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  const r = await ctx.http.request(url, { headers, as, retries: 3 });
  absorbCookies(st, r.headers);
  return r.data;
}

async function discoverDomain(ctx, st, host, tenant) {
  try {
    const html = await get(ctx, st, host, `https://${host}/careers`, 'text');
    const m = html.match(/&#34;domain&#34;:\s*&#34;([^&\s]+)&#34;/) || html.match(/"domain"\s*:\s*"([a-z0-9.-]+\.[a-z]{2,})"/i);
    if (m) return m[1];
  } catch (e) {
    ctx.log(`eightfold ${host}: domain discovery failed (${e.message})`);
  }
  st.domainGuessed = true; // an empty result under a guessed domain must not close every job
  return `${tenant}.com`;
}

function pcsxUrl(host, domain, q, start) {
  const p = new URLSearchParams({ domain, query: q, location: '', start: String(start), sort_by: 'timestamp' });
  return `https://${host}/api/pcsx/search?${p}`;
}
function legacyUrl(host, domain, q, start) {
  const p = new URLSearchParams({ domain, start: String(start), num: String(PAGE), query: q, sort_by: 'timestamp' });
  return `https://${host}/api/apply/v2/jobs?${p}`;
}

async function searchPage(ctx, st, host, q, start) {
  if (st.mode === 'legacy') {
    const d = await get(ctx, st, host, legacyUrl(host, st.domain, q, start));
    if (!Array.isArray(d?.positions)) throw new Error(`eightfold ${host}: unexpected legacy response`);
    return { count: Number(d.count) || 0, positions: d.positions };
  }
  const d = (await get(ctx, st, host, pcsxUrl(host, st.domain, q, start)))?.data;
  if (!Array.isArray(d?.positions)) throw new Error(`eightfold ${host}: unexpected pcsx response`);
  return { count: Number(d.count) || 0, positions: d.positions };
}

// First request of a poll: figure out (and cache) which API generation this tenant speaks.
async function firstPage(ctx, st, host, q) {
  if (st.mode) return searchPage(ctx, st, host, q, 0);
  let err;
  for (const mode of ['pcsx', 'legacy']) {
    st.mode = mode;
    try { return await searchPage(ctx, st, host, q, 0); } catch (e) {
      err = e;
      if (!(e?.status === 403 || e?.status === 404 || e?.status === 422 || /unexpected/.test(e?.message))) break;
    }
  }
  st.mode = null;
  throw err;
}

function locationsOf(p) {
  const raw = (Array.isArray(p.standardizedLocations) && p.standardizedLocations.length ? p.standardizedLocations : p.locations)
    || (p.location ? [p.location] : []);
  const out = [];
  for (const l of raw) {
    const s = String(l || '').replace(/\s*\|\s*N\/A\s*$/i, '').replace(/,(?=\S)/g, ', ').trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

function postedOf(p) {
  const ts = Number(p.postedTs || p.t_create || p.creationTs);
  return ts > 0 ? new Date(ts * 1000).toISOString() : null;
}

export default {
  id: 'ef',
  label: 'Eightfold',
  kind: 'platform',
  interval: 600,

  instanceFromUrl(url, company) {
    let u;
    try { u = new URL(url); } catch { return null; }
    const host = u.hostname.toLowerCase();
    const tenant = tenantOfHost(host);
    if (!tenant) return null;
    const domain = u.searchParams.get('domain');
    return {
      key: `ef:${tenant}`,
      company,
      host,
      tenant,
      domain: domain && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain) ? domain.toLowerCase() : null,
    };
  },

  seedInstances: [
    { key: 'ef:netflix', company: 'Netflix', host: 'explore.jobs.netflix.net', tenant: 'netflix', domain: 'netflix.com' },
    { key: 'ef:qualcomm', company: 'Qualcomm', host: 'qualcomm.eightfold.ai', tenant: 'qualcomm', domain: 'qualcomm.com' },
  ],

  canon(url) {
    let u;
    try { u = new URL(url); } catch { return null; }
    const tenant = tenantOfHost(u.hostname);
    if (!tenant) return null;
    const id = jobIdOf(u);
    return id ? sidOf(tenant, id) : null;
  },

  async poll(instance, ctx) {
    const host = String(instance.host || '').toLowerCase();
    const tenant = instance.tenant || tenantOfHost(host);
    if (!host || !tenant) throw new Error(`eightfold: bad instance ${JSON.stringify(instance)}`);
    const st = stateFor(host);
    st.domain ||= instance.domain || (await discoverDomain(ctx, st, host, tenant));

    const items = new Map();
    let complete = true;
    let okQueries = 0;
    let lastErr;

    for (const q of QUERIES) {
      try {
        let d = await firstPage(ctx, st, host, q);
        let fetched = 0;
        for (let page = 0; ; ) {
          fetched += d.positions.length;
          for (const p of d.positions) {
            const id = String(p.id ?? '');
            const title = String(p.name || p.posting_name || '').trim();
            if (!/^\d+$/.test(id) || !title || items.has(id) || !ctx.isInternTitle(title)) continue;
            items.set(id, {
              sid: sidOf(tenant, id),
              title,
              url: `https://${host}/careers/job/${id}`,
              company: instance.company,
              locations: locationsOf(p),
              postedAt: postedOf(p),
              comp: null,
            });
          }
          if (!d.positions.length || fetched >= d.count) break;
          if (++page >= MAX_PAGES) { complete = false; break; }
          d = await searchPage(ctx, st, host, q, fetched);
        }
        okQueries++;
      } catch (e) {
        complete = false;
        lastErr = e;
        ctx.log(`eightfold ${host}: query "${q}" failed: ${e.message}`);
      }
    }
    if (!okQueries) throw lastErr || new Error(`eightfold ${host}: all queries failed`);
    if (st.domainGuessed && !items.size) complete = false;

    return { complete, items: [...items.values()] };
  },
};
