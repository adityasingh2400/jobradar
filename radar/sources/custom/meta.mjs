// Meta Careers (www.metacareers.com) — Relay/GraphQL site, works with plain HTTP.
//
// How the job list loads: /jobsearch/ renders a shell; the client then runs the persisted Relay
// query `CareersJobSearchResultsDataQuery` (POST /graphql, form-encoded, doc_id + variables + the
// logged-out `lsd` token that the page embeds as ["LSD",[],{"token":"..."}]). With
// `results_per_page: null` and an empty query it returns EVERY open job ({id,title,locations,teams})
// in one ~220 KB (~40 KB gzipped) response, so we take the whole list and filter titles locally —
// Meta's keyword search is fuzzy ("intern" returns ~400 mostly unrelated jobs) and the `roles`
// filter does not work for logged-out users.
//
// Requests per poll: 1 GraphQL call (+1 page fetch to refresh the lsd token every few hours or on
// failure) + at most DETAIL_PER_POLL detail pages for newly seen intern jobs to learn datePosted
// (the list query exposes no dates). Plain requests to metacareers.com without browser
// Sec-Fetch-* headers are rejected with HTTP 400, so we send them.
//
// Fragile parts: doc_id rotates when Meta ships a new version of the query. If the known ids fail
// we rediscover them from the page's JS bundles (module
// "CareersJobSearchResults[V2]DataQuery_candidate_portalRelayOperation").

const ORIGIN = 'https://www.metacareers.com';
const SEARCH_PAGE = `${ORIGIN}/jobsearch/`;
const QUERIES = [
  { name: 'CareersJobSearchResultsDataQuery', docId: '27506805582236862' },
  { name: 'CareersJobSearchResultsV2DataQuery', docId: '27129360303422352' },
];
const TOKEN_TTL_MS = 6 * 3600_000;
const DETAIL_PER_POLL = 4;

const NAV_HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'sec-fetch-site': 'none',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
};

// module-level caches (the runner is long-lived; everything is re-derived if lost)
const state = { lsd: null, lsdAt: 0, html: null, docIds: {} };
const postedCache = new Map(); // job id -> ISO string | null (null = looked up, not found)

const sid = (id) => `meta:${id}`;

