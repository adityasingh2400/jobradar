// Jane Street — www.janestreet.com/join-jane-street/...
//
// Jane Street's site renders its job list from /jobs/main.json, which is fed by the public
// Greenhouse board "janestreet". The board JSON is ~8x lighter than main.json (18 KB vs 147 KB
// gzipped) and additionally carries first_published + full location names, so we read the board
// and fall back to main.json if it fails.
//
// Titles on both feeds do NOT say "Intern" ("Software Engineer", availability "Summer
// Internship"), so a plain Greenhouse poller would miss every Jane Street internship. We use the
// "Employment Type" metadata and append "Intern"/"Co-op" to the title. Some titles are also
// deliberately obfuscated with Lisu look-alike letters ("ꓟachine ꓡearning"), which we map back.
//
// Job ids are Greenhouse ids; every URL form carries them:
//   /join-jane-street/position/<id>/        /join-jane-street/apply/<id>?gh_jid=<id>
//   boards.greenhouse.io/janestreet/jobs/<id>   job-boards.greenhouse.io/janestreet/jobs/<id>

const BOARD = 'janestreet';
const GH_URL = `https://boards-api.greenhouse.io/v1/boards/${BOARD}/jobs`;
const MAIN_URL = 'https://www.janestreet.com/jobs/main.json';

// Lisu capital letters used as Latin look-alikes (Unicode confusables).
const LISU = {
  'ꓐ': 'B', 'ꓑ': 'P', 'ꓓ': 'D', 'ꓔ': 'T', 'ꓖ': 'G', 'ꓗ': 'K', 'ꓙ': 'J', 'ꓚ': 'C', 'ꓜ': 'Z', 'ꓝ': 'F',
  'ꓟ': 'M', 'ꓠ': 'N', 'ꓡ': 'L', 'ꓢ': 'S', 'ꓣ': 'R', 'ꓦ': 'H', 'ꓧ': 'X', 'ꓪ': 'W', 'ꓫ': 'X', 'ꓬ': 'Y',
  'ꓮ': 'A', 'ꓰ': 'E', 'ꓲ': 'I', 'ꓳ': 'O', 'ꓴ': 'U', 'ꓸ': '.', 'ꓹ': ',',
};
const deobfuscate = (s = '') =>
  String(s).replace(/[\uA4D0-\uA4FF]/g, (c) => LISU[c] ?? c).normalize('NFKC').replace(/\s+/g, ' ').trim();

const CITY = {
  NYC: 'New York, NY, United States', LDN: 'London, United Kingdom', HKG: 'Hong Kong',
  SGP: 'Singapore', ATX: 'Austin, TX, United States', CHI: 'Chicago, IL, United States',
  AMS: 'Amsterdam, Netherlands',
};

const jobUrl = (id) => `https://www.janestreet.com/join-jane-street/position/${id}/`;

/** "Summer Internship" / "Winter Co-Op" -> title suffix, or null when not an internship. */
function internSuffix(availability = '') {
  const a = String(availability);
  if (/co-?op/i.test(a)) {
    const season = a.match(/\b(summer|fall|autumn|winter|spring)\b/i);
    return season ? `Co-op (${season[1][0].toUpperCase()}${season[1].slice(1).toLowerCase()})` : 'Co-op';
  }
  if (/intern/i.test(a)) {
    const season = a.match(/\b(fall|autumn|winter|spring)\b/i); // "Summer" is the default
    return season ? `Intern (${season[1][0].toUpperCase()}${season[1].slice(1).toLowerCase()})` : 'Intern';
  }
  return null;
}

function makeTitle(raw, availability, isInternTitle) {
  const t = deobfuscate(raw);
  if (isInternTitle(t)) return t;
  const suffix = internSuffix(availability);
  return suffix ? `${t} ${suffix}` : null;
}

function comp(min, max) {
  if (!min) return null;
  const lo = `$${String(min).trim()}`;
  const hi = max && String(max).trim() !== String(min).trim() ? `–$${String(max).trim()}` : '';
  return `${lo}${hi}/yr (annualized)`;
}

async function fromGreenhouse(ctx) {
  const data = await ctx.http.json(GH_URL, { timeout: 20_000 });
  if (!Array.isArray(data?.jobs)) throw new Error('janestreet: unexpected Greenhouse payload');
  const out = [];
  for (const j of data.jobs) {
    const meta = Object.fromEntries((j.metadata || []).map((m) => [m.name, m.value]));
    const availability = meta['Employment Type'] || '';
    const title = makeTitle(j.title, availability, ctx.isInternTitle);
    if (!title || !ctx.isInternTitle(title)) continue;
    out.push({
      sid: `js:${j.id}`,
      title,
      url: jobUrl(j.id),
      locations: j.location?.name ? j.location.name.split(/\s*;\s*/).filter(Boolean) : [],
      postedAt: j.first_published ? new Date(j.first_published).toISOString() : null,
      comp: comp(meta['Min salary'], meta['Max salary']),
    });
  }
  return out;
}

async function fromMainJson(ctx) {
  const data = await ctx.http.json(MAIN_URL, { timeout: 25_000 });
  if (!Array.isArray(data)) throw new Error('janestreet: unexpected main.json payload');
  const out = [];
  for (const j of data) {
    const title = makeTitle(j.position, j.availability, ctx.isInternTitle);
    if (!title || !ctx.isInternTitle(title)) continue;
    out.push({
      sid: `js:${j.id}`,
      title,
      url: jobUrl(j.id),
      locations: j.city ? [CITY[j.city] || j.city] : [],
      postedAt: null,
      comp: comp(j.min_salary, j.max_salary),
    });
  }
  return out;
}

export default {
  id: 'js',
  label: 'Jane Street Careers',
  kind: 'company',
  interval: 300,
  instances: [{ key: 'js', company: 'Jane Street' }],

  canon(url) {
    let u;
    try { u = new URL(url); } catch { return null; }
    const host = u.hostname.toLowerCase();
    if (host === 'janestreet.com' || host.endsWith('.janestreet.com')) {
      const gh = u.searchParams.get('gh_jid');
      if (gh && /^\d+$/.test(gh)) return `js:${gh}`;
      const m = u.pathname.match(/\/join-jane-street\/(?:position|apply)\/(\d{5,})(?:\/|$)/i);
      return m ? `js:${m[1]}` : null;
    }
    if (/^(boards|job-boards)(\.eu)?\.greenhouse\.io$/.test(host)) {
      const m = u.pathname.match(/^\/janestreet\/jobs\/(\d+)/i);
      if (m) return `js:${m[1]}`;
      if (/\/embed\/job_app/.test(u.pathname) && u.searchParams.get('for') === BOARD) {
        const t = u.searchParams.get('token');
        if (t && /^\d+$/.test(t)) return `js:${t}`;
      }
    }
    return null;
  },

  async poll(instance, ctx) {
    let items;
    try {
      items = await fromGreenhouse(ctx);
    } catch (e) {
      ctx.log('janestreet: Greenhouse board failed, falling back to main.json:', e.message);
      items = await fromMainJson(ctx);
    }
    const seen = new Set();
    items = items.filter((it) => !seen.has(it.sid) && seen.add(it.sid));
    return { complete: true, items };
  },
};
