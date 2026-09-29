// iCIMS career portals — one adapter for every <portal>.icims.com.
//
// Job pages: https://<portal>.icims.com/jobs/<id>/<slug>/job  (also /jobs/<id>/job, /jobs/<id>/<slug>/login,
//            ?mobile=false&needsRedirect=false&hub=7 ... tracking params)
// Search:    GET https://<portal>.icims.com/jobs/search?ss=1&searchKeyword=intern&in_iframe=1&pr=<page0>
//              &schemaId=$T{Job}.$T{JobPost}.$F{PostedDateTime}&o=A     (o=A == posted date, newest first)
// `in_iframe=1` returns the bare results HTML (no wrapper iframe). No cookies/tokens needed; pages are
// stateless. Page size is portal-configured (20-50), "Page X of N" gives the page count. The keyword
// search also matches descriptions, so titles are filtered with ctx.isInternTitle.
//
// Note: Jibe career sites (careers.amd.com/jobs/<id>?icims=1 ...) front iCIMS with the SAME job id,
// but are handled by jibe.mjs with 'jibe:' sids (sids must carry the adapter's own prefix).

const PORTAL_RE = /^([a-z0-9][a-z0-9-]*)\.icims\.com$/i;
const NOT_PORTALS = new Set(['www', 'api', 'login', 'cdn', 'developer', 'community', 'care', 'support', 'status', 'blog']);
const MAX_PAGES = 10;
const SORT = '&schemaId=' + encodeURIComponent('$T{Job}.$T{JobPost}.$F{PostedDateTime}') + '&o=A';

function portalOf(u) {
  const m = u.hostname.toLowerCase().match(PORTAL_RE);
  if (!m || NOT_PORTALS.has(m[1])) return null;
  return m[1];
}

function parseUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const portal = portalOf(u);
  if (!portal) return null;
  const m = u.pathname.match(/^\/jobs\/(\d+)(?:\/|$)/);
  return { portal, id: m ? m[1] : null };
}

const sidOf = (portal, id) => `icims:${portal}:${id}`;

// --- tiny HTML helpers (no deps) ---
const decode = (s = '') => String(s)
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/&ndash;/g, '–').replace(/&mdash;/g, '—').replace(/&rsquo;|&lsquo;/g, "'").replace(/&rdquo;|&ldquo;/g, '"')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/\s+/g, ' ')
  .trim();

// iCIMS renders dates in US Eastern time as M/D/YYYY [h:mm AM].
function nyOffsetMinutes(utcGuess) {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'longOffset' })
      .formatToParts(utcGuess).find((p) => p.type === 'timeZoneName')?.value || '';
    const m = part.match(/GMT([+-])(\d{2}):?(\d{2})?/);
    if (!m) return -300;
    return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
  } catch { return -300; }
}

function parseDate(s) {
  const m = String(s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*([AP]M))?/i);
  if (!m) return null;
  let [a, b] = [Number(m[1]), Number(m[2])];
  let mo = a, d = b;
  if (a > 12 && b <= 12) { mo = b; d = a; } // D/M/YYYY portals
  let h = m[4] ? Number(m[4]) % 12 : 0;
  if (m[6] && /pm/i.test(m[6])) h += 12;
  const min = m[5] ? Number(m[5]) : 0;
  const naive = Date.UTC(Number(m[3]), mo - 1, d, h, min);
  if (Number.isNaN(naive)) return null;
  const t = naive - nyOffsetMinutes(new Date(naive)) * 60_000;
  return new Date(t).toISOString();
}

function fieldsOf(card) {
  const out = [];
  // header left/right: <span class="sr-only field-label">Label</span> <span ...>Value</span>
  for (const m of card.matchAll(/<span class="sr-only field-label">([\s\S]*?)<\/span>\s*<span([^>]*)>([\s\S]*?)<\/span>\s*(?:<\/span>)?\s*<\/div>/g)) {
    const title = (m[2].match(/title="([^"]+)"/) || [])[1];
    out.push([decode(m[1]), title ? decode(title) : decode(m[3])]);
  }
  // additional fields: <dt class="iCIMS_JobHeaderField">Label</dt><dd class="iCIMS_JobHeaderData">Value</dd>
  for (const m of card.matchAll(/<dt class="iCIMS_JobHeaderField">([\s\S]*?)<\/dt>\s*<dd class="iCIMS_JobHeaderData">([\s\S]*?)<\/dd>/g)) {
    out.push([decode(m[1]), decode(m[2])]);
  }
  return out;
}

