// Phenom People career sites (careers.cisco.com, careers.adobe.com, jobs.baesystems.com, ...).
//
// Job URLs look like  https://<host>/<cc|global>/<lang>/job/<jobId|jobSeqNo>[/<slug>]
// e.g. careers.cisco.com/global/en/job/2025313
//      careers.adobe.com/us/en/job/ADOBUSR161061EXTERNALENUS/Software-Development-Engineer
//
// Search: every Phenom site answers  POST <origin>/widgets  {ddoKey:'refineSearch', keywords, from,
// size, sort:{field:'postedDate',order:'desc'}}  with plain JSON — no cookie / CSRF token needed
// (verified on 21 hosts). Page size up to 200 is honoured; a poll is usually 4 requests (one per
// keyword, see below), newest first.
// If that ever fails we fall back to GETting the search-results page (which embeds phApp.ddo with
// eagerLoadRefineSearch, and gives us the site's real locale/pageId) and retry once.
//
// IDs: a job has a `jobId` (ATS requisition id, e.g. "JR-16160", "R171666", a UUID for Snowflake)
// and a `jobSeqNo` = <refNum> + UPPER(alnum(jobId)) + "EXTERNAL" + <locale>[<extra>]. The job page
// accepts either form and sites (and Simplify) link with either, so the sid is built from
// UPPER(alnum(jobId)); canon() recovers it from a jobSeqNo by stripping the site's refNum (known-host
// table below, else a heuristic: 4-6 char client code followed by "US" or "GLOBAL"). poll() checks
// the heuristic against the real refNum and logs a warning if a host needs a table entry.

