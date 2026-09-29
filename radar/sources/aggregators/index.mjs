// Aggregator feeds: curated community lists and big boards. Their items carry the employer's
// URL (or the aggregator's), and the engine canonicalizes them so they merge with direct hits.

import { htmlText } from '../../lib/http.mjs';

const RAW = 'https://raw.githubusercontent.com';

// ---------- SimplifyJobs-format listings.json (Simplify, vanshb03) ----------
function listingsSource({ id, label, repo, branch = 'dev', interval = 120 }) {
  return {
    id, label, kind: 'aggregator', interval,
    instances: [{ key: id, company: '' }],
    canon: () => null,
    async poll(inst, ctx) {
      const r = await ctx.http.request(`${RAW}/${repo}/${branch}/.github/scripts/listings.json`, { etag: inst.etag, timeout: 60_000 });
      if (r.notModified) return { notModified: true, etag: r.etag };
      const items = [];
      for (const x of r.data) {
        if (!x.active || x.is_visible === false || !x.url) continue;
        items.push({
          title: x.title,
          url: x.url,
          company: x.company_name,
          locations: x.locations || [],
          postedAt: x.date_posted ? new Date(x.date_posted * 1000).toISOString() : null,
          intern: true,
          terms: x.terms || (x.season ? [x.season] : []),
          catHint: x.category || '',
          sponsor: x.sponsorship && x.sponsorship !== 'Other' ? x.sponsorship : '',
        });
      }
      return { complete: true, items, etag: r.etag };
    },
  };
}

// ---------- Markdown/HTML table helpers ----------
function cells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}
function firstHref(s) {
  return s.match(/href="([^"]+)"/)?.[1] || s.match(/\]\((https?:[^)\s]+)\)/)?.[1] || null;
}
function mdText(s) {
  return htmlText(s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*/g, '').replace(/<img[^>]*>/g, ''));
}
function ageToIso(age, now = Date.now()) {
  const m = String(age).trim().match(/^(\d+)\s*(mo|m|h|d|w)/i);
  if (!m) return null;
  const mult = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, mo: 2_592_000_000 }[m[2].toLowerCase()];
  return new Date(now - Number(m[1]) * mult).toISOString();
}
function agoToIso(s, now = Date.now()) {
  const m = String(s).match(/(\d+)\s*(minute|hour|day|week|month)/i);
  if (!m) return null;
  const mult = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000, month: 2_592_000_000 }[m[2].toLowerCase()];
  return new Date(now - Number(m[1]) * mult).toISOString();
}
function monthDayToIso(s, now = new Date()) {
  const d = new Date(`${s} ${now.getUTCFullYear()} 12:00:00 UTC`);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getTime() > now.getTime() + 86_400_000) d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d.toISOString();
}

// speedyapply: | Company | Position | Location | Salary | Posting | Age |
function speedySource({ id, label, repo }) {
  return {
    id, label, kind: 'aggregator', interval: 180,
    instances: [{ key: id, company: '' }],
    canon: () => null,
    async poll(inst, ctx) {
      const r = await ctx.http.request(`${RAW}/${repo}/main/README.md`, { as: 'text', etag: inst.etag });
      if (r.notModified) return { notModified: true, etag: r.etag };
      const items = [];
      let inTable = false;
      for (const line of r.data.split('\n')) {
        if (/^\|\s*Company\s*\|\s*Position/i.test(line)) { inTable = true; continue; }
        if (!line.startsWith('|')) { inTable = false; continue; }
        if (!inTable || /^\|\s*-+/.test(line)) continue;
        const c = cells(line);
        if (c.length < 6) continue;
        const url = firstHref(c[4]);
        if (!url) continue;
        items.push({
          title: mdText(c[1]),
          url,
          company: mdText(c[0]),
          locations: mdText(c[2]).split(/\s*;\s*|<\/br>|<br\s*\/?>/i).filter(Boolean),
          postedAt: ageToIso(mdText(c[5])),
          comp: mdText(c[3]) || null,
          intern: true,
        });
      }
      return { complete: true, items, etag: r.etag };
    },
  };
}

