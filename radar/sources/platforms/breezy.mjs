// Breezy HR career portals (<company>.breezy.hr).
//
// Job URLs:  https://<co>.breezy.hr/p/<positionId>[-<title-slug>][/apply][?...]
//   e.g.     https://vetsez.breezy.hr/p/a4010fdb3a7001-full-stack-developer-intern-remote-opportunity
//            https://navaide.breezy.hr/p/3fe610df21d6/apply
// positionId is a 12-14 char hex id, globally unique -> sid = breezy:<positionId>.
//
// List:   GET https://<co>.breezy.hr/json  -> [{ id, friendly_id, name, url, published_date,
//         type:{id,name}, location:{name,city,state,country,is_remote}, locations:[...], salary,
//         company:{name} }] — every published position in one response.
// Unknown portals answer 404 (-> throw).

const HOST_RE = /^([a-z0-9][a-z0-9-]*)\.breezy\.hr$/i;
const RESERVED = new Set(['www', 'app', 'api', 'help', 'status', 'marketplace', 'developer']);

function parse(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const m = u.hostname.match(HOST_RE);
  if (!m || RESERVED.has(m[1].toLowerCase())) return null;
  const co = m[1].toLowerCase();
  const pm = u.pathname.match(/^\/p\/([0-9a-f]{8,20})(?=[-/?#]|$)/i);
  return { co, pid: pm ? pm[1].toLowerCase() : null };
}

function locName(l) {
  if (!l) return '';
  const base = l.name || [l.city, l.state?.name || l.state?.id, l.country?.name].filter(Boolean).join(', ');
  return base || '';
}

export default {
  id: 'breezy',
  label: 'Breezy HR',
  kind: 'platform',
  interval: 1500,

  instanceFromUrl(url, company) {
    const p = parse(url);
    if (!p) return null;
    return { key: `breezy:${p.co}`, company: company || p.co, co: p.co };
  },

  seedInstances: [],

  canon(url) {
    const p = parse(url);
    return p?.pid ? `breezy:${p.pid}` : null;
  },

  async poll(instance, ctx) {
    const co = instance.co || String(instance.key).replace(/^breezy:/, '');
    const data = await ctx.http.json(`https://${co}.breezy.hr/json`);
    if (!Array.isArray(data)) throw new Error(`breezy: unexpected /json payload for ${co}`);

    const seen = new Set();
    const items = [];
    for (const j of data) {
      const title = String(j?.name || '').replace(/\s+/g, ' ').trim();
      const pid = String(j?.id || '').toLowerCase();
      if (!pid || seen.has(pid) || !title || !ctx.isInternTitle(title)) continue;
      seen.add(pid);
      const locs = (Array.isArray(j.locations) && j.locations.length ? j.locations : [j.location])
        .map((l) => {
          const n = locName(l);
          return l?.is_remote && n && !/remote/i.test(n) ? `${n} (Remote)` : n;
        })
        .filter(Boolean);
      const d = j.published_date ? new Date(j.published_date) : null;
      const url = j.url && parse(j.url)?.pid === pid ? j.url : `https://${co}.breezy.hr/p/${j.friendly_id || pid}`;
      items.push({
        sid: `breezy:${pid}`,
        title,
        url,
        locations: [...new Set(locs)],
        postedAt: d && !Number.isNaN(d.getTime()) ? d.toISOString() : null,
        comp: j.salary ? String(j.salary).trim() || null : null,
      });
    }
    return { complete: true, items };
  },
};
