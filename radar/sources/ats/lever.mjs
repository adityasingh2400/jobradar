// Lever postings API. Posting ids are global UUIDs.

const u = (s) => { try { return new URL(s); } catch { return null; } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fmtSalary(s) {
  if (!s || !s.min) return null;
  const k = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  const per = { 'per-hour-wage': '/hr', 'per-month-salary': '/mo', 'per-year-salary': '/yr' }[s.interval] || '';
  const cur = s.currency === 'USD' ? '$' : `${s.currency} `;
  return s.max && s.max !== s.min ? `${cur}${k(s.min)}–${k(s.max)}${per}` : `${cur}${k(s.min)}${per}`;
}

export default {
  id: 'lever',
  label: 'Lever',
  kind: 'platform',
  direct: true,
  interval: 90,
  coldInterval: 600,

  instanceFromUrl(url, company) {
    const x = u(url);
    if (!x || !/^jobs(\.eu)?\.lever\.co$/.test(x.hostname)) return null;
    const org = x.pathname.split('/').filter(Boolean)[0];
    if (!org) return null;
    return { key: `lever:${org.toLowerCase()}`, org, company, eu: x.hostname.includes('.eu.') };
  },

  canon(url) {
    const x = u(url);
    if (!x || !/^jobs(\.eu)?\.lever\.co$/.test(x.hostname)) return null;
    const id = x.pathname.split('/').filter(Boolean)[1];
    return id && UUID.test(id) ? `lever:${id.toLowerCase()}` : null;
  },

  async poll(inst, ctx) {
    const base = inst.eu ? 'https://api.eu.lever.co' : 'https://api.lever.co';
    const r = await ctx.http.request(`${base}/v0/postings/${inst.org}?mode=json`, { etag: inst.etag, timeout: 40_000 });
    if (r.notModified) return { notModified: true, etag: r.etag };
    const items = [];
    for (const p of Array.isArray(r.data) ? r.data : []) {
      const commitment = p.categories?.commitment || '';
      const intern = /\bintern|co-?op\b/i.test(commitment);
      if (!ctx.isInternTitle(p.text) && !intern) continue;
      items.push({
        sid: `lever:${p.id.toLowerCase()}`,
        title: String(p.text).trim(),
        intern,
        url: p.hostedUrl,
        company: inst.company,
        locations: p.categories?.allLocations?.length ? p.categories.allLocations : [p.categories?.location].filter(Boolean),
        postedAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
        comp: fmtSalary(p.salaryRange),
      });
    }
    return { complete: true, items, etag: r.etag };
  },
};
