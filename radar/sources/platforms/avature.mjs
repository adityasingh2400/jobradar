// Avature career portals — one adapter for every tenant (Two Sigma, Bloomberg, EA, Deloitte, Koch,
// ManTech, Siemens, HARMAN, ...).
//
// Job pages (all of these are the same job 14016 of tenant "twosigma"):
//   https://twosigma.avature.net/careers/JobDetail/14016
//   https://careers.twosigma.com/careers/JobDetail/New-York-...-Summer-2027/14016   (custom domain)
//   https://<t>.avature.net/en_US/careers/JobDetail?jobId=14016                      (query form)
//   https://<t>.avature.net/en_US/careers/ApplicationMethods?jobId=14016             (apply page)
//   https://jobs.pomerleau.ca/en_US/Jobs/JobDetail/6790/3515   (slug can be numeric: id is LAST segment)
// Path shape: /[<locale>/]<portal>/JobDetail/[<slug>/]<id>. The portal name varies per tenant
// ("careers", "Jobs", "externaljobs", ...). Job ids are tenant-wide, so sid = avature:<tenant>:<id>
// where <tenant> is the *.avature.net subdomain (custom domains are mapped back via TENANTS).
//
// Listing: there is no JSON API; the server-rendered search page is the only listing.
//   GET https://<host>/[<locale>/]<portal>/SearchJobs/<keyword>?jobRecordsPerPage=<n>&jobOffset=<k>
// The page size is fixed per portal (6..25; jobRecordsPerPage cannot raise it). The RSS feed
// (<list>/feed/) ignores the keyword on most tenants and is capped at 20 oldest items, so it is
// useless here. The keyword search is fuzzy full text ("intern" also hits internal/international
// and descriptions) and relevance-ranked with title matches first, so we page until a page holds no
// intern titles. That is a heuristic stop, so complete=true only when every keyword search was
// exhausted to its natural end.
//
// Some tenants (IBM careers.ibm.com, Delta) sit behind an AWS WAF JS challenge (HTTP 202 +
// x-amzn-waf-action: challenge) that plain HTTP cannot pass; poll() throws a clear error for them.

const DEFAULT_KEYWORDS = ['intern', 'co-op'];
const MAX_PAGES_PER_KEYWORD = 20;
const MAX_REQUESTS = 30;
const FULL_SCAN_MAX = 120;   // keyword hits we are willing to enumerate completely...
const FULL_SCAN_PAGES = 6;   // ...if that takes at most this many pages

// Known tenants: canonical host to poll (custom domain when the avature.net host redirects there),
// display name, listing page name when it is not "SearchJobs", and extra keywords.
const TENANTS = {
  twosigma: { host: 'careers.twosigma.com', company: 'Two Sigma', list: 'OpenRoles' },
  bloomberg: { host: 'bloomberg.avature.net', company: 'Bloomberg' },
  ea: { host: 'jobs.ea.com', company: 'Electronic Arts', locale: 'en_US' },
  // Deloitte's "Summer Scholar" internships often don't say "intern".
  deloitteus: { host: 'apply.deloitte.com', company: 'Deloitte', locale: 'en_US', keywords: ['intern', 'scholar', 'co-op'] },
  ibmglobal: { host: 'careers.ibm.com', company: 'IBM' },
  mantech: { host: 'careers.mantech.com', company: 'ManTech' },
  pomerleau: { host: 'jobs.pomerleau.ca', company: 'Pomerleau' },
  siemens: { host: 'jobs.siemens.com', company: 'Siemens' },
  harmanglobal: { host: 'jobsearch.harman.com', company: 'HARMAN International' },
  koch: { host: 'koch.avature.net', company: 'Koch Industries' },
};
const ALIAS = new Map(
  Object.entries(TENANTS)
    .filter(([, t]) => t.host && !t.host.endsWith('.avature.net'))
    .map(([tenant, t]) => [t.host, tenant]),
);

const LOCALE_RE = /^[a-z]{2,3}_[A-Za-z0-9]{2,4}$/;
const AVATURE_HOST_RE = /^([a-z0-9-]+)\.avature\.net$/i;
// Pages of the apply flow that carry ?jobId= (only trusted on known Avature hosts).
const APPLY_PAGES = /^(ApplicationMethods|Login|Register|ApplyJob|SaveJob|JobApply)$/;

function tenantOf(host) {
  const h = String(host).toLowerCase().replace(/^www\./, '');
  const m = h.match(AVATURE_HOST_RE);
  if (m) return m[1];
  return ALIAS.get(h) || h;
}

