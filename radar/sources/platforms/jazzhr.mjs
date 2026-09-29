// JazzHR career pages (<company>.applytojob.com).
//
// Job URLs:  https://<co>.applytojob.com/apply/<jobCode>/<Title-Slug>[?source=...]
//            https://<co>.applytojob.com/apply/<jobCode>
//            https://<co>.applytojob.com/apply/jobs/details/<jobCode>
//            (http:// variants appear on aggregators too)
// <jobCode> is a 10-char case-sensitive board code, unique across JazzHR -> sid = jazz:<jobCode>.
//
// List:   GET https://<co>.applytojob.com/apply  -> server-rendered page with every open job
//         (<h3 class="list-group-item-heading"><a href=".../apply/<code>/<slug>">Title</a></h3>
//          <ul><li><i class="fa fa-map-marker"></i>City, ST</li><li><i class="fa fa-sitemap"></i>Dept</li></ul>)
//         No paging (boards with 230+ jobs render in one page). Unknown/closed accounts redirect to
//         www.jazzhr.com/job-seekers.
// Detail: the job page has JSON-LD JobPosting (datePosted, baseSalary). Fetched only for NEW intern
//         jobs, at most DETAIL_PER_POLL per poll, cached per process.

const HOST_RE = /^([a-z0-9][a-z0-9-]*)\.applytojob\.com$/i;
const CODE_RE = /^[A-Za-z0-9]{10}$/;
const DETAIL_PER_POLL = 3;
const detailCache = new Map(); // code -> { postedAt, comp }

function parse(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const m = u.hostname.match(HOST_RE);
  if (!m || m[1].toLowerCase() === 'www') return null;
  const co = m[1].toLowerCase();
  const segs = u.pathname.split('/').filter(Boolean);
  let code = null;
  if (segs[0] === 'apply') {
    if (segs[1] === 'jobs' && segs[2] === 'details' && CODE_RE.test(segs[3] || '')) code = segs[3];
    else if (CODE_RE.test(segs[1] || '')) code = segs[1];
  }
  return { co, code };
}

function decode(s) {
  return String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

function fmtSalary(bs) {
  const v = bs?.value;
  if (!v) return null;
  const lo = Number(v.minValue ?? v.value);
  const hi = Number(v.maxValue ?? v.value);
  if (!Number.isFinite(lo) || lo <= 0) return null;
  const cur = bs.currency === 'USD' || !bs.currency ? '$' : `${bs.currency} `;
  const per = { HOUR: '/hr', YEAR: '/yr', MONTH: '/mo', WEEK: '/wk', DAY: '/day' }[String(v.unitText || '').toUpperCase()] || '';
  const f = (n) => `${cur}${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  return `${!Number.isFinite(hi) || hi === lo ? f(lo) : `${f(lo)} - ${f(hi)}`}${per}`;
}

async function fetchDetail(url, ctx) {
  const html = await ctx.http.text(url, { retries: 1 });
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    try {
      const j = JSON.parse(m[1]);
      if (j['@type'] !== 'JobPosting') continue;
      const d = j.datePosted ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(j.datePosted) ? `${j.datePosted}T00:00:00Z` : j.datePosted) : null;
      return { postedAt: d && !Number.isNaN(d.getTime()) ? d.toISOString() : null, comp: fmtSalary(j.baseSalary) };
    } catch { /* keep looking */ }
  }
  return { postedAt: null, comp: null };
}

export default {
  id: 'jazz',
  label: 'JazzHR',
  kind: 'platform',
  interval: 1800,

  instanceFromUrl(url, company) {
    const p = parse(url);
    if (!p) return null;
    return { key: `jazz:${p.co}`, company: company || p.co, co: p.co };
  },

  seedInstances: [],

  canon(url) {
    const p = parse(url);
    return p?.code ? `jazz:${p.code}` : null;
  },

  async poll(instance, ctx) {
    const co = instance.co || String(instance.key).replace(/^jazz:/, '');
    const origin = `https://${co}.applytojob.com`;
    const res = await ctx.http.request(`${origin}/apply`, { as: 'text' });
    const html = String(res.data || '');
    if (!/\.applytojob\.com$/i.test(new URL(res.url || origin).hostname)) {
      throw new Error(`jazz: no career page for "${co}" (redirected to ${res.url})`);
    }

    // Accounts that stopped using JazzHR keep the subdomain but render "JazzHR - Inactive Career Page".
    if (/<title>[^<]*Inactive Career Page/i.test(html)) {
      ctx.log?.(`jazz: ${co} career page is inactive`);
      return { complete: true, items: [] };
    }

    const rows = [];
    const re = /<h3 class=['"]list-group-item-heading['"]>\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h3>\s*(<ul[\s\S]*?<\/ul>)?/g;
    let m;
    while ((m = re.exec(html))) {
      const p = parse(m[1].replace(/^\/\//, 'https://').replace(/^\//, `${origin}/`));
      if (!p?.code) continue;
      const meta = m[3] || '';
      const loc = meta.match(/fa-map-marker['"]><\/i>([\s\S]*?)<\/li>/);
      rows.push({ code: p.code, title: decode(m[2]), loc: loc ? decode(loc[1]) : '' });
    }
    if (!rows.length && !/list-group|There are currently no|no open positions|resumator/i.test(html)) {
      throw new Error(`jazz: could not parse job list for ${co}`);
    }

    const seen = new Set();
    const interns = rows.filter((r) => {
      if (seen.has(r.code) || !r.title || !ctx.isInternTitle(r.title)) return false;
      seen.add(r.code);
      return true;
    });

    const todo = interns.filter((r) => !detailCache.has(r.code)).slice(0, DETAIL_PER_POLL);
    await ctx.http.mapLimit(todo, 2, async (r) => {
      try {
        detailCache.set(r.code, await fetchDetail(`${origin}/apply/${r.code}`, ctx));
      } catch (e) {
        if (e?.status === 404) detailCache.set(r.code, {});
      }
    });
    if (detailCache.size > 20_000) detailCache.clear();

    const items = interns.map((r) => {
      const d = detailCache.get(r.code) || {};
      return {
        sid: `jazz:${r.code}`,
        title: r.title,
        url: `${origin}/apply/${r.code}`,
        locations: r.loc ? [r.loc] : [],
        postedAt: d.postedAt ?? null,
        comp: d.comp ?? null,
      };
    });
    return { complete: true, items };
  },
};
