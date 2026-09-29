// Optiver — www.optiver.com/join-us/jobs/...
//
// Every Optiver office's openings come from ONE public Greenhouse board, "optiverus" (the
// "optiver" board is empty). One small request returns the full board with ids, titles,
// locations and first_published, so we read it and keep intern titles.
// (The site's own /en/api/v1/jobs?level=internship endpoint pages 16 at a time and exposes no ids.)
//
// URL forms and their sid ('optiver:<greenhouse id>'):
//   www.optiver.com/join-us/jobs/<id>/?gh_jid=<id>                     (Greenhouse absolute_url)
//   optiver.com/working-at-optiver/career-opportunities/<id>/?gh_jid=<id>   (legacy)
//   www.optiver.com/join-us/jobs/<dept>/<city>/<slug>/[?gh_jid=<id>]   (where the id form redirects)
//   boards.greenhouse.io/optiverus/jobs/<id>, job-boards.greenhouse.io/optiverus/jobs/<id>
// The slug form carries no id when gh_jid is absent. Its slug is slugify(title) under
// slugify(city), which we can compute from the board, so canon() resolves it from a map filled
// by the most recent poll() in this process (null before the first poll).

const BOARD = 'optiverus';
const GH_URL = `https://boards-api.greenhouse.io/v1/boards/${BOARD}/jobs`;

const slugify = (s = '') =>
  String(s)
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

// "<city-slug>/<title-slug>" -> greenhouse id; filled by poll(), read by canon().
const slugToId = new Map();
const slugKey = (city, titleSlug) => `${city}/${titleSlug}`;

export default {
  id: 'optiver',
  label: 'Optiver Careers',
  kind: 'company',
  interval: 300,
  instances: [{ key: 'optiver', company: 'Optiver' }],

  canon(url) {
    let u;
    try { u = new URL(url); } catch { return null; }
    const host = u.hostname.toLowerCase();
    if (host === 'optiver.com' || host.endsWith('.optiver.com')) {
      const gh = u.searchParams.get('gh_jid');
      if (gh && /^\d+$/.test(gh)) return `optiver:${gh}`;
      let m = u.pathname.match(/\/(?:join-us\/jobs|working-at-optiver\/career-opportunities)\/(\d{6,})(?:\/|$)/i);
      if (m) return `optiver:${m[1]}`;
      m = u.pathname.match(/\/join-us\/jobs\/[^/]+\/([^/]+)\/([^/]+)\/?$/i);
      if (m) {
        const city = m[1].toLowerCase(), slug = m[2].toLowerCase();
        // CMS de-dupes repeated slugs with "-2", "-3"...
        const id = slugToId.get(slugKey(city, slug)) || slugToId.get(slugKey(city, slug.replace(/-\d$/, '')));
        return id ? `optiver:${id}` : null;
      }
      return null;
    }
    if (/^(boards|job-boards)(\.eu)?\.greenhouse\.io$/.test(host)) {
      const m = u.pathname.match(/^\/optiver(?:us)?\/jobs\/(\d+)/i);
      if (m) return `optiver:${m[1]}`;
      if (/\/embed\/job_app/.test(u.pathname) && /^optiver(us)?$/i.test(u.searchParams.get('for') || '')) {
        const t = u.searchParams.get('token');
        if (t && /^\d+$/.test(t)) return `optiver:${t}`;
      }
    }
    return null;
  },

  async poll(instance, ctx) {
    const data = await ctx.http.json(GH_URL, { timeout: 20_000 });
    if (!Array.isArray(data?.jobs)) throw new Error('optiver: unexpected Greenhouse payload');
    const items = [];
    const seen = new Set();
    for (const j of data.jobs) {
      const locations = j.location?.name ? j.location.name.split(/\s*;\s*/).filter(Boolean) : [];
      const tslug = slugify(j.title);
      for (const loc of locations) slugToId.set(slugKey(slugify(loc.split(',')[0]), tslug), String(j.id));

      const title = String(j.title || '').replace(/\s+/g, ' ').trim();
      if (!ctx.isInternTitle(title)) continue;
      const sid = `optiver:${j.id}`;
      if (seen.has(sid)) continue;
      seen.add(sid);
      items.push({
        sid,
        title,
        url: `https://www.optiver.com/join-us/jobs/${j.id}/?gh_jid=${j.id}`,
        locations,
        postedAt: j.first_published ? new Date(j.first_published).toISOString() : null,
        comp: null,
      });
    }
    return { complete: true, items };
  },
};
