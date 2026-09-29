// Y Combinator "Work at a Startup" (WaaS) — intern roles across ALL YC companies.
//
// Job URLs:  https://www.workatastartup.com/jobs/<numericId>
//            https://www.workatastartup.com/application?signup_job_id=<numericId>   (apply links)
//            https://www.ycombinator.com/companies/<company>/jobs/<hashid>-<title-slug>
//
// Enumeration: WaaS has no public full listing (the Algolia index WaaSPublicCompanyJob_production
// is only readable with a logged-in user's key; the anonymous key embedded in the pages is
// tag-filtered to nothing, and ycombinator.com/jobs/* pages are capped at 20-40 postings).
// What IS public is the jobs page's semantic search:
//   GET https://www.workatastartup.com/jobs/search?q=<text>  (Accept: application/json)
//   -> { jobs:[{ id, title, jobType, location, roleType, salary, companyName, companySlug, ... }] }
// capped at 30 results per query (no paging). So we fan out over 14 intern-flavoured queries
// (generic + by discipline + by upcoming season; 14 requests/poll for ALL of YC) and union the results:
// ~160 distinct live intern roles. That is NOT exhaustive -> complete:false (never closes by absence).
//
// sid = yc:<numericId>. ycombinator.com job URLs carry a salted hashid instead of the numeric id and
// cannot be mapped offline; canon() returns 'yc:h:<hashid>' for them (stable, but it will not equal
// the sid poll() emits - such sightings must merge on company+title instead). They are rare: Simplify
// links WaaS jobs as workatastartup.com/jobs/<id>.

const WAAS = 'https://www.workatastartup.com';

function seasonalQueries(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1; // 1-12
  // next summer: recruiting for summer Y+1 starts ~Aug of year Y
  const summer = m >= 7 ? y + 1 : y;
  const out = [`summer ${summer} intern`];
  if (m >= 6) out.push(`winter ${y + 1} intern`, `spring ${y + 1} intern`);
  else out.push(`fall ${y} intern`);
  return out;
}

// Chosen by marginal yield (2026-09-28): the first 7 find ~120 distinct intern roles, each later one
// adds 3-10 more. Tech-leaning on purpose; non-tech queries (marketing, ops) were left out.
const BASE_QUERIES = [
  'intern',
  'internship',
  'software engineer intern',
  'machine learning intern',
  'hardware engineering intern',
  'data science intern',
  'product intern',
  'research intern',
  'backend engineer intern',
  'robotics intern',
  'forward deployed engineer intern',
];

function parse(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'workatastartup.com') {
    let m = u.pathname.match(/^\/jobs\/(\d+)(?:[/?#]|$)/);
    if (m) return { id: m[1] };
    m = u.pathname.match(/^\/companies\/[^/]+\/jobs\/(\d+)(?:[/?#-]|$)/);
    if (m) return { id: m[1] };
    const q = u.searchParams.get('signup_job_id') || u.searchParams.get('job_id');
    if (q && /^\d+$/.test(q)) return { id: q };
    return { id: null };
  }
  if (host === 'account.ycombinator.com') {
    const cont = u.searchParams.get('continue') || '';
    const m = cont.match(/[?&]signup_job_id=(\d+)/);
    return m ? { id: m[1] } : null;
  }
  if (host === 'ycombinator.com') {
    const m = u.pathname.match(/^\/companies\/[^/]+\/jobs\/([A-Za-z0-9]{5,12})(?:-[^/]*)?\/?$/);
    return m ? { hash: m[1] } : null;
  }
  return null;
}

export default {
  id: 'yc',
  label: 'YC Work at a Startup',
  kind: 'company',
  interval: 1200,

  instances: [{ key: 'yc', company: 'Y Combinator startups' }],

  canon(url) {
    const p = parse(url);
    if (!p) return null;
    if (p.id) return `yc:${p.id}`;
    if (p.hash) return `yc:h:${p.hash}`;
    return null;
  },

  async poll(instance, ctx) {
    const queries = [...BASE_QUERIES, ...seasonalQueries()];
    const res = await ctx.http.mapLimit(queries, 3, (q) =>
      ctx.http.json(`${WAAS}/jobs/search?q=${encodeURIComponent(q)}`, { headers: { accept: 'application/json' } }));

    const found = new Map();
    let ok = 0;
    res.forEach((r, i) => {
      if (!r.ok) { ctx.log?.(`yc: query "${queries[i]}" failed: ${r.error?.message}`); return; }
      if (!Array.isArray(r.value?.jobs)) return;
      ok++;
      for (const j of r.value.jobs) {
        if (j?.id == null || found.has(String(j.id))) continue;
        found.set(String(j.id), j);
      }
    });
    if (!ok) throw new Error('yc: every WaaS search query failed');

    const items = [];
    for (const [id, j] of found) {
      const title = String(j.title || '').replace(/\s+/g, ' ').trim();
      if (!title || !ctx.isInternTitle(title)) continue;
      items.push({
        sid: `yc:${id}`,
        title,
        url: `${WAAS}/jobs/${id}`,
        company: j.companyName || instance.company,
        locations: String(j.location || '').split(/\s+\/\s+|;\s*/).map((s) => s.trim()).filter(Boolean),
        postedAt: null,
        comp: j.salary || null,
      });
    }
    return { complete: false, items };
  },
};
