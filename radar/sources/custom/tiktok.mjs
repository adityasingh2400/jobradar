// TikTok careers (lifeattiktok.com; careers.tiktok.com redirects there).
//
// The Next.js site calls a public JSON API (no token/cookie needed):
//   POST https://api.lifeattiktok.com/api/v1/public/supplier/search/job/posts
//   headers: website-path: tiktok, origin: https://lifeattiktok.com
//   body: { recruitment_id_list, keyword, limit, offset, ... }
// recruitment_id_list ["202"] is the "Intern" recruit type (campus); it holds every intern
// posting (~1.2k). A second tiny query picks up intern-like titles filed as experienced hires
// (e.g. "Management Trainee"). The list has no publish date; the post id's high 32 bits encode
// the record's creation time, which is not the publish time, so postedAt is left null.

const API = 'https://api.lifeattiktok.com/api/v1/public/supplier/search/job/posts';
const HEADERS = {
  'accept-language': 'en-US',
  'website-path': 'tiktok',
  origin: 'https://lifeattiktok.com',
  referer: 'https://lifeattiktok.com/',
};
const PAGE = 500;      // API accepts large pages; 500 keeps a poll at ~3 requests
const MAX_PAGES = 8;   // safety cap (4000 intern postings)

const idFromUrl = (url) => {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== 'lifeattiktok.com' && host !== 'careers.tiktok.com') return null;
  // /search/<id>, /en/search/<id>, /position/<id>/detail, /m/position/<id>/detail, /resume/<id>/apply
  const m = u.pathname.match(/\/(?:search|position|resume)\/(\d{15,20})(?:[/?#]|$)/);
  return m ? m[1] : null;
};

function location(city) {
  const parts = [];
  for (let c = city; c; c = c.parent) {
    const name = String(c.en_name || c.i18n_name || c.name || '').trim();
    if (name && parts[parts.length - 1] !== name) parts.push(name === 'United States of America' ? 'USA' : name);
  }
  return parts.join(', ');
}

async function search(ctx, body) {
  const res = await ctx.http.json(API, {
    method: 'POST',
    headers: HEADERS,
    body: {
      recruitment_id_list: [], job_category_id_list: [], subject_id_list: [],
      location_code_list: [], tag_id_list: [], keyword: '', ...body,
    },
    timeout: 40_000,
  });
  if (res?.code !== 0 || !res.data) throw new Error(`tiktok search: code=${res?.code} ${res?.message || ''}`);
  return { list: res.data.job_post_list || [], count: Number(res.data.count) || 0 };
}

export default {
  id: 'tiktok',
  label: 'TikTok Careers',
  kind: 'company',
  interval: 300,
  instances: [{ key: 'tiktok', company: 'TikTok' }],

  canon(url) {
    const id = idFromUrl(url);
    return id ? `tiktok:${id}` : null;
  },

  async poll(instance, ctx) {
    const byId = new Map();
    let complete = true;

    // 1) every posting of recruit type "Intern", paginated
    let total = Infinity;
    let fetched = 0;
    for (let page = 0; page < MAX_PAGES && fetched < total; page++) {
      const { list, count } = await search(ctx, { recruitment_id_list: ['202'], limit: PAGE, offset: page * PAGE });
      total = count;
      fetched += list.length;
      for (const j of list) if (j?.id) byId.set(String(j.id), j);
      if (list.length < PAGE) break;
    }
    if (byId.size < total) complete = false; // capped, or the list shifted while paging

    // 2) intern-like titles filed under experienced hiring (e.g. "Management Trainee")
    try {
      const { list } = await search(ctx, { recruitment_id_list: ['1'], keyword: 'trainee', limit: 100, offset: 0 });
      for (const j of list) if (j?.id && !byId.has(String(j.id))) byId.set(String(j.id), j);
    } catch (e) {
      ctx.log('tiktok trainee query failed:', e.message);
      complete = false;
    }

    const items = [];
    for (const [id, j] of byId) {
      const title = String(j.title || '').replace(/\s+/g, ' ').trim();
      if (!title || !ctx.isInternTitle(title)) continue;
      const loc = j.city_info ? location(j.city_info) : '';
      items.push({
        sid: `tiktok:${id}`,
        title,
        url: `https://lifeattiktok.com/search/${id}`,
        company: instance.company,
        locations: loc ? [loc] : [],
        postedAt: null,
        comp: null,
      });
    }
    return { complete, items };
  },
};