async function refreshPage(ctx) {
  const html = await ctx.http.text(SEARCH_PAGE, { headers: NAV_HEADERS });
  const m = html.match(/\["LSD",\[\],\{"token":"([^"]+)"/);
  if (!m) throw new Error('meta: LSD token not found on /jobsearch/');
  state.lsd = m[1];
  state.lsdAt = Date.now();
  state.html = html;
}

async function rediscoverDocIds(ctx) {
  if (!state.html) await refreshPage(ctx);
  const urls = [...new Set((state.html.match(/https:\\?\/\\?\/static[^"\s]+?\.js[^"\s]*/g) || []).map((u) => u.replace(/\\\//g, '/')))];
  const want = new Set(QUERIES.map((q) => q.name));
  for (const u of urls) {
    let js;
    try { js = await ctx.http.text(u, { headers: { accept: '*/*' } }); } catch { continue; }
    for (const name of want) {
      const m = js.match(new RegExp(`__d\\("${name}_candidate_portalRelayOperation",\\[\\],\\(function\\([^)]*\\)\\{\\w+\\.exports="(\\d+)"`));
      if (m) { state.docIds[name] = m[1]; want.delete(name); }
    }
    if (!want.size) break;
  }
  return QUERIES.some((q) => state.docIds[q.name]);
}

async function runQuery(ctx, q) {
  const docId = state.docIds[q.name] || q.docId;
  const variables = {
    isLoggedIn: false,
    viewasUserID: null,
    search_input: {
      q: null, divisions: [], offices: [], roles: [], leadership_levels: [], saved_jobs: [], saved_searches: [],
      sub_teams: [], teams: [], is_leadership: false, is_remote_only: false, sort_by_new: true, results_per_page: null,
    },
  };
  const body = new URLSearchParams({
    av: '0', __user: '0', __a: '1', lsd: state.lsd,
    fb_api_caller_class: 'RelayModern', fb_api_req_friendly_name: q.name,
    variables: JSON.stringify(variables), server_timestamps: 'true', doc_id: docId,
  }).toString();
  const txt = await ctx.http.text(`${ORIGIN}/graphql`, {
    method: 'POST',
    retries: 1,
    headers: {
      accept: '*/*',
      'content-type': 'application/x-www-form-urlencoded',
      'x-fb-lsd': state.lsd,
      'x-fb-friendly-name': q.name,
      origin: ORIGIN,
      referer: SEARCH_PAGE,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    },
    body,
  });
  const json = JSON.parse(txt.replace(/^for \(;;\);/, '').split('\n')[0]);
  const root = json?.data?.job_search_with_featured_jobs || json?.data?.job_search_with_featured_jobs_v2;
  if (!root || !Array.isArray(root.all_jobs)) {
    throw new Error(`meta graphql ${q.name}: ${JSON.stringify(json?.errors || json).slice(0, 200)}`);
  }
  return [...root.all_jobs, ...(root.featured_jobs || [])];
}

async function allJobs(ctx) {
  if (!state.lsd || Date.now() - state.lsdAt > TOKEN_TTL_MS) await refreshPage(ctx);
  const errors = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const q of QUERIES) {
      try { return await runQuery(ctx, q); } catch (e) { errors.push(e.message); }
    }
    if (attempt === 0) await refreshPage(ctx); // stale lsd?
    else if (attempt === 1 && !(await rediscoverDocIds(ctx))) break; // rotated doc_id?
  }
  throw new Error(`meta: job search failed: ${errors.slice(-2).join(' / ')}`);
}

async function datePosted(ctx, id) {
  try {
    const html = await ctx.http.text(`${ORIGIN}/profile/job_details/${id}/`, { headers: NAV_HEADERS, retries: 1 });
    const m = html.match(/"datePosted"\s*:\s*"([^"]+)"/);
    const t = m ? Date.parse(m[1]) : NaN;
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  } catch (e) {
    ctx.log(`meta: detail ${id} failed (${e.message})`);
    return undefined; // retry on a later poll
  }
}

export default {
  id: 'meta',
  label: 'Meta Careers',
  kind: 'company',
  interval: 300,
  instances: [{ key: 'meta', company: 'Meta' }],

  canon(url) {
    let u;
    try { u = new URL(url); } catch { return null; }
    if (!/(^|\.)(metacareers|facebookcareers)\.com$/i.test(u.hostname)) return null;
    // /jobs/<id>[/], /v2/jobs/<id>, /profile/job_details/<id>/, /careers/jobs/<id>, ?req=<id> on apply flows
    const m = u.pathname.match(/\/(?:jobs|job_details)\/(\d{8,})(?:[/?#]|$)/i);
    if (m) return sid(m[1]);
    for (const p of ['req', 'jobId', 'job_id', 'reqid']) {
      const v = u.searchParams.get(p);
      if (v && /^\d{8,}$/.test(v)) return sid(v);
    }
    return null;
  },

  async poll(instance, ctx) {
    const jobs = await allJobs(ctx);
    const items = new Map();
    for (const j of jobs) {
      const id = String(j?.id || '');
      const title = String(j?.title || '').trim();
      if (!/^\d+$/.test(id) || !title || items.has(id) || !ctx.isInternTitle(title)) continue;
      items.set(id, {
        sid: sid(id),
        title,
        url: `${ORIGIN}/jobs/${id}/`,
        company: 'Meta',
        locations: Array.isArray(j.locations) ? j.locations.map((l) => String(l).trim()).filter(Boolean) : [],
        postedAt: postedCache.get(id) ?? null,
        comp: null,
      });
    }

    // Fill in datePosted for a few newly seen intern jobs per poll.
    const missing = [...items.keys()].filter((id) => !postedCache.has(id)).slice(0, DETAIL_PER_POLL);
    const got = await ctx.http.mapLimit(missing, 2, (id) => datePosted(ctx, id));
    missing.forEach((id, i) => {
      const v = got[i].ok ? got[i].value : undefined;
      if (v !== undefined) postedCache.set(id, v);
      if (v) items.get(id).postedAt = v;
    });

    // Meta always has hundreds of open roles; a near-empty list means a broken response, not closures.
    return { complete: jobs.length >= 50, items: [...items.values()] };
  },
};
