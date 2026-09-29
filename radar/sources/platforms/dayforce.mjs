// Dayforce (Ceridian) candidate portals (jobs.dayforcehcm.com).
//
// Job URLs:  https://jobs.dayforcehcm.com/<locale>/<clientNamespace>/<jobBoardCode>/jobs/<postingId>
//   e.g.     https://jobs.dayforcehcm.com/en-US/texasfarm/CANDIDATEPORTAL/jobs/634
//            https://jobs.dayforcehcm.com/<ns>/<board>/jobs/<id>            (no locale)
//            https://<pod>.dayforcehcm.com/CandidatePortal/en-US/<ns>/Site/<board>/Posting/View/<id>  (legacy)
//            https://<pod>.dayforcehcm.com/CandidatePortal/en-US/<ns>/Posting/View/<id>              (legacy)
// postingIds are small per-tenant integers -> sid = dayforce:<ns>:<postingId>.
//
// Search API (what the Next.js portal calls):
//   1. GET  https://jobs.dayforcehcm.com/api/auth/csrf -> {csrfToken} + Set-Cookie __Host-next-auth.csrf-token
//   2. POST https://jobs.dayforcehcm.com/api/geo/<ns>/jobposting/search
//        headers: X-CSRF-TOKEN: <csrfToken>, Cookie: <that cookie>
//        body: {clientNamespace, jobBoardCode, cultureCode:'en-US', searchText, paginationStart}
//      -> {jobPostings:[{jobPostingId, jobTitle, postingStartTimestampUTC, postingLocations:[{formattedAddress}],
//          hasVirtualLocation}], maxCount, offset, count}   (fixed page size 25)
// The token/cookie pair is shared by all tenants and cached for CSRF_TTL_MS (refreshed on 403).
// Poll: empty search first. Small boards (<= FULL_LIST_MAX jobs) are listed in full (complete).
// Big boards: keyword searches (searchText is a substring match over title+description, so "intern"
// also hits "internal"; titles are filtered with isInternTitle anyway).

const HOST = 'https://jobs.dayforcehcm.com';
const PAGE = 25;
const FULL_LIST_MAX = 100; // <= 4 pages
const TERMS = [['intern', 3], ['co-op', 1], ['trainee', 1], ['apprentice', 1]]; // [searchText, maxPages]
const CSRF_TTL_MS = 20 * 60_000;
let csrf = null; // { token, cookie, at }
let csrfPromise = null;

const LOCALE_RE = /^[a-z]{2}(?:-[A-Za-z]{2,4})?$/;

function parse(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/(^|\.)dayforcehcm\.com$/i.test(u.hostname)) return null;
  const segs = u.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  // legacy CandidatePortal URLs
  if (segs[0] && segs[0].toLowerCase() === 'candidateportal') {
    let i = 1;
    if (LOCALE_RE.test(segs[i] || '')) i++;
    const ns = segs[i];
    if (!ns) return null;
    const si = segs.findIndex((s) => s.toLowerCase() === 'site');
    const board = si > 0 && segs[si + 1] ? segs[si + 1] : 'CANDIDATEPORTAL';
    const vi = segs.findIndex((s) => s.toLowerCase() === 'view');
    const id = vi > 0 && /^\d+$/.test(segs[vi + 1] || '') ? segs[vi + 1] : null;
    return { ns: ns.toLowerCase(), board, id };
  }
  if (!/^jobs\.dayforcehcm\.com$/i.test(u.hostname)) return null;
  let i = 0;
  if (LOCALE_RE.test(segs[0] || '') && segs.length >= 3) i = 1;
  const ns = segs[i];
  const board = segs[i + 1];
  if (!ns || !board || ns === 'api' || ns === '_next') return null;
  const id = segs[i + 2] === 'jobs' && /^\d+$/.test(segs[i + 3] || '') ? segs[i + 3] : null;
  return { ns: ns.toLowerCase(), board, id };
}

async function getCsrf(ctx, force = false) {
  if (!force && csrf && Date.now() - csrf.at < CSRF_TTL_MS) return csrf;
  if (csrfPromise) return csrfPromise;
  csrfPromise = (async () => {
    const r = await ctx.http.request(`${HOST}/api/auth/csrf`, { as: 'json' });
    const token = r.data?.csrfToken;
    const set = typeof r.headers?.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
    const cookie = set.map((c) => c.split(';')[0]).filter((c) => /csrf-token=/.test(c)).join('; ');
    if (!token || !cookie) throw new Error('dayforce: could not obtain CSRF token/cookie');
    csrf = { token, cookie, at: Date.now() };
    return csrf;
  })();
  try { return await csrfPromise; } finally { csrfPromise = null; }
}

