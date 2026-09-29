// SAP SuccessFactors Career Site Builder (a.k.a. RMK / jobs2web) career sites.
//
// These live on company domains (jobs.l3harris.com, careers.qorvo.com, *.jobs2web.com ...) with
// job links shaped like  /[brand/]job/<City-Title-ST-zip>/<numericId>/[?ats=successfactors]
// (sites on the newer "unified" search also use /job/<Title>/<id>-en_US/).
//
// Two search back-ends exist, both plain HTTP:
//  * classic (most sites): server-rendered /search/ page. `title=<term>` restricts the match to the
//    job title (the free-text `q=` also hits descriptions: e.g. 1059 vs 188 hits at L3Harris),
//    results sort newest-first and page with `startrow=`. Page size is fixed per site (25/50 rows
//    in table layout, 100 in tile layout). A search with no hits renders the site's most recent
//    jobs as a fallback (`id="noresults"`), which must be ignored.
//  * unified (e.g. aramarkcareers.com, jobs.bmwgroup.com, seagatecareers.com): the /search/ page is
//    an empty React shell; results come from POST /services/recruiting/v1/jobs (10 per page,
//    free-text keywords only, sortBy "date" = newest first, anything else = relevance).
//    Classic sites answer that API with 401.
// Posted dates: table layouts show them; for tile layouts we fill the dates of the newest intern
// postings from the RSS feed (/services/rss/job/?keywords=title:intern, capped at 20 items).
//
// Instance = one host. Brand sub-paths (/SMARTHOMES/, /We_Energies/, /ey/ ...) are views of the same
// tenant: the root /search/ covers every brand, while brand-scoped searches can miss jobs.
// sid = sf:<host without www>:<numeric job id> (the slug and brand prefix are ignored by the site).

const ID = 'sf';

// Hosts of other ATSs whose URLs could look vaguely similar; never claim them.
const FOREIGN_HOST = /(myworkday(jobs|site)\.com|icims\.com|oraclecloud\.com|taleo\.net|eightfold\.ai|greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com|workable\.com|jobvite\.com|avature\.net|phenompeople\.com|brassring\.com|ultipro\.com|dayforcehcm\.com|adp\.com|paylocity\.com|bamboohr\.com|rippling\.com|linkedin\.com|indeed\.com|simplify\.jobs|jibeapply\.com)$/i;

// /[prefix/[prefix/]]job/<slug>/<id>[-xx_XX][/]
const JOB_PATH = /^(?:\/[^/]+){0,2}\/job\/([^/]+)\/(\d{4,12})(-[a-z]{2}_[A-Z]{2})?\/?$/;
// /talentcommunity/apply/<id>/  (apply page)
const APPLY_PATH = /^(?:\/[^/]+){0,2}\/talentcommunity\/apply\/(\d{4,12})\/?$/;

const TERMS = ['intern', 'co-op', 'coop']; // classic title searches ("co-op" does not match "CoOp")
const MAX_REQUESTS = 10;
const SF_MARKER = /\/platform\/js\/j2w\/|jobs2web\.com|rmk-jobs-search/i; // markers of a CSB page

const normHost = (h) => h.toLowerCase().replace(/^www\./, '');
const pad = (n) => String(n).padStart(2, '0');

/** Returns { host, id } if the URL looks like a SuccessFactors CSB job URL, else null. */
function match(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  if (FOREIGN_HOST.test(host)) return null;
  let path = u.pathname;
  try { path = decodeURI(path); } catch { /* keep raw */ }
  const a = path.match(APPLY_PATH);
  if (a) return { host, id: a[1] };
  const m = path.match(JOB_PATH);
  if (!m) return null;
  const [, slug, id, localeSuffix] = m;
  const strong = (u.searchParams.get('ats') || '').toLowerCase() === 'successfactors'
    || /\.jobs2web\.com$/.test(host) || !!localeSuffix;
  // Without an explicit marker, require the typical CSB shape: hyphenated slug and a long id.
  if (!strong && (!/[A-Za-z]/.test(slug) || !/-/.test(slug) || id.length < 7)) return null;
  return { host, id };
}