// jobright: | **[Company](site)** | **[Title](jobright link)** | Location | Work Model | Date Posted |
function jobrightSource({ id, label, repo }) {
  return {
    id, label, kind: 'aggregator', interval: 300,
    instances: [{ key: id, company: '' }],
    canon: () => null,
    async poll(inst, ctx) {
      const r = await ctx.http.request(`${RAW}/${repo}/master/README.md`, { as: 'text', etag: inst.etag });
      if (r.notModified) return { notModified: true, etag: r.etag };
      const items = [];
      let company = '';
      for (const line of r.data.split('\n')) {
        if (!line.startsWith('|') || /^\|\s*(Company|-)/i.test(line)) continue;
        const c = cells(line);
        if (c.length < 5) continue;
        const co = mdText(c[0]);
        if (co && co !== '↳') company = co;
        const url = firstHref(c[1]);
        if (!url || !company) continue;
        items.push({
          title: mdText(c[1]),
          url: url.replace(/[?&]utm_[^&]+/g, '').replace(/\?$/, ''),
          company,
          locations: [mdText(c[2])].filter(Boolean),
          postedAt: monthDayToIso(mdText(c[4])),
          workModel: mdText(c[3]),
          intern: true,
        });
      }
      return { complete: true, items, etag: r.etag };
    },
  };
}

// LinkedIn public guest search (no login). Newest-first; great early signal, merged by company+title.
function linkedinSource() {
  const queries = [
    'software engineer intern', 'software engineering internship', 'software developer intern',
    'machine learning intern', 'AI engineer intern', 'research intern machine learning',
    'data science intern', 'software co-op',
  ];
  return {
    id: 'linkedin', label: 'LinkedIn', kind: 'aggregator', interval: 600, staleDays: 21, runners: ['mac', 'actions'],
    instances: queries.map((q) => ({ key: `linkedin:${q.replace(/\s+/g, '-')}`, company: '', query: q })),
    canon: () => null,
    async poll(inst, ctx) {
      const items = new Map();
      for (let start = 0; start < 50; start += 10) {
        const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(inst.query)}&location=United%20States&f_TPR=r86400&sortBy=DD&start=${start}`;
        if (start) await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500));
        const html = await ctx.http.text(url, { retries: 1 });
        const cards = html.match(/<li>[\s\S]*?<\/li>/g) || [];
        for (const c of cards) {
          const title = htmlText(c.match(/base-search-card__title">([\s\S]*?)</)?.[1] || '');
          const company = htmlText(c.match(/base-search-card__subtitle">[\s\S]*?>([\s\S]*?)</)?.[1] || '');
          const loc = htmlText(c.match(/job-search-card__location">([\s\S]*?)</)?.[1] || '');
          const when = c.match(/<time[^>]*datetime="([^"]+)"/)?.[1];
          const ago = htmlText(c.match(/<time[^>]*>([\s\S]*?)</)?.[1] || '');
          const href = c.match(/href="(https:\/\/[a-z.]*linkedin\.com\/jobs\/view\/[^"?]+)/)?.[1];
          const jobId = href?.match(/-(\d{8,})$/)?.[1] || href?.match(/(\d{8,})/)?.[1];
          if (!title || !company || !jobId || !ctx.isInternTitle(title)) continue;
          const agoIso = agoToIso(ago);
          items.set(jobId, {
            title,
            url: `https://www.linkedin.com/jobs/view/${jobId}`,
            company,
            locations: loc ? [loc] : [],
            postedAt: agoIso || (when ? new Date(`${when}T12:00:00Z`).toISOString() : null),
            intern: true,
          });
        }
        if (cards.length < 10) break;
      }
      return { complete: false, items: [...items.values()] };
    },
  };
}

export default [
  listingsSource({ id: 'simplify', label: 'Simplify', repo: 'SimplifyJobs/Summer2027-Internships' }),
  listingsSource({ id: 'vansh', label: 'CSCareers (vanshb03)', repo: 'vanshb03/Summer2027-Internships', interval: 300 }),
  speedySource({ id: 'speedy-swe', label: 'SpeedyApply SWE', repo: 'speedyapply/2027-SWE-College-Jobs' }),
  speedySource({ id: 'speedy-ai', label: 'SpeedyApply AI', repo: 'speedyapply/2027-AI-College-Jobs' }),
  jobrightSource({ id: 'jobright', label: 'Jobright', repo: 'jobright-ai/2026-Software-Engineer-Internship' }),
  linkedinSource(),
];