/** Parse any Avature job/portal URL -> { host, tenant, locale, portal, id } or null. */
function parse(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split('/').filter(Boolean);
  let locale = '';
  if (segs[0] && LOCALE_RE.test(segs[0])) locale = segs.shift();
  if (segs.length < 2) return null;
  const [portal, page, ...rest] = segs;
  if (!/^[A-Za-z0-9_-]+$/.test(portal)) return null;
  const known = AVATURE_HOST_RE.test(host) || ALIAS.has(host.replace(/^www\./, ''));
  let id = null;
  if (page === 'JobDetail') {
    const last = rest.length ? rest[rest.length - 1] : null;
    if (last && /^\d+$/.test(last)) id = last;
    else if (!rest.length) id = u.searchParams.get('jobId');
    if (id && !/^\d+$/.test(id)) id = null;
    if (!id) return null;
  } else if (known && APPLY_PAGES.test(page) && /^\d+$/.test(u.searchParams.get('jobId') || '')) {
    id = u.searchParams.get('jobId');
  } else {
    return null;
  }
  return { host, tenant: tenantOf(host), locale, portal, id };
}

const sidOf = (tenant, id) => `avature:${tenant}:${id}`;
function canonOf(url) {
  const p = parse(url);
  return p ? sidOf(p.tenant, p.id) : null;
}

const decode = (s = '') => String(s)
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/\s+/g, ' ')
  .trim();

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
/** "09/14/2026", "09-Sep-2026", "Sep 9, 2026", "2026-09-14" -> ISO date (UTC midnight) or null. */
function parseDate(s = '') {
  const t = String(s).trim();
  let y, mo, d, m;
  if ((m = t.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/))) [y, mo, d] = [m[1], m[2], m[3]];
  else if ((m = t.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/))) [mo, d, y] = [m[1], m[2], m[3]];
  else if ((m = t.match(/\b(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*\.?[-\s,]+(\d{4})\b/))) [d, mo, y] = [m[1], MONTHS[m[2].toLowerCase()], m[3]];
  else if ((m = t.match(/\b([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/))) [mo, d, y] = [MONTHS[m[1].toLowerCase()], m[2], m[3]];
  else return null;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d));
  if (!mo || Number.isNaN(ms) || Number(mo) > 12 || Number(d) > 31) return null;
  return new Date(ms).toISOString();
}

const GENERIC_ANCHOR = /^(apply( now)?|more information|more info|view( role| job| details)?|details|learn more|read more|save( job)?|share|email|x|linkedin|facebook)$/i;
const JOB_ANCHOR_RE = /<a\b[^>]*?href="(https?:\/\/[^"]*?\/JobDetail(?:\/[^"?#]*)?(?:\?[^"]*)?)"[^>]*>([\s\S]*?)<\/a>/g;
const NOT_LOCATION = /\b(posted|req(uisition)?\b|req\s*#|job\s*id|role\s*id|ref(erence)?\b|date|remote type|worker ?type|department)\b|^\s*id\b|^\d+$/i;

function pickLocation(block) {
  let m = block.match(/class="[^"]*\blist-item-location\b[^"]*"[^>]*>([\s\S]*?)<\/span>/);
  if (m) return decode(m[1]).replace(/^locations?\s*:\s*/i, '');
  m = block.match(/>\s*Locations?\s*:?\s*<\/[a-z0-9]+>\s*(?:<[^>]+>\s*)*([^<]+)</i);
  if (m) return decode(m[1]);
  m = block.match(/class="[^"]*(?:article__header__text__subtitle|article__header__content__text)[^"]*"[^>]*>([\s\S]*?)<\/div>/);
  if (!m) return '';
  const parts = [...m[1].matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/g)]
    .map((x) => decode(x[1]))
    .filter((x) => x && !NOT_LOCATION.test(x) && !/^[•·|]$/.test(x));
  if (!parts.length) return '';
  return parts.find((p) => /\blocations?\b|\bremote\b/i.test(p))
    || parts.find((p) => /,/.test(p))
    || parts.find((p) => /\s-\s/.test(p))
    || (parts.length === 1 ? parts[0] : parts[parts.length - 1]);
}

/** "A | B", "A; B", or ManTech-style "USA-VA-Herndon, USA-TX-San Antonio" -> ['A', 'B']. */
function splitLocations(loc = '') {
  const l = String(loc).trim();
  if (!l) return [];
  let parts = l.split(/\s*[|;]\s*/);
  if (parts.length === 1 && /^[A-Z]{2,3}-[A-Z]{2}-[^,]+(,\s*[A-Z]{2,3}-[A-Z]{2}-[^,]+)+$/.test(l)) parts = l.split(/\s*,\s*/);
  return [...new Set(parts.filter(Boolean))];
}

