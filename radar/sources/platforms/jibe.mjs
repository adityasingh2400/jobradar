// Jibe (iCIMS Jibe / Google Cloud Talent Solution) career sites on custom domains.
//
// Job pages: https://careers.amd.com/jobs/92633?icims=1, https://careers.amd.com/careers-home/jobs/92633?lang=en-us,
//            https://careers.sig.com/intern-co-op-technology/jobs/10838?lang=en-us, https://<client>.jibeapply.com/jobs/<id>
// Search:    GET <origin>/api/jobs?keywords=intern&page=<1..>&limit=100&sortBy=posted_date   (JSON, newest first)
//            -> { totalCount, jobs: [{ data: { slug, req_id, title, posted_date, full_location, apply_url, ats_code, ... } }] }
// No auth. Keyword search is Google CTS (semantic, so it also returns some non-intern roles); titles are
// filtered with ctx.isInternTitle.
//
// Relationship with icims.mjs: every Jibe site verified here fronts iCIMS, and slug == req_id == the iCIMS job id
// (apply_url is https://<portal>.icims.com/jobs/<id>/login). But the Jibe URL does not reveal the iCIMS portal
// offline, and sids must carry the adapter's own prefix, so jibe emits 'jibe:<host>:<id>' and icims emits
// 'icims:<portal>:<id>' — the same job reached through both is NOT merged by sid (only by the core's fuzzy key).
// Each item does carry `aliases: ['icims:<portal>:<id>']` (built from apply_url), exactly the sid icims.mjs
// emits for that job, in case the core wants to merge on it.

// Hosts verified (2026-09) to serve the Jibe /api/jobs JSON. Other hosts are recognized by URL shape.
const KNOWN_HOSTS = new Set([
  'careers.aarp.org', 'careers.akima.com', 'careers.amd.com', 'careers.andersen.com', 'careers.aptean.com',
  'careers.arcfield.com', 'careers.astrion.us', 'careers.avispl.com', 'careers.bigbear.ai', 'careers.bowman.com',
  'careers.cdmsmith.com', 'careers.chenega.com', 'careers.chick-fil-a.com', 'careers.clydeinc.com', 'careers.cobank.com',
  'careers.comed.com', 'careers.ctg.com', 'careers.cvent.com', 'careers.div.energy', 'careers.eagleview.com',
  'careers.fastenterprises.com', 'careers.footlocker.com', 'careers.foundationfinance.com', 'careers.garmin.com',
  'careers.gov2x.com', 'careers.govcio.com', 'careers.heb.com', 'careers.herzog.com', 'careers.highlighttech.com',
  'careers.ice.com', 'careers.jhuapl.edu', 'careers.kindermorgan.com', 'careers.kpmg.ca', 'careers.leviton.com',
  'careers.lutron.com', 'careers.mastec.com', 'careers.mcdean.com', 'careers.medpace.com', 'careers.msasafety.com',
  'careers.na.panasonic.com', 'careers.navistar.com', 'careers.noblis.org', 'careers.pdf.com', 'careers.pennymac.com',
  'careers.planview.com', 'careers.pmgroup-global.com', 'careers.pnnl.gov', 'careers.pplweb.com', 'careers.principal.com',
  'careers.publicisgroupe.com', 'careers.reliance.com', 'careers.rivian.com', 'careers.sabresystems.com', 'careers.sam.biz',
  'careers.sca.health', 'careers.shearers.com', 'careers.sig.com', 'careers.siriusxm.com', 'careers.spiritaero.com',
  'careers.tracesystems.com', 'careers.trccompanies.com', 'careers.ulta.com', 'careers.usoncology.com', 'careers.viasat.com',
  'careers.vtgdefense.com', 'explore.enercon.com', 'jobportal.reyesbeveragegroup.com', 'jobs.ajg.com', 'jobs.aon.com',
  'jobs.bjc.org', 'jobs.constellationenergy.com', 'jobs.incommpayments.com', 'jobs.keysight.com', 'jobs.postholdings.com',
  'jobs.statefarm.com', 'jobs.stryten.com', 'jobs.uhsinc.com', 'jobs.zs.com', 'join.atlassian.com', 'joinus.ies-co.com',
  'talent.goldbelt.com', 'cakecareers.com', 'towercareers.org',
]);

const MAX_PAGES = 5;
const NO_SORT = new Set(); // hosts whose /api/jobs rejects sortBy=posted_date
const LIMIT = 100;

const normHost = (h) => String(h || '').toLowerCase().replace(/^www\./, '');

