// Intuit careers (jobs.intuit.com) — a Radancy/TMP "TalentBrew" site (org id 27595; the ATS
// behind it is Avature, but the public ids in jobs.intuit.com URLs are TalentBrew ids).
//
// Listing: GET /search-jobs/results?... (X-Requested-With: XMLHttpRequest) returns JSON
// { results: <html>, filters: <html>, hasJobs } with up to RecordsPerPage jobs per page.
//  1. keyword "intern" (full-text; catches titles, plus a few non-intern roles we filter out)
//  2. the "Internship" job category facet (all interns + co-ops), id read from query 1's filters
// Detail pages (~600 KB each) carry JSON-LD with datePosted and every jobLocation; list tiles
// only say "Multiple Locations" for multi-site roles. Details are fetched for at most
// DETAIL_BUDGET new jobs per poll and cached in-process, so steady-state polls cost 2 requests.

const BASE = 'https://jobs.intuit.com';
const ORG = '27595';
const PER_PAGE = 100;
const MAX_PAGES = 3;
const DETAIL_BUDGET = 5;
const detailCache = new Map(); // id -> { locations: string[], postedAt: string|null }

function resultsUrl({ keyword = '', page = 1, facet = null }) {
  const p = new URLSearchParams({
    ActiveFacetID: facet ? String(facet.id) : '0',
    CurrentPage: String(page),
    RecordsPerPage: String(PER_PAGE),
    Distance: '50',
    RadiusUnitType: '0',
    Keywords: keyword,
    Location: '',
    ShowRadius: 'False',
    IsPagination: page > 1 ? 'True' : 'False',
    CustomFacetName: '',
    FacetTerm: '',
    FacetType: '0',
    SearchResultsModuleName: 'Search Results',
    SearchFiltersModuleName: 'Search Filters',
    SortCriteria: '0',
    SortDirection: '0',
    SearchType: facet ? '6' : '5',
    PostalCode: '',
    ResultsType: '0',
  });
  if (facet) {
    p.set('FacetFilters[0].ID', String(facet.id));
    p.set('FacetFilters[0].FacetType', '1');
    p.set('FacetFilters[0].Count', String(facet.count || 0));
    p.set('FacetFilters[0].Display', 'Internship');
    p.set('FacetFilters[0].IsApplied', 'true');
    p.set('FacetFilters[0].FieldName', '');
  }
  return `${BASE}/search-jobs/results?${p}`;
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : '';
}