function pickPosted(block) {
  const m = block.match(/class="[^"]*\blist-item-posted\b[^"]*"[^>]*>([\s\S]*?)<\/span>/)
    || block.match(/>\s*Posted(?:\s+(?:Date|On))?\s*:?\s*([^<]{6,40})</i)
    || block.match(/>\s*(?:Posted|Date Posted|Posting Date)\s*:?\s*<\/[a-z0-9]+>\s*(?:<[^>]+>\s*)*([^<]+)</i);
  return m ? parseDate(decode(m[1])) : null;
}

/** Parse one search-results page -> { jobs: [{ id, title, url, location, postedAt }], per } */
function parseList(html) {
  const anchors = [];
  for (const m of html.matchAll(JOB_ANCHOR_RE)) {
    const p = parse(m[1].replace(/&amp;/g, '&'));
    if (!p) continue;
    anchors.push({ index: m.index, end: m.index + m[0].length, url: m[1].replace(/&amp;/g, '&'), id: p.id, text: decode(m[2]) });
  }
  // First non-generic anchor per job id is the title; its block runs to the next job's title.
  const firsts = [];
  const seen = new Set();
  for (const a of anchors) {
    if (seen.has(a.id) || !a.text || GENERIC_ANCHOR.test(a.text)) continue;
    seen.add(a.id);
    firsts.push(a);
  }
  const jobs = firsts.map((a, i) => {
    const block = html.slice(a.end, i + 1 < firsts.length ? firsts[i + 1].index : a.end + 6000);
    return { id: a.id, title: a.text, url: a.url, location: pickLocation(block), postedAt: pickPosted(block) };
  });
  // Pagination links: ?jobRecordsPerPage=6&jobOffset=6 (or folderRecordsPerPage/folderOffset).
  const pm = html.match(/[?&;](job|folder)RecordsPerPage=(\d+)(?:&amp;|&)(?:amp;)?\1Offset=\d+/);
  return { jobs, per: pm ? Number(pm[2]) : 0, prefix: pm ? pm[1] : 'job', total: totalOf(html) };
}

function totalOf(html) {
  // data-total="467" | aria-label="99 results" | "1-20 of 99 results" | "999+ results" (capped)
  const m = html.match(/data-total="(\d+)"/)
    || html.match(/aria-label="([\d,]+\+?) results?"/i)
    || html.match(/\bof\s+([\d,]+\+?)\s+results?\b/i)
    || html.match(/>\s*([\d,]+\+?)\s*(?:<[^>]+>\s*)*results?\b/i);
  if (!m) return null;
  const n = Number(m[1].replace(/[,+]/g, ''));
  return m[1].endsWith('+') ? n + 1 : n;
}

const stemOf = (kw) => (/co-?op/i.test(kw) ? /co-?op/i : new RegExp(kw.replace(/[^a-z0-9]+/gi, '.?'), 'i'));

function wafCheck(r, url) {
  if (r.status === 202 || r.headers?.get?.('x-amzn-waf-action')) {
    const e = new Error(`avature: ${new URL(url).host} is behind an AWS WAF challenge (HTTP ${r.status}); plain HTTP is blocked`);
    e.status = r.status;
    throw e;
  }
}

function instanceFor(tenant, fromHost, locale, portal, company) {
  const t = TENANTS[tenant] || {};
  const host = t.host || fromHost;
  return {
    key: `avature:${tenant}:${portal}`,
    company: t.company || company,
    tenant,
    host,
    locale: t.locale ?? locale ?? '',
    portal,
    ...(t.list ? { list: t.list } : {}),
    ...(t.keywords ? { keywords: t.keywords } : {}),
  };
}

