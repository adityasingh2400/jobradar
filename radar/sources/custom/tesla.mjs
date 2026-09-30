// Tesla careers (www.tesla.com/careers/search/job/<id>).
//
// The careers SPA loads ONE JSON document with every open listing:
//   GET https://www.tesla.com/cua-api/apps/careers/state
//   -> { lookup: { regions, sites, locations, departments, types }, departments, geo, listings: [
//        { id, t: title, dp: department, f: function, l: locationId, y: typeId, sp, pu } ] }
//   lookup.types = { 1: fulltime, 2: parttime, 3: intern, 4: seasonal }
// (schema verified against www.tesla.cn, which serves the same app for China only.)
//
// CAVEAT: www.tesla.com sits behind Akamai Bot Manager, which answers plain HTTP clients
// (Node fetch / curl, any headers) with 403 "Access Denied" on every path, even robots.txt.
// When that happens poll() throws so the core keeps last-known data and records the error.

const STATE_URL = 'https://www.tesla.com/cua-api/apps/careers/state';
const JOB_URL = (id) => `https://www.tesla.com/careers/search/job/${id}`;

export default {
  // www.tesla.com is behind an Akamai bot wall for every non-browser client. Tesla is covered by the
  // aggregators plus the Tesla LinkedIn company feed instead; canon() still merges tesla.com links.
  disabled: true,
  id: 'tesla',
  label: 'Tesla Careers',
  kind: 'company',
  interval: 600,
  instances: [{ key: 'tesla', company: 'Tesla' }],

  canon(url) {
    let u;
    try { u = new URL(url); } catch { return null; }
    if (!/^(www\.)?tesla\.com$/i.test(u.hostname)) return null;
    // /careers/search/job/284776 , /en_CA/careers/search/job/284776 ,
    // /careers/search/job/software-engineer-intern-284776 , legacy /careers/job/<slug>-<id>
    const m = u.pathname.match(/\/careers\/(?:search\/)?job\/(?:[^/]*?-)?(\d+)\/?$/i);
    return m ? `tesla:${m[1]}` : null;
  },

  async poll(instance, ctx) {
    let data;
    try {
      data = await ctx.http.json(STATE_URL, {
        timeout: 45_000,
        retries: 1,
        headers: { referer: 'https://www.tesla.com/careers/search/', accept: 'application/json' },
      });
    } catch (e) {
      if (e.status === 403 || e.status === 'badjson') {
        throw new Error(`tesla: blocked by Akamai bot wall (${e.status}) at ${STATE_URL}`);
      }
      throw e;
    }
    if (!data || !Array.isArray(data.listings)) throw new Error('tesla: unexpected careers state payload');

    const lookup = data.lookup || {};
    const locName = lookup.locations || {};
    const siteName = lookup.sites || {};
    // locationId -> site (country) name, from geo: [{ id: region, sites: [{ id: 'US', cities: { city: [locIds] } }] }]
    const locSite = new Map();
    for (const region of data.geo || []) {
      for (const site of region.sites || []) {
        for (const ids of Object.values(site.cities || {})) {
          for (const id of ids || []) locSite.set(String(id), siteName[site.id] || site.id);
        }
      }
    }

    const seen = new Set();
    const items = [];
    for (const l of data.listings) {
      const id = String(l.id ?? '').trim();
      const title = String(l.t ?? '').trim();
      if (!/^\d+$/.test(id) || !title || seen.has(id)) continue;
      if (!ctx.isInternTitle(title)) continue;
      seen.add(id);
      const place = String(locName[l.l] || '').trim();
      const country = locSite.get(String(l.l)) || '';
      const loc = place && country && !place.includes(country) ? `${place}, ${country}` : place || country;
      items.push({
        sid: `tesla:${id}`,
        title,
        url: JOB_URL(id),
        company: instance.company,
        locations: loc ? [loc] : [],
        postedAt: null,
        comp: null,
      });
    }
    // The state document is the full listing set, so the intern subset is complete.
    return { complete: true, items };
  },
};