// ---------- classic HTML search ----------

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function parseDate(s) {
  if (!s) return null;
  let m = String(s).match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/);
  if (m && MONTHS[m[1].toLowerCase().slice(0, 3)]) return `${m[3]}-${pad(MONTHS[m[1].toLowerCase().slice(0, 3)])}-${pad(m[2])}`;
  m = String(s).match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

function cleanLoc(s) {
  return s
    .replace(/&hellip;?|…/g, '')
    .replace(/\s*\+\s*\d+\s+more\b.*$/i, '') // "Juno Beach, FL, US, 33408 +7 more..."
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/,\s*$/, '')
    // drop a trailing US zip / Canadian postal code: "Greensboro, NC, US, 27409" -> "Greensboro, NC, US"
    .replace(/,\s*(\d{5}(-\d{4})?|[A-Z]\d[A-Z] ?\d[A-Z]\d)$/, '');
}

const decodeAmp = (h) => h.replace(/&amp;/g, '&');

function parseClassic(html, htmlText) {
  const noResults = /id="noresults"/.test(html);
  let total = null;
  let m = html.match(/paginationLabel[^>]*>[\s\S]{0,200}?<b>\s*\d[\d,.]*\s*[-–]\s*\d[\d,.]*\s*<\/b>[\s\S]{0,80}?<b>\s*(\d[\d,.]*)\s*<\/b>/);
  if (!m) m = html.match(/id="tile-search-results-label"[^>]*>[^<]*?\d[\d,.]*\D+?\d[\d,.]*\D+?(\d[\d,.]*)/);
  if (m) total = Number(m[1].replace(/[,.]/g, ''));

  // Result rows: table layout <tr class="data-row">, tile layout <li class="job-tile ...">.
  let chunks = html.split(/<tr[^>]*class="data-row[^"]*"[^>]*>/).slice(1);
  let layout = 'table';
  if (!chunks.length) {
    chunks = html.split(/<li[^>]*class="job-tile[ "][^>]*>/).slice(1);
    layout = 'tile';
  }
  const rows = [];
  for (let c of chunks) {
    c = c.split(/<\/tr>|<li[^>]*class="job-tile[ "]/)[0];
    const a = c.match(/<a[^>]*class="jobTitle-link[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    const href = a && (a[0].match(/href="([^"]+)"/) || [])[1];
    if (!href) continue;
    const locs = new Set();
    let date = null;
    if (layout === 'table') {
      const colLoc = c.match(/<td[^>]*class="colLocation[^"]*"[^>]*>([\s\S]*?)<\/td>/);
      for (const lm of (colLoc ? colLoc[1] : c).matchAll(/<span class="jobLocation[^"]*">([\s\S]*?)<\/span>/g)) {
        for (const part of lm[1].split(/<br\s*\/?>/i)) {
          const t = cleanLoc(htmlText(part));
          if (t) locs.add(t);
        }
      }
      const dm = c.match(/<span class="jobDate[^"]*">([^<]*)</);
      if (dm) date = parseDate(dm[1]);
    } else {
      const field = (name) => {
        const fm = c.match(new RegExp(`id="job-\\d+-desktop-section-${name}-value"[^>]*>([\\s\\S]*?)</div>`));
        return fm ? htmlText(fm[1]) : '';
      };
      const loc = field('location') || [field('city'), field('state'), field('country')].filter(Boolean).join(', ');
      if (loc) locs.add(cleanLoc(loc));
      date = parseDate(field('date'));
    }
    rows.push({ href: decodeAmp(href), title: htmlText(a[1]), locations: [...locs], date });
  }
  return { noResults, total, rows, layout };
}

async function getPage(ctx, url, origin, state) {
  state.requests++;
  const res = await ctx.http.request(url, { as: 'text' });
  const finalHost = new URL(res.url || url).hostname;
  if (finalHost !== new URL(origin).hostname && !SF_MARKER.test(res.data)) {
    throw new Error(`SuccessFactors site ${origin} now redirects to ${res.url}`);
  }
  return res.data;
}