const UA_PATH_RE = /^\/(global|[a-z]{2})\/([a-z]{2})(?:[-_][a-z]{2})?\/job\/([^/?#]+)/i;
const APPLY_RE = /^\/(global|[a-z]{2})\/([a-z]{2})(?:[-_][a-z]{2})?\/apply\b/i;

// Hosts with the Phenom path shape that are NOT (or no longer) Phenom sites.
const NOT_PHENOM = new Set([
  'jobs.careers.microsoft.com', // Microsoft's own site (same /global/en/job/<id> shape)
  'careers.microsoft.com',
  'jobs.lumen.com', // former Phenom site; Lumen moved to Eightfold (careers.lumen.com), pages 404
]);

// refNum per host (verified 2026-09-28), used to turn a jobSeqNo back into a jobId.
const REFNUM = {
  'careers.cisco.com': 'CISCISGLOBAL',
  'careers.tranetechnologies.com': 'TRTEGLOBAL',
  'careers.united.com': 'UAIUADUS',
  'careers.itw.com': 'ITWITWUS',
  'careers.bcg.com': 'BCG1US',
  'careers.hellofresh.com': 'HELLGLOBAL',
  'careers.quest-global.com': 'QGRQGAGLOBAL',
  'careers.adobe.com': 'ADOBUS',
  'careers.varsitybrands.com': 'VABRUS',
  'careers.zimmerbiomet.com': 'ZBUZBRUS',
  'jobs.newmont.com': 'NMCNMCUS',
  'jobs.baesystems.com': 'BAE1US',
  'careers.cargurus.com': 'CABCARUS',
  'jobs.ascension.org': 'AHEAHUUS',
  'careers.snowflake.com': 'SNCOUS',
  'yelp.careers': 'YELPUS',
  'careers.circle.com': 'CIICIRUS',
  'careers.fiserv.com': 'FFFYJUS',
  'careers.conehealth.com': 'CHPCHVUS',
  'careers.seattlechildrens.org': 'SEASCHUS',
  'jobs.battelle.org': 'BMIBMIUS',
};

const PAGE_SIZE = 200;
// Phenom keyword search is semantic, not substring: on some sites "intern" misses titles that
// "internship" finds (careers.bcg.com: 22 vs 82 hits), and co-op / working-student roles need their
// own query. The primary query may page (up to PRIMARY_PAGES); secondary queries are used only when
// their whole result set fits in one page (a fuzzy query with 1000+ hits is skipped every time, so
// the item set stays stable and `complete` stays meaningful).
const PRIMARY = 'intern';
const PRIMARY_PAGES = 5; // <= 1000 hits
const SECONDARY = ['internship', 'co-op', 'working student'];

const normHost = (h) => String(h).toLowerCase().replace(/^www\./, '');
const idKey = (jobId) => String(jobId).toUpperCase().replace(/[^A-Z0-9]/g, '');

function parse(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = normHost(u.hostname);
  if (NOT_PHENOM.has(host)) return null;
  let m = u.pathname.match(UA_PATH_RE);
  if (m) {
    let seg = m[3];
    try { seg = decodeURIComponent(seg); } catch { /* keep raw */ }
    return { u, host, cc: m[1].toLowerCase(), lang: m[2].toLowerCase(), seg };
  }
  m = u.pathname.match(APPLY_RE);
  if (m) {
    const seg = u.searchParams.get('jobSeqNo') || u.searchParams.get('jobId');
    if (seg) return { u, host, cc: m[1].toLowerCase(), lang: m[2].toLowerCase(), seg };
  }
  return null;
}

/** refNum-stripping heuristic for hosts not in REFNUM. */
function guessRefNum(stem) {
  const m = stem.match(/^[A-Z0-9]{4,6}?(?:GLOBAL|US)/);
  return m ? m[0] : null;
}

/** jobId key from a URL path segment that is either a jobId or a jobSeqNo. */
function keyFromSegment(host, seg) {
  const up = String(seg).toUpperCase();
  const i = up.indexOf('EXTERNAL');
  if (i > 0 && /^[A-Z0-9]+$/.test(up)) {
    const stem = up.slice(0, i);
    const ref = REFNUM[host] || guessRefNum(stem);
    if (ref && stem.startsWith(ref) && stem.length > ref.length) return stem.slice(ref.length);
    return stem; // unknown refNum: best effort
  }
  return idKey(seg);
}

function slugify(title) {
  return String(title || '').normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').slice(0, 90);
}

function isoDate(s) {
  if (!s) return null;
  const t = Date.parse(String(s).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function extractJsonObject(s, start) {
  let depth = 0, inStr = false, esc = false;
  for (let j = start; j < s.length; j++) {
    const c = s[j];
    if (inStr) {
      if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return s.slice(start, j + 1);
  }
  return null;
}

function compOf(j) {
  for (const k of ['salary', 'salaryRange', 'payRange', 'pay_range', 'compensation', 'salary_range']) {
    const v = j[k];
    if (typeof v === 'string' && /\d/.test(v)) return v.trim();
  }
  return null;
}

export default {
  id: 'phenom',
  label: 'Phenom',
  kind: 'platform',
  interval: 1200,

  instanceFromUrl(url, company) {
    const p = parse(url);
    if (!p) return null;
    return {
      key: `phenom:${p.host}`,
      company,
      host: p.host,
      origin: `${p.u.protocol}//${p.u.host.toLowerCase()}`,
      cc: p.cc,
      lang: p.lang,
    };
  },

  seedInstances: [],

  canon(url) {
    const p = parse(url);
    if (!p) return null;
    const k = keyFromSegment(p.host, p.seg);
    return k ? `phenom:${p.host}:${k}` : null;
  },

  async poll(instance, ctx) {
    const host = normHost(instance.host || new URL(instance.origin).hostname);
    const origin = instance.origin || `https://${host}`;
    const cc = instance.cc || 'global';
    const lang = instance.lang || 'en';
    let site = { locale: `${lang}_${cc}`, pageId: 'page4', refNum: REFNUM[host] || null };

    const search = (keywords, from) => ctx.http.json(`${origin}/widgets`, {
      method: 'POST',
      headers: { origin, referer: `${origin}/${cc}/${lang}/search-results` },
      body: {
        lang: site.locale, deviceType: 'desktop', country: cc, pageName: 'search-results',
        ddoKey: 'refineSearch', sortBy: '', subsearch: '', from, jobs: true, counts: false,
        all_fields: [], size: PAGE_SIZE, clearAll: false, jdsource: 'facets', isSliderEnable: false,
        pageId: site.pageId, siteType: 'external', keywords, global: true,
        selected_fields: {}, locationData: {}, sort: { order: 'desc', field: 'postedDate' },
      },
    }).then((d) => {
      const rs = d?.refineSearch;
      if (!rs || !rs.data || !Array.isArray(rs.data.jobs)) throw new Error(`phenom: bad refineSearch response from ${host}`);
      return { total: Number(rs.totalHits) || 0, jobs: rs.data.jobs };
    });

    let first;
    try {
      first = await search(PRIMARY, 0);
    } catch (e) {
      // Fallback: read the real locale/pageId/refNum from the search page, then retry once.
      const html = await ctx.http.text(`${origin}/${cc}/${lang}/search-results?keywords=${PRIMARY}`);
      const at = html.indexOf('phApp.ddo');
      if (at < 0) throw new Error(`phenom: ${host} does not look like a Phenom site (${e.message})`);
      site = {
        locale: html.match(/"locale":"([^"]+)"/)?.[1] || site.locale,
        pageId: html.match(/"pageId":"([^"]+)"/)?.[1] || site.pageId,
        refNum: html.match(/"refNum":"([^"]+)"/)?.[1] || site.refNum,
      };
      try {
        first = await search(PRIMARY, 0);
      } catch (e2) {
        // Last resort: the first 10 results embedded in the page itself.
        const obj = extractJsonObject(html, html.indexOf('{', at));
        const rs = obj && JSON.parse(obj).eagerLoadRefineSearch;
        if (!rs?.data?.jobs) throw e2;
        first = { total: Number(rs.totalHits) || 0, jobs: rs.data.jobs, partial: true };
      }
    }

    let complete = !first.partial;
    const jobs = [...first.jobs];
    for (let page = 1; complete && page < PRIMARY_PAGES && page * PAGE_SIZE < first.total; page++) {
      try {
        const r = await search(PRIMARY, page * PAGE_SIZE);
        if (!r.jobs.length) break;
        jobs.push(...r.jobs);
      } catch (e) {
        ctx.log(`phenom ${host}: "${PRIMARY}" page ${page} failed: ${e.message}`);
        complete = false;
      }
    }
    if (jobs.length < first.total) complete = false;

    if (!first.partial) {
      for (const kw of SECONDARY) {
        try {
          const r = await search(kw, 0);
          if (r.total <= r.jobs.length) jobs.push(...r.jobs); // fully enumerated in one page
        } catch (e) {
          ctx.log(`phenom ${host}: "${kw}" search failed: ${e.message}`);
          complete = false;
        }
      }
    }

    const items = [];
    const seen = new Set();
    let warned = false;
    for (const j of jobs) {
      const title = String(j.title || '').trim();
      if (!j.jobId || !title || !ctx.isInternTitle(title)) continue;
      const key = idKey(j.jobId);
      if (!key) continue;
      const sid = `phenom:${host}:${key}`;
      if (seen.has(sid)) continue;
      seen.add(sid);

      // Sanity check: a jobSeqNo URL for this job must canon to the same sid.
      if (!warned && j.jobSeqNo && keyFromSegment(host, j.jobSeqNo) !== key) {
        warned = true;
        const ref = site.refNum || String(j.jobSeqNo).toUpperCase().split(idKey(j.jobId))[0];
        ctx.log(`phenom ${host}: jobSeqNo ${j.jobSeqNo} does not canon to ${key}; add REFNUM['${host}'] = '${ref}'`);
      }

      const locs = Array.isArray(j.multi_location) && j.multi_location.length
        ? j.multi_location
        : [j.location || j.cityStateCountry || [j.city, j.state, j.country].filter(Boolean).join(', ')];
      const slug = slugify(title);
      items.push({
        sid,
        title,
        url: `${origin}/${cc}/${lang}/job/${encodeURIComponent(j.jobId)}${slug ? `/${slug}` : ''}`,
        locations: [...new Set(locs.map((l) => String(l || '').trim()).filter(Boolean))],
        postedAt: isoDate(j.postedDate || j.dateCreated),
        comp: compOf(j),
      });
    }

    return { complete, items };
  },
};
