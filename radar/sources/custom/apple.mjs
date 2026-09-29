// Apple (jobs.apple.com) — the React search page calls POST /api/v1/search (JSON), guarded by an
// X-Apple-CSRF-Token obtained from GET /api/v1/CSRFToken (plus the session cookies it sets).
// Page size is fixed at 20 and each result is one position x location (multi-location postings
// repeat with ids like "200685016-3435"), so we merge by positionId.
//
// Apple's search has no OR operator, and no single query covers every internship, so we sweep:
//   - the Students › Internships team filter (the site's own intern category)
//   - query "intern"     (quoted: unquoted `intern` fuzzy-matches "IN-" retail roles in India)
//   - query "internship" (catches "... Internship" titles outside the intern team)
// all sorted newest-first. Verified: union == every intern-titled posting found by any of
// intern / internship / internships / interns / co-op / student / team queries.

const ORIGIN = 'https://jobs.apple.com';
const LOCALE = 'en-us';
const MAX_PAGES = 15; // per query (300 results)
const FORMAT = { longDate: 'MMMM D, YYYY', mediumDate: 'MMM D, YYYY' };

const SWEEPS = [
  { query: '', filters: { teams: [{ team: 'teamsAndSubTeams-STDNT', subTeam: 'subTeam-INTRN' }] } },
  { query: '"intern"', filters: {} },
  { query: 'internship', filters: {} },
];

function sid(positionId) { return `apple:${positionId}`; }

async function session(ctx) {
  try {
    const r = await ctx.http.request(`${ORIGIN}/api/v1/CSRFToken`, { as: 'text', headers: { referer: `${ORIGIN}/${LOCALE}/search` } });
    const token = r.headers.get('x-apple-csrf-token') || '';
    const cookie = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).filter((c) => !/=(_remove_)?$/.test(c)).join('; ');
    return { token, cookie };
  } catch (e) {
    ctx.log(`apple: CSRF token fetch failed (${e.message}); continuing without`);
    return { token: '', cookie: '' };
  }
}

async function searchPage(ctx, sess, sweep, page) {
  const headers = {
    locale: 'en-US',
    browserlocale: LOCALE,
    origin: ORIGIN,
    referer: `${ORIGIN}/${LOCALE}/search`,
  };
  if (sess.token) headers['x-apple-csrf-token'] = sess.token;
  if (sess.cookie) headers.cookie = sess.cookie;
  const data = await ctx.http.json(`${ORIGIN}/api/v1/search`, {
    method: 'POST',
    headers,
    body: { query: sweep.query, filters: sweep.filters, page, locale: LOCALE, sort: 'newest', format: FORMAT },
  });
  const res = data?.res;
  if (!res || !Array.isArray(res.searchResults)) throw new Error(`apple search: unexpected response ${JSON.stringify(data).slice(0, 200)}`);
  return res;
}

function locOf(l) {
  if (Number(l?.level) === 1 && l?.countryName) return String(l.countryName).trim(); // country-wide posting
  const parts = [];
  for (const p of [l?.name, l?.stateProvince, l?.countryName]) {
    const s = String(p || '').trim();
    if (s && !parts.includes(s)) parts.push(s);
  }
  return parts.join(', ');
}

function isoOf(s) {
  if (!s) return null;
  // "2026-09-29T00:05:57.066564700Z" -> trim sub-millisecond digits
  const t = String(s).replace(/(\.\d{3})\d+Z$/, '$1Z');
  return Number.isNaN(Date.parse(t)) ? null : new Date(t).toISOString();
}

export default {
  id: 'apple',
  label: 'Apple Jobs',
  kind: 'company',
  interval: 600,
  instances: [{ key: 'apple', company: 'Apple' }],

  canon(url) {
    let u;
    try { u = new URL(url); } catch { return null; }
    if (u.hostname.toLowerCase() !== 'jobs.apple.com') return null;
    // /en-us/details/200685172[-0836][/slug][/locationPicker][?team=STDNT]
    // /app/en-us/apply/200685172, /en-gb/details/PIPE-200313970/...
    const m = u.pathname.match(/\/(?:details|apply)\/(?:[A-Z]+-)?(\d{6,})(?:-\d+)?(?:[/?#]|$)/i);
    return m ? sid(m[1]) : null;
  },

  async poll(instance, ctx) {
    const sess = await session(ctx);
    const items = new Map();
    let complete = true;

    const absorb = (rows) => {
      for (const r of rows) {
        const pid = String(r.positionId || '').replace(/^\D+-/, '').replace(/-\d+$/, '');
        const title = String(r.postingTitle || '').trim();
        if (!/^\d+$/.test(pid) || !title || !ctx.isInternTitle(title)) continue;
        const loc = (r.locations || []).map(locOf).filter(Boolean);
        const prev = items.get(pid);
        if (prev) {
          for (const l of loc) if (!prev.locations.includes(l)) prev.locations.push(l);
          continue;
        }
        const slug = r.transformedPostingTitle ? `/${encodeURIComponent(r.transformedPostingTitle)}` : '';
        const team = r.team?.teamCode ? `?team=${encodeURIComponent(r.team.teamCode)}` : '';
        items.set(pid, {
          sid: sid(pid),
          title,
          url: `${ORIGIN}/${LOCALE}/details/${pid}${slug}${team}`,
          company: 'Apple',
          locations: [...new Set(loc)],
          postedAt: isoOf(r.postDateInGMT),
          comp: null,
        });
      }
    };

    let okSweeps = 0;
    let lastErr;
    for (const sweep of SWEEPS) {
      try {
        const first = await searchPage(ctx, sess, sweep, 1);
        absorb(first.searchResults);
        const total = Number(first.totalRecords) || 0;
        const per = first.searchResults.length || 20;
        const pages = Math.ceil(total / per);
        if (pages > MAX_PAGES) complete = false;
        const rest = [];
        for (let p = 2; p <= Math.min(pages, MAX_PAGES); p++) rest.push(p);
        const results = await ctx.http.mapLimit(rest, 2, (p) => searchPage(ctx, sess, sweep, p));
        for (const r of results) {
          if (r.ok) absorb(r.value.searchResults);
          else { complete = false; lastErr = r.error; }
        }
        okSweeps++;
      } catch (e) {
        complete = false;
        lastErr = e;
        ctx.log(`apple: sweep ${JSON.stringify(sweep.query || sweep.filters)} failed: ${e.message}`);
      }
    }
    if (!okSweeps) throw lastErr || new Error('apple: all sweeps failed');

    return { complete, items: [...items.values()] };
  },
};