export default {
  id: 'avature',
  label: 'Avature',
  kind: 'platform',
  interval: 600,

  instanceFromUrl(url, company) {
    const p = parse(url);
    if (!p) return null;
    return instanceFor(p.tenant, p.host, p.locale, p.portal, company);
  },

  seedInstances: [
    instanceFor('twosigma', 'careers.twosigma.com', '', 'careers', 'Two Sigma'),
    instanceFor('bloomberg', 'bloomberg.avature.net', '', 'careers', 'Bloomberg'),
    instanceFor('ea', 'jobs.ea.com', 'en_US', 'careers', 'Electronic Arts'),
    instanceFor('deloitteus', 'apply.deloitte.com', 'en_US', 'careers', 'Deloitte'),
  ],

  canon: canonOf,

  async poll(inst, ctx) {
    const origin = `https://${inst.host}`;
    const portalBase = `${origin}${inst.locale ? `/${inst.locale}` : ''}/${inst.portal}`;
    let requests = 0;

    const get = async (url) => {
      requests++;
      const r = await ctx.http.request(url, { as: 'text', timeout: 30_000, headers: { accept: 'text/html,application/xhtml+xml' } });
      wafCheck(r, url);
      return r;
    };

    // Resolve the listing page: SearchJobs, a known override, or discovered from the portal home.
    let listName = inst.list || 'SearchJobs';
    const firstPage = async (kw) => get(`${portalBase}/${listName}/${encodeURIComponent(kw)}`);
    const keywords = inst.keywords || DEFAULT_KEYWORDS;

    let first;
    try {
      first = await firstPage(keywords[0]);
    } catch (e) {
      if (e?.status !== 404 || inst.list) throw e;
      // Portal renamed its search page (e.g. Two Sigma "OpenRoles"): look for it on the portal home.
      const home = await get(portalBase);
      const names = new Map();
      const re = new RegExp(`href="https?://[^"/]+(?:/[a-z]{2,3}_[A-Za-z0-9]{2,4})?/${inst.portal}/([A-Za-z]+)/?[?"]`, 'g');
      for (const m of String(home.data).matchAll(re)) {
        const n = m[1];
        if (/^(JobDetail|Login|Register|Home|SaveJob|ApplicationMethods|Error|Logout|Profile|TalentCommunity)$/i.test(n)) continue;
        const score = /search|roles|jobs|openings|opportunit|positions|vacanc/i.test(n) ? 2 : 1;
        names.set(n, Math.max(names.get(n) || 0, score));
      }
      const cands = [...names.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n).slice(0, 2);
      if (!cands.length) throw new Error(`avature ${inst.key}: no job search page found on ${portalBase}`);
      let lastErr;
      for (const n of cands) {
        listName = n;
        try { first = await firstPage(keywords[0]); break; } catch (err) { lastErr = err; first = null; }
      }
      if (!first) throw lastErr;
    }

    const byId = new Map();
    let complete = true;
    const hostTenantOk = (u) => { try { return tenantOf(new URL(u).hostname) === inst.tenant; } catch { return false; } };

    for (const [ki, kw] of keywords.entries()) {
      const stem = stemOf(kw);
      let offset = 0;
      let per = 0;
      let prefix = 'job';
      let fullScan = false;
      let dryPages = 0;
      let exhausted = false;
      for (let page = 0; page < MAX_PAGES_PER_KEYWORD; page++) {
        let r;
        try {
          if (ki === 0 && page === 0) r = first;
          else if (requests >= MAX_REQUESTS) break;
          else if (page === 0) r = await firstPage(kw);
          else r = await get(`${portalBase}/${listName}/${encodeURIComponent(kw)}?${prefix}RecordsPerPage=${per}&${prefix}Offset=${offset}`);
        } catch (e) {
          if (page === 0 && ki === 0) throw e;
          ctx.log(`avature ${inst.key}: "${kw}" offset ${offset} failed: ${e.message}`);
          break;
        }
        const html = String(r.data || '');
        const { jobs, per: perHint, prefix: pfx, total } = parseList(html);
        if (page === 0) {
          per = perHint || jobs.length;
          prefix = pfx;
          // Small result sets are enumerated to the end so the poll can be complete.
          fullScan = total != null && per > 0 && total <= FULL_SCAN_MAX && Math.ceil(total / per) <= FULL_SCAN_PAGES;
        }
        for (const j of jobs) if (ctx.isInternTitle(j.title) && !byId.has(j.id)) byId.set(j.id, j);
        offset += per;
        const hasNext = new RegExp(`${prefix}Offset=${offset}\\b`).test(html);
        if (!jobs.length || !hasNext) { exhausted = true; break; }
        // Title matches rank first: stop once the ranking has moved past intern titles containing
        // the keyword (1 dry page, or 2 on portals with tiny pages). A page whose keyword-in-title
        // hits are all non-interns ("Internal Audit", "International Tax") counts half.
        const stemHits = jobs.filter((j) => stem.test(j.title));
        if (stemHits.some((j) => ctx.isInternTitle(j.title))) dryPages = 0;
        else dryPages += stemHits.length ? 0.5 : 1;
        if (!fullScan && dryPages >= (per >= 10 ? 1 : 2)) break;
      }
      if (!exhausted) complete = false;
    }

    const items = [];
    for (const j of byId.values()) {
      const sid = sidOf(inst.tenant, j.id);
      // Keep the listing's own link unless it lives on a host we cannot map back to this tenant
      // (unknown custom domain reached via redirect) — then point at the instance host instead.
      let url = j.url;
      if (!hostTenantOk(url)) { const u = new URL(url); url = `https://${inst.host}${u.pathname}${u.search}`; }
      if (canonOf(url) !== sid) url = `${portalBase}/JobDetail/${j.id}`;
      items.push({
        sid,
        title: j.title,
        url,
        company: inst.company,
        locations: splitLocations(j.location),
        postedAt: j.postedAt,
        comp: null,
      });
    }
    ctx.log(`avature ${inst.key}: ${requests} requests, list=${listName}, ${items.length} intern items`);
    return { complete, items };
  },
};
