// Amazon (amazon.jobs) — public search.json endpoint used by the site's own search page.
//
// Coverage strategy (verified against keyword / category / employee_class sweeps):
//   1. `is_intern[]=1` facet filter, newest first — the site's own intern flag (~400 jobs,
//      covers "Internship", "Praktikum", Japanese-titled internships, etc.).
//   2. keyword sweep `intern OR interns OR apprentice OR trainee OR co-op` restricted to
//      `is_intern[]=0`, to catch the handful of intern/apprentice titles that are not flagged
//      (e.g. "ASIC Engineer Intern, Annapurna Labs", "Tax intern", "Mechatronic Apprentice").
// result_limit is capped at 100 by the server; responses are ~140 KB gzipped per page.

const BASE = 'https://www.amazon.jobs/en/search.json';
const PAGE = 100;
const MAX_PAGES = 12; // safety cap per query (1200 results)

const QUERIES = [
  { 'is_intern[]': '1' },
  { base_query: 'intern OR interns OR apprentice OR trainee OR co-op', 'is_intern[]': '0' },
];

const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

function isoDate(s) {
  // "September 28, 2026" -> "2026-09-28"
  const m = String(s || '').trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (!m || !MONTHS[m[1].toLowerCase()]) return null;
  return `${m[3]}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

function locationsOf(job) {
  const out = [];
  for (const raw of job.locations || []) {
    try {
      const l = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const parts = [l.normalizedCityName || l.city, l.normalizedStateName, l.normalizedCountryName || l.normalizedCountryCode]
        .filter(Boolean);
      const s = parts.length ? parts.join(', ') : l.normalizedLocation || l.location;
      if (s && !out.includes(s)) out.push(s);
    } catch { /* ignore malformed entry */ }
  }
  if (!out.length && job.normalized_location) out.push(job.normalized_location);
  return out;
}

function sid(id) { return `amzn:${id}`; }

export default {
  id: 'amzn',
  label: 'Amazon Jobs',
  kind: 'company',
  interval: 300,
  instances: [{ key: 'amzn', company: 'Amazon' }],

  canon(url) {
    let u;
    try { u = new URL(url); } catch { return null; }
    if (!/(^|\.)amazon\.jobs$/i.test(u.hostname)) return null;
    // /en/jobs/123/slug, /jobs/123/apply, /en-gb/jobs/123, account.amazon.jobs/jobs/123/apply
    const m = u.pathname.match(/\/jobs?\/(\d{5,})(?:[/?#]|$)/i);
    return m ? sid(m[1]) : null;
  },

  async poll(instance, ctx) {
    const seen = new Map();
    let complete = true;

    for (const q of QUERIES) {
      let hits = null;
      let fetched = 0;
      for (let page = 0; page < MAX_PAGES; page++) {
        const params = new URLSearchParams({ ...q, result_limit: String(PAGE), sort: 'recent', offset: String(page * PAGE) });
        const data = await ctx.http.json(`${BASE}?${params}`);
        if (data.error) throw new Error(`amazon.jobs search error: ${JSON.stringify(data.error).slice(0, 200)}`);
        const jobs = Array.isArray(data.jobs) ? data.jobs : [];
        hits = Number(data.hits) || 0;
        fetched += jobs.length;
        for (const j of jobs) {
          const id = j.id_icims;
          if (!id || !j.title || seen.has(id)) continue;
          if (!ctx.isInternTitle(j.title)) continue;
          seen.set(id, {
            sid: sid(id),
            title: String(j.title).trim(),
            url: `https://www.amazon.jobs${j.job_path || `/en/jobs/${id}`}`,
            company: 'Amazon',
            locations: locationsOf(j),
            postedAt: isoDate(j.posted_date),
            comp: null,
          });
        }
        if (jobs.length < PAGE || fetched >= hits) break;
      }
      if (hits == null || fetched < hits) complete = false;
    }

    return { complete, items: [...seen.values()] };
  },
};