function parse(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const rawHost = u.hostname.toLowerCase();
  const host = normHost(rawHost);
  if (/(^|\.)icims\.com$/.test(host)) return null; // plain iCIMS portals belong to icims.mjs
  const m = u.pathname.match(/^(?:\/[^/]+)*?\/jobs\/([A-Za-z0-9_-]+)\/?(?:apply\/?)?$/);
  const id = m ? m[1] : null;
  const lang = u.searchParams.get('lang') || '';
  const jibe =
    host.endsWith('.jibeapply.com') ||
    KNOWN_HOSTS.has(host) ||
    (id && /^\d+$/.test(id) && u.searchParams.has('icims')) ||
    (id && /^\/careers-home\/jobs\//.test(u.pathname)) ||
    (id && /^\d+$/.test(id) && /^[a-z]{2}-[a-z]{2}$/.test(lang));
  if (!jibe) return null;
  return { host, rawHost, id };
}

const sidOf = (host, id) => `jibe:${host}:${id}`;

function isoDate(s) {
  if (!s) return null;
  const t = Date.parse(String(s).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function locationsOf(d) {
  const fmt = (l) => [l.city, l.state, l.country].filter(Boolean).join(', ');
  const out = [];
  const main = fmt(d);
  if (main) out.push(main);
  for (const l of d.additional_locations || []) { const s = fmt(l); if (s) out.push(s); }
  if (!out.length && d.full_location) out.push(...String(d.full_location).split(/\s*;\s*/).filter(Boolean));
  if (!out.length && d.location_name) out.push(d.location_name);
  return [...new Set(out)];
}

function icimsAlias(applyUrl) {
  const m = String(applyUrl || '').match(/^https?:\/\/([a-z0-9][a-z0-9-]*)\.icims\.com\/jobs\/(\d+)(?:[/?#]|$)/i);
  return m ? [`icims:${m[1].toLowerCase()}:${m[2]}`] : [];
}

export default {
  id: 'jibe',
  label: 'Jibe career site',
  kind: 'platform',
  interval: 900,

  instanceFromUrl(url, company) {
    const p = parse(url);
    if (!p) return null;
    return { key: `jibe:${p.host}`, company, host: p.rawHost };
  },

  seedInstances: [],

  canon(url) {
    const p = parse(url);
    return p && p.id ? sidOf(p.host, p.id) : null;
  },

  async poll(inst, ctx) {
    const origin = `https://${inst.host}`;
    const host = normHost(inst.host);
    // Newest-first where the site's Google CTS config supports it; some sites answer the sorted query
    // with 503 "SortBy 'posted_date' ... is not supported by Google" — remember those and go unsorted.
    let sort = NO_SORT.has(host) ? '' : '&sortBy=posted_date&descending=true';
    const fetchPage = async (page) => {
      const url = (s) => `${origin}/api/jobs?keywords=intern&page=${page}&limit=${LIMIT}${s}`;
      if (!sort) return ctx.http.json(url(''), { timeout: 30_000 });
      try {
        return await ctx.http.json(url(sort), { timeout: 30_000, retries: 0 });
      } catch (e) {
        if (!e?.status || e.status === 404) throw e;
        const d = await ctx.http.json(url(''), { timeout: 30_000 });
        sort = '';
        if (/not supported/i.test(e.body || '')) NO_SORT.add(host);
        return d;
      }
    };

    const first = await fetchPage(1);
    if (!first || !Array.isArray(first.jobs)) throw new Error(`jibe ${inst.host}: /api/jobs did not return a job list`);
    const total = Number(first.totalCount) || 0;
    const bySlug = new Map();
    let fetched = 0; // raw rows; multi-language sites return one row per (job, language) and count them all
    const add = (d) => {
      for (const j of d?.jobs || []) {
        fetched++;
        const x = j?.data;
        const id = x?.slug || x?.req_id;
        if (!id) continue;
        const prev = bySlug.get(String(id));
        if (!prev || (!/^en/i.test(prev.language || '') && /^en/i.test(x.language || ''))) bySlug.set(String(id), x);
      }
    };
    add(first);

    const pages = Math.ceil(total / LIMIT);
    let complete = pages <= MAX_PAGES;
    for (let page = 2; page <= Math.min(pages, MAX_PAGES); page++) {
      try {
        const d = await fetchPage(page);
        if (!d?.jobs?.length) break;
        add(d);
      } catch (e) {
        ctx.log(`jibe ${inst.host}: page ${page} failed: ${e.message}`);
        complete = false;
        break;
      }
    }
    if (complete && fetched < total * 0.98) complete = false;

    const items = [];
    for (const [id, d] of bySlug) {
      const title = String(d.title || '').trim();
      if (!ctx.isInternTitle(title)) continue;
      if (!/^[A-Za-z0-9_-]+$/.test(id)) continue;
      const lang = /^[a-z]{2}-[a-z]{2}$/i.test(d.language || '') ? d.language.toLowerCase() : 'en-us';
      items.push({
        sid: sidOf(host, id),
        title,
        url: `${origin}/jobs/${id}?lang=${lang}`,
        company: inst.company,
        locations: locationsOf(d),
        postedAt: isoDate(d.posted_date || d.create_date),
        comp: null,
        // Same requisition as seen by icims.mjs (apply_url = https://<portal>.icims.com/jobs/<id>/login).
        // Not part of the contract; lets the core merge cross-platform duplicates if it chooses to.
        aliases: icimsAlias(d.apply_url),
      });
    }
    return { complete, items };
  },
};
