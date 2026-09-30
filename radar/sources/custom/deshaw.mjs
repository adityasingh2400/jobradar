// D. E. Shaw careers (www.deshaw.com/careers). The Next.js page embeds every open position,
// including an explicit hire status ("Intern"), in __NEXT_DATA__.

const u = (s) => { try { return new URL(s); } catch { return null; } };

function collect(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const x of node) collect(x, out); return; }
  const d = node.data;
  if (d && typeof d === 'object' && d.id && d.displayName && d.jobUrl) {
    out.set(String(d.id), { d, status: node.status || d.status || '', office: node.office || d.office || [] });
  }
  for (const v of Object.values(node)) collect(v, out);
}

export default {
  id: 'deshaw',
  label: 'D. E. Shaw Careers',
  kind: 'company',
  interval: 180,
  instances: [{ key: 'deshaw', company: 'D. E. Shaw' }],

  canon(url) {
    const x = u(url);
    if (!x || !/(^|\.)deshaw\.com$/.test(x.hostname)) return null;
    const m = x.pathname.match(/\/careers\/[^/]*?-(\d{3,})\/?$/i);
    return m ? `deshaw:${m[1]}` : null;
  },

  async poll(inst, ctx) {
    const html = await ctx.http.text('https://www.deshaw.com/careers/choose-your-path', { timeout: 40_000 });
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new Error('deshaw: __NEXT_DATA__ not found (page layout changed)');
    const jobs = new Map();
    collect(JSON.parse(m[1]), jobs);
    if (jobs.size < 5) throw new Error(`deshaw: only ${jobs.size} positions parsed (page layout changed?)`);
    const items = [];
    for (const [id, { d, status, office }] of jobs) {
      if (d.activeOnJobsListing === false) continue;
      const intern = /intern/i.test(String(status)) || /intern/i.test(String(d.hireType || ''));
      const title = String(d.displayName).replace(/\s+/g, ' ').trim();
      if (!intern && !ctx.isInternTitle(title)) continue;
      items.push({
        sid: `deshaw:${id}`,
        title,
        intern,
        url: `https://www.deshaw.com/careers/${String(d.jobUrl).toLowerCase()}`,
        company: inst.company,
        locations: (office || []).map((o) => o.name).filter(Boolean),
        postedAt: null,
      });
    }
    return { complete: true, items };
  },
};
