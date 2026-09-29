// Goldman Sachs — higher.gs.com/roles/<id>?type=students
//
// higher.gs.com is a Next.js SPA backed by a public (no auth) Apollo GraphQL gateway at
// api-higher.gs.com/gateway/api/v1/graphql. The /campus page runs `GetCampusRoles` with
// experiences: ["CAMPUS"]; that set is only ~280 roles (summer analyst/associate, off-cycle,
// apprenticeships, plus full-time "New Analyst" roles), so we enumerate all of it in 2 pages of
// 250 (server max) rather than keyword-search, because most intern titles never say "intern"
// ("2027 | Americas | New York | Engineering | Summer Analyst").
// Professional / early-career experiences contain no internships (checked).
//
// Role ids: roleId "175424_GS_CAMPUS", externalSource.sourceId "175424"; URLs use the number.
// Note: `startDate` on POSTED roles is the search index time, not a posting date, so postedAt=null.
// SCHEDULED roles (listed on the site before applications open) are included.

const API = 'https://api-higher.gs.com/gateway/api/v1/graphql';
const PAGE_SIZE = 250; // server-side max
const MAX_PAGES = 6;

const QUERY = `query GetCampusRoles($searchQueryInput: RoleSearchQueryInput!) {
  roleSearch(searchQueryInput: $searchQueryInput) {
    totalCount
    items {
      roleId
      corporateTitle
      jobTitle
      locations { primary state country city }
      status
      division
      externalSource { sourceId }
    }
  }
}`;

const INTERN_LEVELS = /^(seasonal|summer analyst|summer associate|intern)/i;

/** "2027 | EMEA | London | Engineering | Summer Analyst" -> "Summer Analyst - Engineering - 2027 - London" */
function niceTitle(raw) {
  const t = String(raw || '').replace(/\s+/g, ' ').trim();
  let parts = t.split(/\s*\|\s*/);
  if (parts.length < 4) {
    const alt = t.split(/\s+I\s+/); // a few titles use " I " as the separator
    if (alt.length >= 4 && /^20\d\d$/.test(alt[0])) parts = alt;
  }
  if (parts.length >= 4 && /^20\d\d$/.test(parts[0])) {
    const [year, , city, ...rest] = parts;
    const level = rest.pop();
    const business = rest.join(' - ');
    return [level, business, year, city].filter(Boolean).join(' - ');
  }
  return t;
}

function locationsOf(locs = []) {
  const sorted = [...locs].sort((a, b) => Number(!!b.primary) - Number(!!a.primary));
  const out = [];
  for (const l of sorted) {
    const bits = [];
    for (const b of [l.city, l.state, l.country]) {
      if (b && !bits.some((x) => x.toLowerCase() === String(b).toLowerCase())) bits.push(String(b));
    }
    const s = bits.join(', ');
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

export default {
  id: 'gs',
  label: 'Goldman Sachs Careers',
  kind: 'company',
  interval: 300,
  instances: [{ key: 'gs', company: 'Goldman Sachs' }],

  canon(url) {
    let u;
    try { u = new URL(url); } catch { return null; }
    if (u.hostname.toLowerCase() !== 'higher.gs.com') return null;
    const m = u.pathname.match(/^\/roles\/(\d+)(?:_[A-Z_]+)?\/?$/i);
    return m ? `gs:${m[1]}` : null;
  },

  async poll(instance, ctx) {
    const all = [];
    let total = Infinity;
    for (let page = 0; page < MAX_PAGES && all.length < total; page++) {
      const data = await ctx.http.json(API, {
        method: 'POST',
        headers: { origin: 'https://higher.gs.com', referer: 'https://higher.gs.com/' },
        body: {
          operationName: 'GetCampusRoles',
          query: QUERY,
          variables: {
            searchQueryInput: {
              page: { pageSize: PAGE_SIZE, pageNumber: page },
              sort: { sortStrategy: 'POSTED_DATE', sortOrder: 'DESC' },
              filters: [],
              experiences: ['CAMPUS'],
              searchTerm: '',
            },
          },
        },
        timeout: 25_000,
      });
      if (data?.errors?.length) throw new Error(`gs: GraphQL error: ${data.errors[0].message}`);
      const rs = data?.data?.roleSearch;
      if (!rs || !Array.isArray(rs.items)) throw new Error('gs: unexpected GraphQL payload');
      total = Number(rs.totalCount) || 0;
      all.push(...rs.items);
      if (rs.items.length < PAGE_SIZE) break;
    }

    const items = [];
    const seen = new Set();
    for (const r of all) {
      const id = r.externalSource?.sourceId || String(r.roleId || '').match(/^(\d+)/)?.[1];
      if (!id || !/^\d+$/.test(id)) continue;
      let title = niceTitle(r.jobTitle);
      if (!ctx.isInternTitle(title)) {
        // Off-cycle / placement roles whose title lacks the word (e.g. "Seasonal/Off-Cycle").
        if (!/^seasonal/i.test(r.corporateTitle || '')) continue;
        title = `${title} (Internship)`;
      }
      if (!ctx.isInternTitle(title)) continue;
      if (!INTERN_LEVELS.test(r.corporateTitle || '') && !/\b(intern|apprentice|trainee)/i.test(r.jobTitle)) continue;
      const sid = `gs:${id}`;
      if (seen.has(sid)) continue;
      seen.add(sid);
      items.push({
        sid,
        title,
        url: `https://higher.gs.com/roles/${id}?type=students`,
        locations: locationsOf(r.locations),
        postedAt: null,
        comp: null,
      });
    }
    return { complete: all.length >= total, items };
  },
};