async function pollClassic(instance, ctx, origin, state) {
  const host = normHost(new URL(origin).hostname);
  const out = new Map();
  let complete = true;
  for (let t = 0; t < TERMS.length; t++) {
    const term = TERMS[t];
    let startrow = 0;
    for (let page = 0; ; page++) {
      // keep one request for each remaining term
      if (state.requests >= MAX_REQUESTS - (TERMS.length - 1 - t)) { complete = false; break; }
      const url = `${origin}/search/?q=&title=${encodeURIComponent(term)}&sortColumn=referencedate&sortDirection=desc&locale=en_US`
        + (startrow ? `&startrow=${startrow}` : '');
      let html;
      try {
        html = await getPage(ctx, url, origin, state);
      } catch (e) {
        if (t === 0 && page === 0) throw e; // main search failed: total failure
        complete = false;
        break;
      }
      const r = parseClassic(html, ctx.http.htmlText);
      if (t === 0 && page === 0 && !r.rows.length && !r.noResults) {
        if (/searchResultsUnify|rmk-jobs-search/.test(html)) { state.unified = true; return null; }
        if (!SF_MARKER.test(html)) throw new Error(`no SuccessFactors search page at ${origin}/search/`);
      }
      if (r.noResults || !r.rows.length) break;
      for (const row of r.rows) {
        if (!ctx.isInternTitle(row.title)) continue;
        const abs = new URL(row.href, origin);
        const mm = match(abs.href) || (abs.pathname.match(/\/(\d{4,12})(?:-[a-z]{2}_[A-Z]{2})?\/?$/) || [])[1];
        const id = typeof mm === 'string' ? mm : mm?.id;
        if (!id) continue;
        const sid = `${ID}:${host}:${id}`;
        if (out.has(sid)) continue;
        out.set(sid, {
          sid,
          title: row.title,
          url: `${origin}${abs.pathname}`,
          company: instance.company,
          locations: row.locations,
          postedAt: row.date,
          comp: null,
        });
      }
      startrow += r.rows.length;
      if (r.total == null ? r.rows.length < 25 : startrow >= r.total) break;
    }
  }
  return { items: out, complete };
}

