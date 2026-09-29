// Oracle Taleo Enterprise career sections: <co>.taleo.net/careersection/<section>/jobdetail.ftl?job=<Job Number>
//
// Modern ("faceted search") career sections load results from a public JSON endpoint:
//   POST https://<host>/careersection/rest/jobboard/searchjobs?lang=en&portal=<portalNo>
// portalNo is per career section and is read once from /careersection/<section>/jobsearch.ftl
// (cached per process). Keyword search is word-based (no stemming, no OR), so we run
// "intern", "internship" and "co-op" and merge (one 500-row page each, newest first).
// Keywords are sent UPPERCASE on purpose: search is case-insensitive, but the server caches a
// result page per query string for ~30 s *ignoring pageSize*, and humans (25-row UI pages)
// type lowercase, so uppercase keeps our cache entries separate from theirs.
//
// Legacy (pre-faceted, "joblist.ftl") sections only get a best-effort parse of the first
// result page (complete: false).
//
// Job ids: the `job=` URL param is the Job Number ("contestNo", e.g. 342976, 260004N7, 006NB).
// Taleo also resolves job=<internal jobId>, but its own UI and share links always use the
// contest number, so sids are 'taleo:<co>:<CONTESTNO>' (co = subdomain of taleo.net, or the
// full host for custom domains). The section is NOT part of the sid: sections share requisitions.

const ID = 'taleo';
const KEYWORDS = ['INTERN', 'INTERNSHIP', 'CO-OP'];
const PAGE_SIZE = 500;          // honoured by the endpoint (UI default is 25); one page covers nearly every section
const MAX_REQUESTS = 9;         // per poll, including discovery
const DISCOVERY_TTL = 12 * 3600e3;
const discovery = new Map();    // instance.key -> { at, mode, portal, sortId, multiline, cols, dateCol }

const JOB_PAGES = /^(jobdetail|jobapply)\.ftl$/i;

function parseUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  if (/(^|\.)tbe\.taleo\.net$/.test(host)) return null; // Taleo Business Edition: different product
  const m = u.pathname.match(/^\/careersection\/(?:([^/]+)\/)?([A-Za-z_]+\.(?:ftl|jss|ajax))$/);
  const isTaleoHost = /\.taleo\.net$/.test(host);
  if (!m) return null;
  if (!isTaleoHost && !/\.ftl$/i.test(m[2])) return null; // custom domains: require classic Taleo .ftl pages
  const section = m[1] && m[1] !== 'feed' ? decodeURIComponent(m[1]) : null;
  const page = m[2];
  const co = isTaleoHost ? host.slice(0, -'.taleo.net'.length) : host;
  const job = JOB_PAGES.test(page) ? (u.searchParams.get('job') || '').trim() : '';
  return { host, co, section, page, job, lang: u.searchParams.get('lang') || '' };
}

const sidOf = (co, contestNo) => `${ID}:${co}:${String(contestNo).trim().toUpperCase()}`;

function coOf(host) {
  return host.endsWith('.taleo.net') ? host.slice(0, -'.taleo.net'.length) : host;
}

function jobUrl(inst, contestNo) {
  return `https://${inst.host}/careersection/${encodeURIComponent(inst.section)}/jobdetail.ftl?job=${encodeURIComponent(contestNo)}&lang=${inst.lang || 'en'}`;
}

// ---------- parsing helpers ----------
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');

