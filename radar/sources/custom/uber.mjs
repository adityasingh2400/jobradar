// Uber careers (jobs.uber.com, formerly www.uber.com/<cc>/<lang>/careers/list/<id>/).
//
// jobs.uber.com is a Next.js site behind a Cloudflare managed challenge (403 "Just a moment..."
// for plain HTTP), and the old www.uber.com /api/loadSearchJobsResults RPC is gone
// ("Missing RPC handler"). The site's data comes from Uber's Oracle Recruiting Cloud tenant
// (iaziqy.fa.ocs.oraclecloud.com, site "UberCareers"), whose public candidate-experience REST
// API is open. Oracle requisition Ids are the same ids used in jobs.uber.com/en/jobs/<id>/ and
// www.uber.com/global/en/careers/list/<id>/ (the latter 301-redirects to the former).
//
// Most Uber US university internships are posted on university-uber.icims.com instead; those
// belong to the iCIMS platform adapter and are deliberately NOT claimed here.

const API = 'https://iaziqy.fa.ocs.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions';
const SITE = 'UberCareers';
const PAGE = 200; // Oracle caps limit at 200
const MAX_PAGES = 4;
// Oracle keyword search is full-text (title + description) with stemming quirks: "intern" does
// not match "internship", so query a few terms and union the results.
const KEYWORDS = ['intern', 'internship', 'co-op'];

function searchUrl(keyword, offset) {
  const finder = [
    `siteNumber=${SITE}`,
    'facetsList=NONE',
    `limit=${PAGE}`,
    `offset=${offset}`,
    `keyword=${encodeURIComponent(JSON.stringify(keyword))}`,
    'sortBy=POSTING_DATES_DESC',
  ].join(',');
  return `${API}?onlyData=true&expand=requisitionList.secondaryLocations&finder=findReqs;${finder}`;
}

const jobUrl = (id) => `https://jobs.uber.com/en/jobs/${id}/`;

export default {
  id: 'uber',
  label: 'Uber Careers',
  kind: 'company',
  interval: 600,
  instances: [{ key: 'uber', company: 'Uber' }],

  canon(url) {
    let u;
    try { u = new URL(url); } catch { return null; }
    const host = u.hostname.toLowerCase();
    let m;
    // www.uber.com/global/en/careers/list/158579/ , /us/en/careers/list/158579/ , /careers/list/158579
    if (/(^|\.)uber\.com$/.test(host) && host !== 'jobs.uber.com') {
      m = u.pathname.match(/\/careers\/list\/(\d+)(?:\/|$)/i);
      return m ? `uber:${m[1]}` : null;
    }
    // jobs.uber.com/en/jobs/160017/?_csid=...  (any locale prefix, optional slug after the id)
    if (host === 'jobs.uber.com') {
      m = u.pathname.match(/\/jobs\/(\d+)(?:[/-]|$)/i);
      return m ? `uber:${m[1]}` : null;
    }
    return null;
  },

  async poll(instance, ctx) {
    const byId = new Map();
    let complete = true;
    let okQueries = 0;

    for (const kw of KEYWORDS) {
      let offset = 0;
      for (let page = 0; page < MAX_PAGES; page++) {
        let data;
        try {
          data = await ctx.http.json(searchUrl(kw, offset), { timeout: 30_000 });
        } catch (e) {
          ctx.log(`uber: search "${kw}" offset ${offset} failed: ${e.message}`);
          complete = false;
          break;
        }
        const res = data?.items?.[0];
        if (!res || !Array.isArray(res.requisitionList)) { complete = false; break; }
        if (page === 0) okQueries++;
        for (const r of res.requisitionList) {
          const id = String(r.Id || '').trim();
          const title = String(r.Title || '').trim();
          if (!/^\d+$/.test(id) || !title || byId.has(id)) continue;
          if (!ctx.isInternTitle(title)) continue;
          const locs = [r.PrimaryLocation, ...(r.secondaryLocations || []).map((s) => s.Name)]
            .map((s) => String(s || '').trim())
            .filter(Boolean);
          byId.set(id, {
            sid: `uber:${id}`,
            title,
            url: jobUrl(id),
            company: instance.company,
            locations: [...new Set(locs)],
            postedAt: /^\d{4}-\d{2}-\d{2}/.test(r.PostedDate || '') ? r.PostedDate : null,
            comp: null,
          });
        }
        offset += res.requisitionList.length;
        const total = Number(res.TotalJobsCount) || 0;
        if (res.requisitionList.length < PAGE || offset >= total) break;
        if (page === MAX_PAGES - 1) complete = false; // more results than we are willing to page
      }
    }

    if (!okQueries) throw new Error('uber: all Oracle searches failed');
    return { complete, items: [...byId.values()] };
  },
};
