// SmartRecruiters public postings API.

const u = (s) => { try { return new URL(s); } catch { return null; } };

export default {
  id: 'sr',
  label: 'SmartRecruiters',
  kind: 'platform',
  direct: true,
  interval: 300,
  coldInterval: 1200,

  instanceFromUrl(url, company) {
    const x = u(url);
    if (!x || !/^(jobs|careers)\.smartrecruiters\.com$/.test(x.hostname)) return null;
    const id = x.pathname.split('/').filter(Boolean)[0];
    if (!id || /^(oneclick-ui|sr-jobs)$/i.test(id)) return null;
    return { key: `sr:${id.toLowerCase()}`, companyId: id, company };
  },

  canon(url) {
    const x = u(url);
    if (!x || !/^(jobs|careers)\.smartrecruiters\.com$/.test(x.hostname)) return null;
    const seg = x.pathname.split('/').filter(Boolean);
    const m = (seg[1] || '').match(/^(\d{6,})/);
    return m ? `sr:${m[1]}` : null;
  },

  async poll(inst, ctx) {
    const items = new Map();
    let complete = true;
    for (const q of ['intern', 'internship', 'co-op']) {
      for (let offset = 0; offset < 500; offset += 100) {
        const r = await ctx.http.json(
          `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(inst.companyId)}/postings?q=${encodeURIComponent(q)}&limit=100&offset=${offset}`,
        );
        for (const p of r.content || []) {
          if (!ctx.isInternTitle(p.name) || items.has(p.id)) continue;
          const loc = p.location || {};
          const where = loc.fullLocation || [loc.city, loc.region, loc.country?.toUpperCase()].filter(Boolean).join(', ');
          items.set(p.id, {
            sid: `sr:${p.id}`,
            title: p.name.trim(),
            url: `https://jobs.smartrecruiters.com/${inst.companyId}/${p.id}`,
            company: inst.company || p.company?.name,
            locations: [where, loc.remote ? 'Remote' : ''].filter(Boolean),
            postedAt: p.releasedDate || null,
          });
        }
        if ((r.content || []).length < 100) break;
        if (offset + 100 >= 500) complete = false;
      }
    }
    return { complete, items: [...items.values()] };
  },
};