// Fill posted dates from the RSS feed (newest ~20 title matches). Best effort.
async function fillDatesFromRss(ctx, origin, items, state) {
  state.requests++;
  let xml;
  try {
    xml = await ctx.http.text(`${origin}/services/rss/job/?locale=en_US&keywords=${encodeURIComponent('title:intern')}`, { retries: 0 });
  } catch { return; }
  const host = normHost(new URL(origin).hostname);
  for (const it of xml.split('<item>').slice(1)) {
    const link = (it.match(/<link>([\s\S]*?)<\/link>/) || [])[1];
    const pub = (it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1];
    const idm = link && decodeAmp(link).match(/\/job\/[^/]+\/(\d{4,12})\//);
    if (!idm || !pub) continue;
    const item = items.get(`${ID}:${host}:${idm[1]}`);
    if (!item || item.postedAt) continue;
    // "Mon, 28 Sep 2026 7:00:00 GMT" (single-digit hour) -> zero-pad so Date.parse accepts it
    const ts = Date.parse(pub.replace(/\s(\d):/, ' 0$1:'));
    if (!Number.isNaN(ts)) item.postedAt = new Date(ts).toISOString().slice(0, 10);
  }
}

// ---------- unified (React) search API ----------

function unifiedLocations(j) {
  const locs = (j.jobLocationShort || []).map((l) => String(l).replace(/[,\s]+$/, '').trim()).filter(Boolean);
  if (!locs.length && j.primLocation) locs.push(String(j.primLocation).trim());
  if (!locs.length && Array.isArray(j.jobLocationCountry)) locs.push(...j.jobLocationCountry.filter(Boolean));
  return [...new Set(locs)];
}

async function pollUnified(instance, ctx, origin, state) {
  const out = new Map();
  const host = normHost(new URL(origin).hostname);
  const api = `${origin}/services/recruiting/v1/jobs`;
  const search = async (keywords, pageNumber, sortBy) => {
    state.requests++;
    const d = await ctx.http.json(api, {
      method: 'POST',
      body: { keywords, locale: 'en_US', location: '', pageNumber, sortBy, facetFilters: {}, brand: '', skills: [], categoryId: 0, alertId: '', rcmCandidateId: '' },
    });
    let interns = 0;
    for (const { response: j } of d.jobSearchResult || []) {
      if (!j?.id) continue;
      const title = ctx.http.htmlText(j.unifiedStandardTitle || '');
      if (!ctx.isInternTitle(title)) continue;
      interns++;
      const sid = `${ID}:${host}:${j.id}`;
      if (out.has(sid)) continue;
      const slug = decodeAmp(j.urlTitle || j.unifiedUrlTitle || 'job');
      // Legacy-style ids (>= 7 digits) keep the classic URL shape; short unified ids need the -locale suffix.
      const url = String(j.id).length >= 7
        ? `${origin}${j.brandUrl ? `/${j.brandUrl}` : ''}/job/${slug}/${j.id}/`
        : `${origin}/job/${slug}/${j.id}-en_US/`;
      const dm = String(j.unifiedStandardStart || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
      out.set(sid, {
        sid,
        title,
        url: new URL(url).href,
        company: instance.company,
        locations: unifiedLocations(j),
        postedAt: dm ? `${dm[3].length === 2 ? `20${dm[3]}` : dm[3]}-${pad(dm[1])}-${pad(dm[2])}` : null,
        comp: null,
      });
    }
    return { total: Number(d.totalJobs) || 0, count: (d.jobSearchResult || []).length, interns };
  };

  // Free-text "intern" newest-first; if the whole result set fits in the budget, enumerate it.
  const first = await search('intern', 0, 'date');
  const pages = Math.ceil(first.total / 10);
  if (pages <= MAX_REQUESTS - 2) {
    for (let p = 1; p < pages; p++) {
      try { await search('intern', p, 'date'); } catch { return { items: out, complete: false }; }
    }
    return { items: out, complete: true };
  }
  // Large result set (descriptions mention "intern"): newest 2 pages, then relevance-ranked pages of
  // "intern" and "internship" while they keep yielding intern titles.
  try { await search('intern', 1, 'date'); } catch { /* best effort */ }
  for (const kw of ['intern', 'internship']) {
    for (let p = 0; p < 4 && state.requests < MAX_REQUESTS; p++) {
      let r;
      try { r = await search(kw, p, 'relevance'); } catch { break; }
      if (!r.interns || (p + 1) * 10 >= r.total) break;
    }
  }
  return { items: out, complete: false };
}

export default {
  id: ID,
  label: 'SAP SuccessFactors',
  kind: 'platform',
  interval: 1200,

  instanceFromUrl(url, company) {
    const m = match(url);
    if (!m) return null;
    const u = new URL(url);
    return { key: `${ID}:${normHost(m.host)}`, company, host: u.host.toLowerCase(), origin: `https://${u.host.toLowerCase()}` };
  },

  seedInstances: [],

  canon(url) {
    const m = match(url);
    return m ? `${ID}:${normHost(m.host)}:${m.id}` : null;
  },

  async poll(instance, ctx) {
    const origin = instance.origin || `https://${instance.host}`;
    const state = { requests: 0, unified: false };
    const classic = await pollClassic(instance, ctx, origin, state);
    if (state.unified) {
      const u = await pollUnified(instance, ctx, origin, state);
      return { complete: u.complete, items: [...u.items.values()] };
    }
    const { items, complete } = classic;
    if (state.requests < MAX_REQUESTS && [...items.values()].some((i) => !i.postedAt)) {
      await fillDatesFromRss(ctx, origin, items, state);
    }
    return { complete, items: [...items.values()] };
  },
};