async function search(inst, searchText, start, ctx) {
  const body = { clientNamespace: inst.ns, jobBoardCode: inst.board, cultureCode: 'en-US', searchText, paginationStart: start };
  for (let attempt = 0; ; attempt++) {
    const c = await getCsrf(ctx, attempt > 0);
    try {
      const d = await ctx.http.json(`${HOST}/api/geo/${encodeURIComponent(inst.ns)}/jobposting/search`, {
        method: 'POST',
        body,
        headers: { 'x-csrf-token': c.token, cookie: c.cookie, origin: HOST, referer: `${HOST}/en-US/${inst.ns}/${inst.board}` },
      });
      if (!d || !Array.isArray(d.jobPostings)) throw new Error(`dayforce: unexpected search payload for ${inst.ns}`);
      return d;
    } catch (e) {
      if (e?.status === 403 && attempt === 0) continue; // stale token -> refresh once
      throw e;
    }
  }
}

/** Run one search, paging up to maxPages. Returns { rows, truncated }. */
async function searchAll(inst, text, maxPages, ctx) {
  const rows = [];
  let d = await search(inst, text, 0, ctx);
  rows.push(...d.jobPostings);
  let pages = 1;
  while (rows.length < (d.maxCount ?? 0) && d.jobPostings.length && pages < maxPages) {
    d = await search(inst, text, rows.length, ctx);
    rows.push(...d.jobPostings);
    pages++;
  }
  return { rows, total: d.maxCount ?? rows.length, truncated: rows.length < (d.maxCount ?? 0) };
}

export default {
  id: 'dayforce',
  label: 'Dayforce',
  kind: 'platform',
  interval: 1800,

  instanceFromUrl(url, company) {
    const p = parse(url);
    if (!p) return null;
    return { key: `dayforce:${p.ns}:${p.board.toLowerCase()}`, company: company || p.ns, ns: p.ns, board: p.board };
  },

  seedInstances: [],

  canon(url) {
    const p = parse(url);
    return p?.id ? `dayforce:${p.ns}:${p.id}` : null;
  },

  async poll(instance, ctx) {
    const [, ns0, board0] = String(instance.key).split(':');
    const inst = { ns: instance.ns || ns0, board: instance.board || (board0 || 'candidateportal').toUpperCase() };

    const found = new Map();
    const add = (rows) => { for (const r of rows) if (r?.jobPostingId != null && !found.has(String(r.jobPostingId))) found.set(String(r.jobPostingId), r); };

    let complete = true;
    const first = await search(inst, '', 0, ctx);
    add(first.jobPostings);
    const total = first.maxCount ?? first.jobPostings.length;
    if (total <= FULL_LIST_MAX) {
      let got = first.jobPostings.length;
      while (got < total && first.jobPostings.length) {
        const d = await search(inst, '', got, ctx);
        if (!d.jobPostings.length) break;
        add(d.jobPostings);
        got += d.jobPostings.length;
      }
      if (got < total) complete = false;
    } else {
      for (const [text, maxPages] of TERMS) {
        try {
          const r = await searchAll(inst, text, maxPages, ctx);
          add(r.rows);
          if (r.truncated) complete = false;
        } catch (e) {
          complete = false;
          ctx.log?.(`dayforce ${inst.ns}: search "${text}" failed: ${e.message}`);
        }
      }
    }

    const items = [];
    for (const [id, j] of found) {
      const title = String(j.jobTitle || '').replace(/\s+/g, ' ').trim();
      if (!title || !ctx.isInternTitle(title)) continue;
      const locations = (j.postingLocations || []).map((l) => l?.formattedAddress || [l?.cityName, l?.stateCode, l?.isoCountryCode].filter(Boolean).join(', ')).filter(Boolean);
      if (j.hasVirtualLocation) locations.push('Remote');
      const d = j.postingStartTimestampUTC ? new Date(j.postingStartTimestampUTC) : null;
      items.push({
        sid: `dayforce:${inst.ns}:${id}`,
        title,
        url: `${HOST}/en-US/${inst.ns}/${inst.board}/jobs/${id}`,
        locations: [...new Set(locations)],
        postedAt: d && !Number.isNaN(d.getTime()) ? d.toISOString() : null,
        comp: null,
      });
    }
    return { complete, items };
  },
};
