// Greenhouse job boards (boards-api.greenhouse.io). Job ids are global, so any URL carrying
// gh_jid (company-hosted career pages) canonicalizes to the same sid as the board API.

const u = (s) => { try { return new URL(s); } catch { return null; } };

export default {
  id: 'gh',
  label: 'Greenhouse',
  kind: 'platform',
  direct: true,
  interval: 90,
  coldInterval: 600,

  instanceFromUrl(url, company) {
    const x = u(url);
    if (!x || !/(^|\.)greenhouse\.io$/.test(x.hostname)) return null;
    let token = x.searchParams.get('for');
    if (!token) {
      const seg = x.pathname.split('/').filter(Boolean);
      if (seg[0] && !['embed', 'v1', 'jobs'].includes(seg[0])) token = seg[0];
    }
    if (!token || !/^[a-z0-9_-]+$/i.test(token)) return null;
    token = token.toLowerCase();
    return { key: `gh:${token}`, token, company, eu: x.hostname.includes('.eu.') };
  },

  canon(url) {
    const x = u(url);
    if (!x) return null;
    let jid = x.searchParams.get('gh_jid');
    if (!jid && /(^|\.)greenhouse\.io$/.test(x.hostname)) {
      jid = x.searchParams.get('token') || x.pathname.match(/\/jobs\/(\d+)/)?.[1];
    }
    return jid && /^\d+$/.test(jid) ? `gh:${jid}` : null;
  },

  async poll(inst, ctx) {
    const base = inst.eu ? 'https://boards-api.eu.greenhouse.io' : 'https://boards-api.greenhouse.io';
    const r = await ctx.http.request(`${base}/v1/boards/${inst.token}/jobs`, { etag: inst.etag });
    if (r.notModified) return { notModified: true, etag: r.etag };
    const items = [];
    for (const j of r.data.jobs || []) {
      if (!ctx.isInternTitle(j.title)) continue;
      items.push({
        sid: `gh:${j.id}`,
        title: String(j.title).trim(),
        url: j.absolute_url || `https://job-boards.greenhouse.io/${inst.token}/jobs/${j.id}`,
        company: inst.company || j.company_name,
        locations: String(j.location?.name || '').split(/\s*[;|•]\s*/).filter(Boolean),
        postedAt: j.first_published || j.updated_at || null,
      });
    }
    return { complete: true, items, etag: r.etag };
  },
};
