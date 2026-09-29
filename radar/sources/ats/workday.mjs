// Workday (myworkdayjobs.com and myworkdaysite.com). Workday search is relevance-ranked,
// so we query "intern" and page while pages are still mostly intern titles.

const u = (s) => { try { return new URL(s); } catch { return null; } };
const LOCALE = /^[a-z]{2}-[A-Z]{2}$/;

function parse(url) {
  const x = u(url);
  if (!x) return null;
  const seg = x.pathname.split('/').filter(Boolean);
  let m = x.hostname.match(/^([^.]+)\.(wd\d+)\.myworkdayjobs\.com$/i);
  if (m) {
    const i = LOCALE.test(seg[0] || '') ? 1 : 0;
    const site = seg[i];
    if (!site || site === 'wday') return null;
    return { host: x.hostname.toLowerCase(), tenant: m[1].toLowerCase(), site, rest: seg.slice(i + 1), style: 'jobs' };
  }
  m = x.hostname.match(/^(wd\d+)\.myworkdaysite\.com$/i);
  if (m) {
    const i = seg.indexOf('recruiting');
    if (i < 0 || !seg[i + 1] || !seg[i + 2]) return null;
    return { host: x.hostname.toLowerCase(), tenant: seg[i + 1].toLowerCase(), site: seg[i + 2], rest: seg.slice(i + 3), style: 'site' };
  }
  return null;
}

function jobKey(rest) {
  // rest: ['job', '<location>', '<Title-Slug_REQID>', 'apply', ...]
  const j = rest.indexOf('job');
  if (j < 0) return null;
  const slug = rest.slice(j + 1).filter((s) => !/^apply$|^autofillWithResume$|^useMyLastApplication$/i.test(s)).pop();
  if (!slug) return null;
  const req = slug.includes('_') ? slug.slice(slug.lastIndexOf('_') + 1) : slug;
  return decodeURIComponent(req).toLowerCase();
}

function postedAtFrom(postedOn, now = Date.now()) {
  // Workday only says "Posted Today / Yesterday / N Days Ago": keep day precision (UTC midnight),
  // which the UI renders as a date rather than a fake "10m ago".
  const s = String(postedOn || '').toLowerCase();
  const day = 86_400_000;
  const midnight = (t) => new Date(Math.floor(t / day) * day).toISOString();
  if (s.includes('today')) return midnight(now);
  if (s.includes('yesterday')) return midnight(now - day);
  const m = s.match(/(\d+)\+?\s*days?/);
  if (m && !s.includes('+')) return midnight(now - Number(m[1]) * day);
  return null;
}

export default {
  id: 'wd',
  label: 'Workday',
  kind: 'platform',
  direct: true,
  interval: 300,
  coldInterval: 1200,

  instanceFromUrl(url, company) {
    const p = parse(url);
    if (!p) return null;
    return { key: `wd:${p.tenant}:${p.site.toLowerCase()}`, host: p.host, tenant: p.tenant, site: p.site, style: p.style, company };
  },

  canon(url) {
    const p = parse(url);
    if (!p) return null;
    const k = jobKey(p.rest);
    return k ? `wd:${p.tenant}:${k}` : null;
  },

  async poll(inst, ctx) {
    const api = inst.style === 'site'
      ? `https://${inst.host}/wday/cxs/${inst.tenant}/${inst.site}/jobs`
      : `https://${inst.host}/wday/cxs/${inst.tenant}/${inst.site}/jobs`;
    const pageBase = inst.style === 'site'
      ? `https://${inst.host}/recruiting/${inst.tenant}/${inst.site}`
      : `https://${inst.host}/${inst.site}`;
    const items = new Map();
    const run = async (searchText, maxPages) => {
      for (let page = 0; page < maxPages; page++) {
        const r = await ctx.http.json(api, {
          method: 'POST',
          headers: { accept: 'application/json' },
          body: { appliedFacets: {}, limit: 20, offset: page * 20, searchText },
        });
        const posts = r.jobPostings || [];
        let hits = 0;
        for (const p of posts) {
          if (!p.title || !p.externalPath) continue;
          if (!ctx.isInternTitle(p.title)) continue;
          hits++;
          const url = pageBase + p.externalPath;
          const sid = this.canon(url);
          if (!sid || items.has(sid)) continue;
          items.set(sid, {
            sid,
            title: p.title.trim(),
            url,
            company: inst.company,
            locations: !p.locationsText ? [] : /^\d+ locations$/i.test(p.locationsText) ? ['Multiple locations'] : [p.locationsText],
            postedAt: postedAtFrom(p.postedOn),
          });
        }
        if (posts.length < 20 || hits < posts.length * 0.3) break;
      }
    };
    await run('intern', 6);
    await run('co-op', 1);
    return { complete: false, items: [...items.values()] };
  },
};
