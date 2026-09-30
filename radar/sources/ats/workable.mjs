// Workable hosted job boards (apply.workable.com).

const u = (s) => { try { return new URL(s); } catch { return null; } };

export default {
  id: 'wk',
  label: 'Workable',
  kind: 'platform',
  direct: true,
  interval: 300,
  coldInterval: 900,

  instanceFromUrl(url, company) {
    const x = u(url);
    if (!x || x.hostname !== 'apply.workable.com') return null;
    const acct = x.pathname.split('/').filter(Boolean)[0];
    if (!acct || acct === 'api') return null;
    return { key: `wk:${acct.toLowerCase()}`, account: acct, company };
  },

  canon(url) {
    const x = u(url);
    if (!x || x.hostname !== 'apply.workable.com') return null;
    const m = x.pathname.match(/\/j\/([A-Z0-9]+)/i);
    return m ? `wk:${m[1].toUpperCase()}` : null;
  },

  async poll(inst, ctx) {
    // The widget feed is CDN-cached and not rate-limited; the search API (fallback) is strict.
    try {
      const d = await ctx.http.json(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(inst.account)}`);
      const items = [];
      for (const j of d.jobs || []) {
        const intern = /intern|co-?op|apprentice|trainee/i.test(j.employment_type || '');
        if (!ctx.isInternTitle(j.title) && !intern) continue;
        const code = String(j.shortcode).toUpperCase();
        items.push({
          sid: `wk:${code}`,
          title: String(j.title).trim(),
          intern,
          url: `https://apply.workable.com/${inst.account}/j/${code}/`,
          company: inst.company || d.name,
          locations: [[j.city, j.state, j.country].filter(Boolean).join(', '), j.telecommuting ? 'Remote' : ''].filter(Boolean),
          postedAt: j.published_on || j.created_at || null,
        });
      }
      return { complete: true, items };
    } catch (e) {
      if (e.status === 404) throw e;
    }
    const items = new Map();
    let token;
    for (let page = 0; page < 5; page++) {
      const r = await ctx.http.json(`https://apply.workable.com/api/v3/accounts/${encodeURIComponent(inst.account)}/jobs`, {
        method: 'POST',
        body: { query: 'intern', location: [], department: [], worktype: [], remote: [], ...(token ? { token } : {}) },
      });
      for (const j of r.results || []) {
        if (!ctx.isInternTitle(j.title)) continue;
        const code = String(j.shortcode).toUpperCase();
        const loc = j.location || {};
        items.set(code, {
          sid: `wk:${code}`,
          title: j.title.trim(),
          url: `https://apply.workable.com/${inst.account}/j/${code}/`,
          company: inst.company,
          locations: [[loc.city, loc.region, loc.country].filter(Boolean).join(', '), j.remote ? 'Remote' : ''].filter(Boolean),
          postedAt: j.published || null,
        });
      }
      token = r.nextPage;
      if (!token) return { complete: true, items: [...items.values()] };
    }
    return { complete: false, items: [...items.values()] };
  },
};
