// Jobvite career sites (jobs.jobvite.com/<company>).
//
// Job URLs:  https://jobs.jobvite.com/<company>/job/<eId>[/apply][?nl=1&fr=false...]
//            https://jobs.jobvite.com/careers/<company>/job/<eId>        (older form)
//            https://app.jobvite.com/CompanyJobs/Careers.aspx?c=<cid>&j=<eId>   (legacy; canon only)
// eIds (e.g. "oMAPAfwv") are case-sensitive and global, so sid = jobvite:<eId>.
//
// No public JSON; the server-rendered pages are simple:
//   GET /<company>/jobs            -> every open job grouped by category, BUT a big category is cut
//                                     off with a "Show More" link (/search?c=<category>&p=0).
//   GET /<company>/search?q=<kw>&p=<n>  -> 50 per page, "1-50 of N" footer; full-text (title +
//                                     description), "intern" also matches "Internship".
// Poll: /jobs first. If nothing is truncated that is the complete list (1 request). Otherwise also
// run keyword searches for the intern vocabulary (intern / co-op / apprentice / trainee, usually one
// page each) and union them with the /jobs rows -> ~5 requests for big boards.

const HOSTS_RE = /^(jobs|careers)\.jobvite\.com$/i;
const EID_RE = /^[A-Za-z0-9]{6,12}$/;
const SEARCH_TERMS = ['intern', 'co-op', 'apprentice', 'trainee'];
const MAX_PAGES_PER_TERM = 3;

function parse(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (host === 'app.jobvite.com' || host === 'hire.jobvite.com') {
    const j = u.searchParams.get('j') || u.searchParams.get('cj');
    return { company: null, eid: j && EID_RE.test(j) ? j : null };
  }
  if (!HOSTS_RE.test(host)) return null;
  const segs = u.pathname.split('/').filter(Boolean);
  if (segs[0] === 'careers') segs.shift();
  if (!segs.length) return null;
  const company = decodeURIComponent(segs[0]).toLowerCase();
  if (!/^[a-z0-9._-]+$/.test(company)) return null;
  const eid = segs[1] === 'job' && segs[2] && EID_RE.test(segs[2]) ? segs[2] : null;
  return { company, eid };
}

function decode(s) {
  return String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Parse the jv-job-list tables of a /jobs or /search page. */
function parseRows(html) {
  const rows = [];
  const re = /<td class="jv-job-list-name">\s*<a href="\/[^"/]+\/job\/([A-Za-z0-9]+)[^"]*">([\s\S]*?)<\/a>\s*<\/td>\s*<td class="jv-job-list-location">([\s\S]*?)<\/td>/g;
  let m;
  while ((m = re.exec(html))) {
    const loc = decode(m[3]).replace(/\s*,\s*/g, ', ');
    rows.push({ eid: m[1], title: decode(m[2]), locations: loc ? [loc] : [] });
  }
  return rows;
}

export default {
  id: 'jobvite',
  label: 'Jobvite',
  kind: 'platform',
  interval: 1200,

  instanceFromUrl(url, company) {
    const p = parse(url);
    if (!p?.company) return null;
    return { key: `jobvite:${p.company}`, company: company || p.company, slug: p.company };
  },

  seedInstances: [],

  canon(url) {
    const p = parse(url);
    return p?.eid ? `jobvite:${p.eid}` : null;
  },

  async poll(instance, ctx) {
    const slug = instance.slug || String(instance.key).replace(/^jobvite:/, '');
    const base = `https://jobs.jobvite.com/${encodeURIComponent(slug)}`;
    const found = new Map(); // eid -> row
    const add = (rows) => {
      for (const r of rows) if (!found.has(r.eid)) found.set(r.eid, r);
    };

    let complete = true;
    const res = await ctx.http.request(`${base}/jobs`, { as: 'text' });
    const html = String(res.data || '');
    // unknown/retired companies redirect to www.jobvite.com/support/job-seeker-support/?invalid=1
    if (!/^https:\/\/jobs\.jobvite\.com\//i.test(res.url || base) || !/jv-page-jobs|jv-job-list/.test(html)) {
      throw new Error(`jobvite: no career site for "${slug}" (landed on ${res.url})`);
    }
    add(parseRows(html));
    const truncated = /\/search\?c=[^"]*&(amp;)?p=0/.test(html) || />\s*<strong>\s*Show More\s*<\/strong>/i.test(html);

    if (truncated) {
      let ok = 0;
      for (const term of SEARCH_TERMS) {
        try {
          for (let p = 0; p < MAX_PAGES_PER_TERM; p++) {
            const html = await ctx.http.text(`${base}/search?q=${encodeURIComponent(term)}&p=${p}`);
            add(parseRows(html));
            const m = html.match(/jv-pagination-text">\s*(\d+)\s*-\s*(\d+)\s+of\s+(\d+)/);
            if (!m || Number(m[2]) >= Number(m[3])) break;
            if (p === MAX_PAGES_PER_TERM - 1) complete = false;
          }
          ok++;
        } catch (e) {
          complete = false;
          ctx.log?.(`jobvite ${slug}: search "${term}" failed: ${e.message}`);
        }
      }
      if (!ok) ctx.log?.(`jobvite ${slug}: all searches failed; returning /jobs rows only`);
    }

    const items = [];
    for (const r of found.values()) {
      if (!r.title || !ctx.isInternTitle(r.title)) continue;
      items.push({
        sid: `jobvite:${r.eid}`,
        title: r.title,
        url: `${base}/job/${r.eid}`,
        locations: r.locations,
        postedAt: null,
        comp: null,
      });
    }
    return { complete, items };
  },
};
