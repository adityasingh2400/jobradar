// Pinpoint ATS career sites (<company>.pinpointhq.com).
//
// Job URLs:  https://<co>.pinpointhq.com/[<locale>/]postings/<uuid>[?ats=pinpointhq]
//   e.g.     https://impulsespace.pinpointhq.com/en/postings/d4fdab1d-254b-44a4-96bf-875ebd5b8cd7
// Posting uuids are global -> sid = pinpoint:<uuid>.
//
// List:   GET https://<co>.pinpointhq.com/postings.json -> { data:[{ id, title, url, path,
//         employment_type, compensation, compensation_visible, location:{city,name,province},
//         workplace_type, deadline_at, job:{department} }] } — every live posting, one request.
//         No posting date is exposed. The endpoint returned exactly 200 postings for the largest
//         board tested (impulsespace; the HTML careers page shows the same 200), so a response of
//         >= 200 rows is treated as possibly capped -> complete:false.

const HOST_RE = /^([a-z0-9][a-z0-9-]*)\.pinpointhq\.com$/i;
const RESERVED = new Set(['www', 'app', 'api', 'help', 'status', 'developers', 'support']);
const UUID_RE = /\/postings\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=[/?#]|$)/i;
const POSSIBLE_CAP = 200;

function parse(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const m = u.hostname.match(HOST_RE);
  if (!m || RESERVED.has(m[1].toLowerCase())) return null;
  const pm = u.pathname.match(UUID_RE);
  return { co: m[1].toLowerCase(), uuid: pm ? pm[1].toLowerCase() : null };
}

export default {
  id: 'pinpoint',
  label: 'Pinpoint',
  kind: 'platform',
  interval: 1500,

  instanceFromUrl(url, company) {
    const p = parse(url);
    if (!p) return null;
    return { key: `pinpoint:${p.co}`, company: company || p.co, co: p.co };
  },

  seedInstances: [],

  canon(url) {
    const p = parse(url);
    return p?.uuid ? `pinpoint:${p.uuid}` : null;
  },

  async poll(instance, ctx) {
    const co = instance.co || String(instance.key).replace(/^pinpoint:/, '');
    const origin = `https://${co}.pinpointhq.com`;
    const d = await ctx.http.json(`${origin}/postings.json`, { timeout: 40_000 });
    const rows = Array.isArray(d?.data) ? d.data : null;
    if (!rows) throw new Error(`pinpoint: unexpected postings.json payload for ${co}`);

    const seen = new Set();
    const items = [];
    for (const j of rows) {
      const title = String(j?.title || '').replace(/\s+/g, ' ').trim();
      const uuid = (String(j?.url || j?.path || '').match(UUID_RE) || [])[1]?.toLowerCase();
      if (!uuid || seen.has(uuid) || !title || !ctx.isInternTitle(title)) continue;
      seen.add(uuid);
      const L = j.location || {};
      const loc = [L.city || (L.name || '').trim(), L.province].filter(Boolean).join(', ') || (L.name || '').trim();
      const locations = loc ? [loc] : [];
      if (/remote/i.test(j.workplace_type || '') && !/remote/i.test(loc)) locations.push(loc ? `Remote (${loc})` : 'Remote');
      items.push({
        sid: `pinpoint:${uuid}`,
        title,
        url: `${origin}/en/postings/${uuid}`,
        locations,
        postedAt: null,
        comp: j.compensation_visible !== false && j.compensation ? String(j.compensation) : null,
      });
    }
    return { complete: rows.length < POSSIBLE_CAP, items };
  },
};
