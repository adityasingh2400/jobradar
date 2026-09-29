// Oracle Recruiting Cloud (Candidate Experience) — one adapter for every tenant.
//
// Job pages: https://<tenant>.fa[.<region>].oraclecloud.com/hcmUI/CandidateExperience/<lang>/sites/<site>/job/<id>
// Search:    GET <origin>/hcmRestApi/resources/latest/recruitingCEJobRequisitions
//              ?onlyData=true&expand=requisitionList.secondaryLocations
//              &finder=findReqs;siteNumber=<site>,keyword=intern,limit=200,offset=N,sortBy=POSTING_DATES_DESC
//              &fields=TotalJobsCount;requisitionList:Id,Title,...   (trims ~350KB pages to ~65KB)
// Public, no auth/cookies. Max page size is 200. The keyword search is fuzzy full-text
// ("intern" also hits "internal"/"international" and descriptions), so we page through it and
// filter titles with ctx.isInternTitle. Tenants with <= 1200 hits are enumerated fully (complete=true);
// for huge tenants (JPMC ~3.9k, Marriott ~13.5k hits) we take the newest page, the top "intern" relevance
// pages and the tighter "internship" result set (complete=false). 1-6 requests per poll.
// sid = oracle:<host>:<requisition id> (ids are per tenant; the same req on two sites of a tenant merges).

const HOST_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.oraclecloud\.com$/i;
const PAGE = 200;
const MAX_FULL_PAGES = 6; // enumerate everything when the keyword result set is <= 1200
const FIELDS = 'TotalJobsCount;requisitionList:Id,Title,PostedDate,PrimaryLocation,PrimaryLocationCountry;requisitionList.secondaryLocations:Name';

function parse(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (!HOST_RE.test(host)) return null;
  const m = u.pathname.match(/\/CandidateExperience\/([^/]+)\/sites\/([^/]+)(?:\/(.*))?$/i);
  if (!m) return null;
  const lang = m[1];
  const site = decodeURIComponent(m[2]);
  const rest = m[3] || '';
  let id = null;
  const jm = rest.match(/(?:^|\/)(?:job|preview)\/([A-Za-z0-9_-]+)/i);
  if (jm) id = jm[1];
  else {
    const q = u.searchParams.get('selectedJobId') || u.searchParams.get('jobId');
    if (q && /^[A-Za-z0-9_-]+$/.test(q)) id = q;
  }
  return { host, lang, site, id };
}

const sidOf = (host, id) => `oracle:${host}:${id}`;

function isoDate(d) {
  if (!d) return null;
  const t = Date.parse(d);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function searchUrl(inst, { offset, sort, fields, keyword = 'intern' }) {
  const finder = `findReqs;siteNumber=${inst.site},keyword=${keyword},limit=${PAGE},offset=${offset},sortBy=${sort}`;
  let u = `https://${inst.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions`
    + `?onlyData=true&expand=requisitionList.secondaryLocations&finder=${encodeURIComponent(finder).replace(/%3B/g, ';').replace(/%2C/g, ',').replace(/%3D/g, '=')}`;
  if (fields) u += `&fields=${FIELDS}`;
  return u;
}

export default {
  id: 'oracle',
  label: 'Oracle Recruiting Cloud',
  kind: 'platform',
  interval: 900,

  instanceFromUrl(url, company) {
    const p = parse(url);
    if (!p || !p.site) return null;
    return { key: `oracle:${p.host}:${p.site}`, company, host: p.host, site: p.site };
  },

  seedInstances: [
    { key: 'oracle:jpmc.fa.oraclecloud.com:CX_1001', company: 'JPMorgan Chase', host: 'jpmc.fa.oraclecloud.com', site: 'CX_1001' },
  ],

  canon(url) {
    const p = parse(url);
    return p && p.id ? sidOf(p.host, p.id) : null;
  },

  async poll(inst, ctx) {
    let useFields = true;
    const fetchPage = async (offset, sort, keyword = 'intern') => {
      try {
        const d = await ctx.http.json(searchUrl(inst, { offset, sort, keyword, fields: useFields }), { timeout: 40_000 });
        return d?.items?.[0] || { TotalJobsCount: 0, requisitionList: [] };
      } catch (e) {
        // Older releases may reject the `fields` projection; fall back to the full payload once.
        if (useFields && e?.status === 400) {
          useFields = false;
          const d = await ctx.http.json(searchUrl(inst, { offset, sort, keyword, fields: false }), { timeout: 40_000 });
          return d?.items?.[0] || { TotalJobsCount: 0, requisitionList: [] };
        }
        throw e;
      }
    };

    const byId = new Map();
    const add = (list) => { for (const r of list || []) if (r?.Id && !byId.has(r.Id)) byId.set(r.Id, r); };

    const first = await fetchPage(0, 'POSTING_DATES_DESC');
    add(first.requisitionList);
    const total = Number(first.TotalJobsCount) || 0;
    let complete = true;

    if (total > PAGE) {
      if (total <= PAGE * MAX_FULL_PAGES) {
        for (let off = PAGE; off < total; off += PAGE) {
          try {
            const pg = await fetchPage(off, 'POSTING_DATES_DESC');
            add(pg.requisitionList);
            if (!pg.requisitionList?.length) break;
          } catch (e) {
            ctx.log(`oracle ${inst.key}: page ${off} failed: ${e.message}`);
            complete = false;
            break;
          }
        }
        if (byId.size < total * 0.98) complete = false; // list shifted under us / pages failed
      } else {
        // Too many fuzzy hits (JPMC ~3.9k, Marriott ~13.5k). We already have the newest page; add the top
        // relevance pages for "intern" plus the much tighter "internship" result set (JPMC: 420 hits), which
        // together recover ~98% of intern titles on the big tenants we measured. Not the full set.
        complete = false;
        const plan = [[0, 'RELEVANCY', 'intern'], [PAGE, 'RELEVANCY', 'intern'], [0, 'RELEVANCY', 'internship']];
        let shipTotal = Infinity;
        for (let i = 0; i < plan.length; i++) {
          const [off, sort, kw] = plan[i];
          try {
            const pg = await fetchPage(off, sort, kw);
            add(pg.requisitionList);
            if (kw === 'internship' && off === 0) {
              shipTotal = Number(pg.TotalJobsCount) || 0;
              for (let o = PAGE; o < Math.min(shipTotal, PAGE * 3); o += PAGE) plan.push([o, 'RELEVANCY', 'internship']);
            }
          } catch (e) {
            ctx.log(`oracle ${inst.key}: ${kw}/${sort} page ${off} failed: ${e.message}`);
          }
        }
      }
    }

    const items = [];
    for (const r of byId.values()) {
      const title = String(r.Title || '').trim();
      if (!ctx.isInternTitle(title)) continue;
      const locations = [r.PrimaryLocation, ...(r.secondaryLocations || []).map((l) => l?.Name)]
        .filter(Boolean)
        .filter((v, i, a) => a.indexOf(v) === i);
      items.push({
        sid: sidOf(inst.host, r.Id),
        title,
        url: `https://${inst.host}/hcmUI/CandidateExperience/en/sites/${inst.site}/job/${r.Id}`,
        company: inst.company,
        locations,
        postedAt: isoDate(r.PostedDate),
        comp: null,
      });
    }
    return { complete, items };
  },
};