function parseResults(html, ctx) {
  const jobs = [];
  for (const m of String(html).matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)) {
    const li = m[1];
    const a = li.match(/<a\b[^>]*href="(\/job\/[^"]+)"[^>]*>/);
    if (!a) continue;
    const href = a[1];
    const id = (href.match(/\/(\d+)\/?(?:[?#].*)?$/) || [])[1];
    if (!id) continue;
    const h2 = li.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    const title = ctx.http.htmlText(h2 ? h2[1] : attr(a[0], 'data-title'));
    const locM = li.match(/class="job-location"[^>]*>([\s\S]*?)<\/span>/);
    const loc = locM ? ctx.http.htmlText(locM[1]) : '';
    jobs.push({ id, href, title, loc });
  }
  const totalPages = Number((String(html).match(/data-total-pages="(\d+)"/) || [])[1] || 1);
  return { jobs, totalPages };
}

function internshipFacet(filtersHtml) {
  for (const m of String(filtersHtml || '').matchAll(/<input\b[^>]*data-facet-type="1"[^>]*>/g)) {
    if (/data-display="Internship"/i.test(m[0])) {
      return { id: attr(m[0], 'data-id'), count: attr(m[0], 'data-count') };
    }
  }
  return null;
}

function parseDetail(html) {
  for (const m of String(html).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let j;
    try { j = JSON.parse(m[1]); } catch { continue; }
    if (j?.['@type'] !== 'JobPosting') continue;
    const locs = [];
    for (const place of [].concat(j.jobLocation || [])) {
      const a = place?.address || {};
      const s = [a.addressLocality, a.addressRegion, a.addressCountry].map((x) => String(x || '').trim()).filter(Boolean).join(', ');
      if (s) locs.push(s);
    }
    let postedAt = null;
    const d = String(j.datePosted || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (d) postedAt = `${d[1]}-${d[2].padStart(2, '0')}-${d[3].padStart(2, '0')}`;
    return { locations: [...new Set(locs)], postedAt };
  }
  return null;
}

export default {
  id: 'intuit',
  label: 'Intuit Careers',
  kind: 'company',
  interval: 600,
  instances: [{ key: 'intuit', company: 'Intuit' }],

  canon(url) {
    let u;
    try { u = new URL(url); } catch { return null; }
    if (u.hostname.toLowerCase() !== 'jobs.intuit.com') return null;
    // /job/<city>/<slug>/27595/<id> (also locale-prefixed or /job/-/-/27595/<id>)
    const m = u.pathname.match(new RegExp(`/job/(?:[^/]*/)*${ORG}/(\\d+)/?$`, 'i'));
    return m ? `intuit:${m[1]}` : null;
  },

  async poll(instance, ctx) {
    const headers = { 'x-requested-with': 'XMLHttpRequest', referer: `${BASE}/search-jobs` };
    const found = new Map(); // id -> job
    let complete = true;
    let okQueries = 0;
    let facet = null;

    const runQuery = async (q) => {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const data = await ctx.http.json(resultsUrl({ ...q, page }), { headers, timeout: 30_000 });
        if (typeof data?.results !== 'string') throw new Error('unexpected results payload');
        if (page === 1 && !q.facet) facet = internshipFacet(data.filters);
        const { jobs, totalPages } = parseResults(data.results, ctx);
        for (const j of jobs) if (!found.has(j.id)) found.set(j.id, j);
        if (page >= totalPages) return;
      }
      complete = false; // more pages than we are willing to fetch
    };

    try { await runQuery({ keyword: 'intern' }); okQueries++; } catch (e) {
      complete = false;
      ctx.log(`intuit: keyword search failed: ${e.message}`);
    }
    if (facet?.id) {
      try { await runQuery({ facet }); okQueries++; } catch (e) {
        complete = false;
        ctx.log(`intuit: Internship facet search failed: ${e.message}`);
      }
    } else if (okQueries) {
      ctx.log('intuit: "Internship" category facet not found; keyword results only');
    }
    if (!okQueries) throw new Error('intuit: all searches failed');

    const interns = [...found.values()].filter((j) => ctx.isInternTitle(j.title));
    if (complete) for (const id of detailCache.keys()) if (!found.has(id)) detailCache.delete(id);

    // Enrich a few uncached jobs per poll from their detail pages (multi-location ones first).
    const todo = interns
      .filter((j) => !detailCache.has(j.id))
      .sort((a, b) => Number(/multiple/i.test(b.loc)) - Number(/multiple/i.test(a.loc)))
      .slice(0, DETAIL_BUDGET);
    await ctx.http.mapLimit(todo, 2, async (j) => {
      const html = await ctx.http.text(BASE + j.href, { timeout: 30_000, retries: 1 });
      const d = parseDetail(html);
      if (d) detailCache.set(j.id, d);
    });

    const items = interns.map((j) => {
      const d = detailCache.get(j.id);
      const listLoc = j.loc && !/^multiple locations$/i.test(j.loc) ? [j.loc] : [];
      return {
        sid: `intuit:${j.id}`,
        title: j.title,
        url: BASE + j.href,
        company: instance.company,
        locations: d?.locations?.length ? d.locations : listLoc.length ? listLoc : j.loc ? [j.loc] : [],
        postedAt: d?.postedAt || null,
        comp: null,
      };
    });
    return { complete, items };
  },
};