function parseCards(html, portal) {
  const jobs = [];
  const parts = html.split(/<li class="iCIMS_JobCardItem[^"]*"[^>]*>/).slice(1);
  const chunks = parts.length ? parts : html.split(/(?=<a [^>]*href="https?:\/\/[^"]*\.icims\.com\/jobs\/\d+\/)/).slice(1);
  for (const card of chunks) {
    const a = card.match(/<a [^>]*href="(https?:\/\/[^"]*?\/jobs\/(\d+)\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const id = a[2];
    const titleAttr = (a[0].match(/title="([^"]*)"/) || [])[1];
    const h = a[3].match(/<h\d[^>]*>([\s\S]*?)<\/h\d>/);
    let title = h ? decode(h[1]) : decode(a[3]).replace(/^Title\s+/i, '');
    if (!title && titleAttr) title = decode(titleAttr).replace(/^\d+\s+-\s+/, '');
    const slugM = a[1].match(/\/jobs\/\d+\/([^/?#]+)\/job/);
    const fields = fieldsOf(card);
    const locs = [];
    let posted = null;
    const pay = {};
    for (const [label, value] of fields) {
      if (!value) continue;
      if (/\b(posted|posting)\s*date\b|date posted/i.test(label)) { posted ??= parseDate(value); continue; }
      if (/(\blocations?\b|\bcity\b)/i.test(label) && !/type|remote|classification|name/i.test(label)) {
        for (const v of value.split(/\s*\|\s*/)) if (v && !locs.includes(v)) locs.push(v);
        continue;
      }
      if (/salary|pay rate|pay range|compensation|hourly rate/i.test(label)) {
        if (/min/i.test(label)) pay.min = value;
        else if (/max/i.test(label)) pay.max = value;
        else pay.range ??= value;
      }
    }
    const comp = pay.range || (pay.min && pay.max ? (pay.min === pay.max ? pay.min : `${pay.min} - ${pay.max}`) : pay.min || pay.max || null);
    jobs.push({ id, title, slug: slugM ? slugM[1] : null, locations: locs, postedAt: posted, comp });
  }
  return jobs;
}

export default {
  id: 'icims',
  label: 'iCIMS',
  kind: 'platform',
  interval: 900,

  instanceFromUrl(url, company) {
    const p = parseUrl(url);
    if (!p) return null;
    return { key: `icims:${p.portal}`, company, portal: p.portal, host: `${p.portal}.icims.com` };
  },

  seedInstances: [],

  canon(url) {
    const p = parseUrl(url);
    return p && p.id ? sidOf(p.portal, p.id) : null;
  },

  async poll(inst, ctx) {
    const portal = inst.portal || String(inst.host || '').replace(/\.icims\.com$/i, '');
    const base = `https://${portal}.icims.com/jobs/search?ss=1&searchKeyword=intern&in_iframe=1`;
    let sort = SORT;
    const fetchPage = (pr) => ctx.http.text(`${base}&pr=${pr}${sort}`, { timeout: 30_000 });

    let first = await fetchPage(0);
    if (/window\.top\.location\.href\s*=/.test(first) && first.length < 2000) {
      const to = (first.match(/href\s*=\s*'([^']+)'/) || [])[1];
      throw new Error(`iCIMS portal ${portal} redirects off-platform${to ? ' to ' + to.replace(/\\\//g, '/') : ''}`);
    }
    if (!/iCIMS_/.test(first)) throw new Error(`iCIMS portal ${portal}: unexpected search page`);

    const pageCount = (html) => Number((html.match(/Page\s+\d+\s+of\s+(\d+)/i) || [])[1] || 1);
    let pages = pageCount(first);

    // Big portals: make sure page 0 really is newest-first. Portals expose different date columns
    // (JobPost.PostedDateTime vs CreatedDateTime) and only the ones in their sort <select> apply.
    if (pages > MAX_PAGES) {
      const opt = [...first.matchAll(/<option value="(\$T\{Job\}[^"]*(?:PostedDateTime|CreatedDateTime|PostingDate)[^"]*)" orderby="([AD])"\s*>[^<]*<span[^>]*>\s*\(Descending\)/g)][0];
      const want = opt ? '&schemaId=' + encodeURIComponent(opt[1]) + '&o=' + opt[2] : null;
      if (want && want !== sort) {
        sort = want;
        first = await fetchPage(0);
        pages = pageCount(first);
      }
    }

    const byId = new Map();
    const add = (html) => { for (const j of parseCards(html, portal)) if (!byId.has(j.id)) byId.set(j.id, j); };
    add(first);

    let complete = pages <= MAX_PAGES;
    const last = Math.min(pages, MAX_PAGES);
    for (let pr = 1; pr < last; pr++) {
      try {
        const html = await fetchPage(pr);
        const before = byId.size;
        add(html);
        if (byId.size === before) { complete = false; break; } // paging stalled / list shifted
      } catch (e) {
        ctx.log(`icims ${portal}: page ${pr} failed: ${e.message}`);
        complete = false;
        break;
      }
    }

    const items = [];
    for (const j of byId.values()) {
      if (!j.title || !ctx.isInternTitle(j.title)) continue;
      items.push({
        sid: sidOf(portal, j.id),
        title: j.title,
        url: `https://${portal}.icims.com/jobs/${j.id}${j.slug ? '/' + j.slug : ''}/job`,
        company: inst.company,
        locations: j.locations,
        postedAt: j.postedAt,
        comp: j.comp,
      });
    }
    return { complete, items };
  },
};