function isoDate(s) {
  const t = String(s || '').trim();
  let m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    let [a, b] = [Number(m[1]), Number(m[2])];
    if (a > 12 && b <= 12) [a, b] = [b, a]; // DD/MM/YYYY
    return a >= 1 && a <= 12 && b >= 1 && b <= 31 ? `${m[3]}-${pad(a)}-${pad(b)}` : null;
  }
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4})$/);
  if (m && MONTHS[m[1].toLowerCase()]) return `${m[3]}-${pad(MONTHS[m[1].toLowerCase()])}-${pad(m[2])}`;
  m = t.match(/^(\d{1,2})[ -]([A-Za-z]{3})[a-z]*\.?[ -,]+(\d{4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(m[1])}`;
  m = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  return null;
}

const LOC_HEAD = new RegExp('^([A-Z]{2,3}|United States|USA|Canada|Mexico|India|United Kingdom|Americas|Europe|EMEA|APAC|Asia|Germany|France|China|Japan|Australia|'
  + 'Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming|District of Columbia|'
  + 'Ontario|Quebec|British Columbia|Alberta|Manitoba|Nova Scotia)$');
/** "US-Texas-Fort Worth" -> "Fort Worth, Texas, US"; "PA-Harrisburg" -> "Harrisburg, PA"; others unchanged. */
function prettyLoc(s) {
  const t = String(s || '').trim();
  if (!t || /,|\s-\s/.test(t)) return t;
  const parts = t.split('-');
  if (parts.length < 2 || !LOC_HEAD.test(parts[0].trim())) return t;
  if (parts.length === 2) return `${parts[1].trim()}, ${parts[0].trim()}`;
  return `${parts.slice(2).join('-').trim()}, ${parts[1].trim()}, ${parts[0].trim()}`;
}

function parseLocCell(v) {
  const raw = String(v ?? '').trim();
  if (!raw) return [];
  let arr;
  if (raw.startsWith('[')) { try { arr = JSON.parse(raw); } catch { arr = [raw]; } } else arr = [raw];
  return arr.map((x) => String(x).trim()).filter(Boolean).map(prettyLoc);
}

function stripTags(s) {
  return String(s).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

/** Parse the faceted-search page: portal number, sort ids, result-column labels. */
function parseFacetedPage(html) {
  const portal = html.match(/portalNo\s*:\s*'(\d+)'/)?.[1] || null;
  if (!portal) return null;
  const sorts = {};
  for (const m of html.matchAll(/value="([A-Z_]+)"\s+sortid="(\d+)"/g)) sorts[m[1]] = m[2];
  const thead = html.match(/<thead>([\s\S]*?)<\/thead>/)?.[1] || '';
  const ths = [...thead.matchAll(/<th\b([^>]*)>([\s\S]*?)<\/th>/g)]
    .filter((m) => !/hidden-audible/.test(m[2]) && !/^actions$/i.test(stripTags(m[2])))
    .map((m) => stripTags(m[2]));
  // Some sections (e.g. Zions) configure no single-line columns at all: their rows come back
  // with empty `column` arrays unless we ask for the multi-line layout (column labels unknown).
  const multiline = ths.length === 0;
  const dateCol = multiline ? -1 : ths.findIndex((l) => /post/i.test(l) && !/unpost/i.test(l));
  return {
    mode: 'faceted',
    portal,
    sortId: sorts.POSTING_DATE || null,
    multiline,
    cols: ths,
    dateCol: dateCol >= 0 ? dateCol : null,
  };
}

// Legacy (joblist.ftl) sections embed page 1 as a flat JS array.
function unescapeJs(s) {
  return s.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, e) => {
    if (e[0] === 'u' && e.length === 5) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e[0] === 'x' && e.length === 3) return String.fromCharCode(parseInt(e.slice(1), 16));
    return { n: '\n', t: '\t', r: '\r' }[e] ?? e;
  });
}

function parseLegacyList(html) {
  const m = html.match(/fillList\('requisitionListInterface',\s*'listRequisition',\s*\[([\s\S]*?)\]\);/);
  if (!m) return null;
  const arr = [...m[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((x) => unescapeJs(x[1]));
  const starts = [];
  for (let i = 0; i + 3 < arr.length; i++) {
    if (/^\d+$/.test(arr[i]) && arr[i + 2] === arr[i] && arr[i + 1] && arr[i + 3] === arr[i + 1] && !/^\d+$/.test(arr[i + 1])) {
      starts.push(i);
      i += 3;
    }
  }
  const rows = [];
  for (let k = 0; k < starts.length; k++) {
    const f = arr.slice(starts[k], starts[k + 1] ?? arr.length);
    const jobId = f[0];
    let title = f[1].trim();
    try { title = decodeURIComponent(title); } catch { /* keep raw */ }
    let contestNo = null;
    for (const v of f) {
      const c = v.match(/Job Number\\?:\s*([A-Za-z0-9_.-]+)\)/);
      if (c) { contestNo = c[1]; break; }
    }
    const date = f.map(isoDate).find(Boolean) || null;
    rows.push({ jobId, contestNo, title, date });
  }
  return rows;
}

// ---------- adapter ----------
export default {
  id: ID,
  label: 'Taleo',
  kind: 'platform',
  interval: 1200,

  instanceFromUrl(url, company) {
    const p = parseUrl(url);
    if (!p || !p.section) return null;
    if (/^(mobile|common)$/i.test(p.section)) return null;
    return {
      key: `${ID}:${p.host}:${p.section}`,
      company,
      host: p.host,
      section: p.section,
      lang: /^[a-z]{2}([_-][A-Za-z]{2})?$/.test(p.lang) ? p.lang : 'en',
    };
  },

  seedInstances: [],

  canon(url) {
    const p = parseUrl(url);
    if (!p || !p.job || !/^[A-Za-z0-9_.-]{2,40}$/.test(p.job)) return null;
    return sidOf(p.co, p.job);
  },

  async poll(instance, ctx) {
    const inst = { lang: 'en', ...instance };
    const co = coOf(inst.host);
    let requests = 0;
    const base = `https://${inst.host}/careersection`;
    const secUrl = `${base}/${encodeURIComponent(inst.section)}/jobsearch.ftl?lang=${inst.lang}&keyword=intern`;

    let info = discovery.get(inst.key);
    let legacyHtml = null;
    if (!info || Date.now() - info.at > DISCOVERY_TTL) {
      const res = await ctx.http.request(secUrl, { as: 'text' });
      requests++;
      const html = res.data || '';
      const finalUrl = res.url || secUrl;
      if (!new URL(finalUrl).pathname.startsWith('/careersection/')) {
        throw new Error(`taleo ${inst.key}: career section redirects off Taleo (${finalUrl})`);
      }
      if (/Career Section Unavailable/i.test(html)) {
        throw new Error(`taleo ${inst.key}: career section unavailable`);
      }
      info = parseFacetedPage(html);
      if (!info) {
        if (!/fillList\('requisitionListInterface'/.test(html)) {
          throw new Error(`taleo ${inst.key}: no job search on ${finalUrl}`);
        }
        info = { mode: 'legacy' };
        legacyHtml = html;
      }
      info.at = Date.now();
      discovery.set(inst.key, info);
    }

    try {
      if (info.mode === 'legacy') {
        if (!legacyHtml) {
          legacyHtml = await ctx.http.text(secUrl);
          requests++;
        }
        return pollLegacy(inst, co, legacyHtml, ctx);
      }
      return await pollFaceted(inst, co, info, ctx, requests);
    } catch (e) {
      discovery.delete(inst.key); // re-discover next time (portal/section may have changed)
      throw e;
    }
  },
};

function pollLegacy(inst, co, html, ctx) {
  const rows = parseLegacyList(html);
  if (!rows) throw new Error(`taleo ${inst.key}: could not parse legacy job list`);
  const items = [];
  const seen = new Set();
  for (const r of rows) {
    if (!ctx.isInternTitle(r.title)) continue;
    const num = r.contestNo || r.jobId;
    const sid = sidOf(co, num);
    if (seen.has(sid)) continue;
    seen.add(sid);
    items.push({
      sid,
      title: r.title,
      url: jobUrl(inst, String(num).toUpperCase()),
      company: inst.company,
      locations: [],
      postedAt: r.date,
      comp: null,
    });
  }
  // Only the first result page of a legacy section is visible without its stateful AJAX pager.
  return { complete: false, items };
}

async function pollFaceted(inst, co, info, ctx, requests) {
  const url = `https://${inst.host}/careersection/rest/jobboard/searchjobs?lang=${inst.lang}&portal=${info.portal}`;
  const headers = { tz: 'GMT-04:00', tzname: 'America/New_York', 'x-requested-with': 'XMLHttpRequest' };
  const body = (kw, pageNo) => ({
    multilineEnabled: !!info.multiline,
    sortingSelection: {
      sortBySelectionParam: info.sortId || '3',
      ascendingSortingOrder: 'false',
    },
    fieldData: { fields: { KEYWORD: kw, LOCATION: '', ORGANIZATION: '' }, valid: true },
    filterSelectionParam: {
      searchFilterSelections: [
        { id: 'POSTING_DATE', selectedValues: [] },
        { id: 'LOCATION', selectedValues: [] },
        { id: 'JOB_FIELD', selectedValues: [] },
      ],
    },
    advancedSearchFiltersSelectionParam: {
      searchFilterSelections: [
        { id: 'ORGANIZATION', selectedValues: [] },
        { id: 'LOCATION', selectedValues: [] },
        { id: 'JOB_FIELD', selectedValues: [] },
      ],
    },
    pageNo,
    pageSize: PAGE_SIZE,
  });

  const items = [];
  const seen = new Set();
  let complete = true;
  let okQueries = 0;
  let lastErr = null;

  const addRow = (r) => {
    const col = Array.isArray(r.column) ? r.column : [];
    const titleIdx = Number.isInteger(r.linkedColumn) ? r.linkedColumn : 0;
    const title = String(col[titleIdx] ?? '').trim();
    const contestNo = String(r.contestNo || '').trim();
    if (!title || !contestNo || !ctx.isInternTitle(title)) return;
    const sid = sidOf(co, contestNo);
    if (seen.has(sid)) return;
    seen.add(sid);
    const locIdx = Array.isArray(r.locationsColumns) ? r.locationsColumns : [];
    const locations = [...new Set(locIdx.flatMap((i) => parseLocCell(col[i])))];
    let postedAt = null;
    if (info.dateCol != null && info.dateCol < col.length) postedAt = isoDate(col[info.dateCol]);
    if (!postedAt && info.dateCol == null) {
      const dates = col.map((v, i) => (i === titleIdx || locIdx.includes(i) ? null : isoDate(v))).filter(Boolean);
      if (dates.length === 1) postedAt = dates[0];
    }
    items.push({
      sid,
      title,
      url: jobUrl(inst, contestNo.toUpperCase()),
      company: inst.company,
      locations,
      postedAt,
      comp: null,
    });
  };

  for (const kw of KEYWORDS) {
    if (requests >= MAX_REQUESTS) { complete = false; break; }
    const ids = new Set();
    let total = null;
    let reachedEnd = false;
    let failed = false;
    for (let page = 1; ; page++) {
      if (requests >= MAX_REQUESTS) { failed = true; break; }
      let data;
      try {
        requests++;
        data = await ctx.http.json(url, { method: 'POST', body: body(kw, page), headers });
      } catch (e) {
        lastErr = e;
        failed = true;
        break;
      }
      if (data?.careerSectionUnAvailable) throw new Error(`taleo ${inst.key}: career section unavailable`);
      const list = Array.isArray(data?.requisitionList) ? data.requisitionList : null;
      if (!list) { lastErr = new Error(`taleo ${inst.key}: unexpected search response`); failed = true; break; }
      total = Number(data?.pagingData?.totalCount ?? list.length);
      const before = ids.size;
      for (const r of list) {
        if (r?.contestNo) ids.add(String(r.contestNo));
        addRow(r);
      }
      if (list.length < PAGE_SIZE) { reachedEnd = true; break; }
      if (ids.size === before) break; // repeated page (see cache note below)
    }
    if (!failed && total != null) okQueries++;
    // totalCount slightly over-counts (up to ~8%: hidden/duplicate postings), so "complete" means
    // we reached a short last page and got (nearly) totalCount distinct jobs. The gap check guards
    // against a short page served from the per-query-string cache (see header note).
    const gap = total == null ? Infinity : total - ids.size;
    if (failed || !reachedEnd || gap > Math.max(2, Math.ceil(total * 0.1))) complete = false;
  }

  if (okQueries === 0) throw lastErr || new Error(`taleo ${inst.key}: search failed`);
  return { complete, items };
}
