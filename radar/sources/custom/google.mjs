// Google Careers (www.google.com/about/careers/applications).
//
// The results page is a server-rendered Wiz/Boq app: the job list is embedded as
// AF_initDataCallback({key:'ds:1', data:[[jobs...], null, total, pageSize]}), produced by the
// `r06xKb` RPC. We call that same RPC through the app's batchexecute endpoint (≈27 KB gzipped per
// page instead of the ≈1.3 MB HTML page) and fall back to scraping the HTML page if the RPC shape
// ever changes.
//
// RPC request (reverse-engineered from AF_dataServiceRequests for various URL params):
//   [query, null, null, [employmentTypes], locale, null, null, page(1-based), null, null, sort]
//   employmentTypes: 1=FULL_TIME, 2=INTERN, …   sort: 1 = date (newest first)
// Page size is fixed at 20 server-side. `employment_type=INTERN` returns every intern/student
// researcher posting (verified to be a superset of the q=intern / q=internship /
// q="student researcher" keyword searches).

const ORIGIN = 'https://www.google.com';
const RESULTS = `${ORIGIN}/about/careers/applications/jobs/results/`;
const RPC_ID = 'r06xKb';
const BATCH_URL = `${ORIGIN}/about/careers/applications/_/HiringCportalFrontendUi/data/batchexecute`
  + `?rpcids=${RPC_ID}&source-path=${encodeURIComponent('/about/careers/applications/jobs/results/')}&hl=en-US&rt=c`;
const INTERN = 2;
const MAX_PAGES = 15; // 300 results; there are typically 50–150 intern postings

function sid(id) { return `goog:${id}`; }

function reqArray(page) {
  return [null, null, null, [INTERN], 'en-US', null, null, page, null, null, 1];
}

async function rpcPage(ctx, page) {
  const fReq = JSON.stringify([[[RPC_ID, JSON.stringify([reqArray(page)]), null, 'generic']]]);
  const txt = await ctx.http.text(BATCH_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'x-same-domain': '1',
      origin: ORIGIN,
      referer: RESULTS,
    },
    body: new URLSearchParams({ 'f.req': fReq }).toString(),
  });
  // Response: )]}'\n\n<len>\n[["wrb.fr","r06xKb","<json string>",...],...]\n<len>\n...
  for (const line of txt.split('\n')) {
    if (!line.startsWith('[')) continue;
    let outer;
    try { outer = JSON.parse(line); } catch { continue; }
    for (const e of outer) {
      if (Array.isArray(e) && e[0] === 'wrb.fr' && e[1] === RPC_ID) {
        if (typeof e[2] !== 'string') throw new Error(`google rpc ${RPC_ID} returned no payload`);
        return JSON.parse(e[2]);
      }
    }
  }
  throw new Error(`google rpc ${RPC_ID}: unexpected response`);
}

async function htmlPage(ctx, page) {
  const url = `${RESULTS}?employment_type=INTERN&sort_by=date${page > 1 ? `&page=${page}` : ''}`;
  const html = await ctx.http.text(url);
  const m = html.match(/AF_initDataCallback\(\{key: 'ds:1', hash: '\d+', data:([\s\S]*?), sideChannel: \{\}\}\);<\/script>/);
  if (!m) throw new Error('google results page: ds:1 data block not found');
  return JSON.parse(m[1]);
}

function compOf(job) {
  // Pay appears in the "about the job" HTML, e.g. "US: $94000 - $125000 (USD) + 0% bonus target".
  const s = JSON.stringify(job);
  const m = s.match(/([A-Z][A-Za-z .]{1,30}):\s*(\$[\d,]+(?:\s*-\s*\$[\d,]+)?)\s*\(([A-Z]{3})\)/);
  if (!m) return null;
  const fmt = (x) => x.replace(/\d+/g, (n) => Number(n).toLocaleString('en-US'));
  return `${fmt(m[2]).replace(/\s*-\s*/, '–')} ${m[3]}/yr (${m[1].trim()})`;
}

function toItem(j) {
  const id = j?.[0];
  const title = j?.[1];
  if (!id || !title) return null;
  const locations = [];
  for (const l of j[9] || []) if (l?.[0] && !locations.includes(l[0])) locations.push(l[0]);
  const created = Array.isArray(j[12]) && Number(j[12][0]) ? new Date(Number(j[12][0]) * 1000).toISOString() : null;
  return {
    sid: sid(id),
    title: String(title).trim(),
    url: `${RESULTS}${id}`,
    company: j[7] || 'Google',
    locations,
    postedAt: created,
    comp: compOf(j),
  };
}

export default {
  id: 'goog',
  label: 'Google Careers',
  kind: 'company',
  interval: 300,
  instances: [{ key: 'goog', company: 'Google' }],

  canon(url) {
    let u;
    try { u = new URL(url); } catch { return null; }
    const host = u.hostname.toLowerCase();
    if (!(host === 'google.com' || host === 'www.google.com' || host === 'careers.google.com')) return null;
    // /about/careers/applications/jobs/results/<id>[-slug][/], careers.google.com/jobs/results/<id>-slug/
    const m = u.pathname.match(/\/jobs\/results\/(\d{8,})(?:[-/]|$)/);
    return m ? sid(m[1]) : null;
  },

  async poll(instance, ctx) {
    let fetchPage = rpcPage;
    let first;
    try {
      first = await rpcPage(ctx, 1);
      if (!Array.isArray(first)) throw new Error('bad rpc payload');
    } catch (e) {
      ctx.log(`google: batchexecute failed (${e.message}); falling back to HTML`);
      fetchPage = htmlPage;
      first = await htmlPage(ctx, 1);
    }

    const total = Number(first[2]) || 0;
    const pageSize = Number(first[3]) || 20;
    const items = new Map();
    let fetched = 0;
    let complete = true;

    for (let page = 1, data = first; ; ) {
      const jobs = Array.isArray(data?.[0]) ? data[0] : [];
      fetched += jobs.length;
      for (const j of jobs) {
        const it = toItem(j);
        if (!it || items.has(it.sid) || !ctx.isInternTitle(it.title)) continue;
        items.set(it.sid, it);
      }
      if (!jobs.length || fetched >= total) break;
      if (++page > Math.min(MAX_PAGES, Math.ceil(total / pageSize))) { complete = false; break; }
      data = await fetchPage(ctx, page);
    }
    if (fetched < total) complete = false;

    return { complete, items: [...items.values()] };
  },
};
