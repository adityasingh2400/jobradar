// ByteDance global careers (joinbytedance.com; jobs.bytedance.com/en/... redirects there).
//
// The Next.js site calls a public JSON API (no token/cookie needed), a sibling of TikTok's:
//   POST https://jobs.bytedance.com/api/v1/public/supplier/search/job/posts
//   headers: website-path: en, origin: https://joinbytedance.com
//   body: { recruitment_id_list, keyword, limit, offset, ... }
// recruitment_id_list ["202"] is the "Intern" recruit type (campus); it holds every intern
// posting (~300). A second tiny query picks up intern-like titles filed as experienced hires
// (e.g. "Management Trainee"). The "jp" website-path is a Japan-only subset of "en".
// jobs.bytedance.com/campus|experienced/... are the separate mainland-China portals (not polled,
// not claimed). The list has no publish date, so postedAt is null.

const API = 'https://jobs.bytedance.com/api/v1/public/supplier/search/job/posts';
const HEADERS = {
  'accept-language': 'en-US',
  'website-path': 'en',
  origin: 'https://joinbytedance.com',
  referer: 'https://joinbytedance.com/',
};
const PAGE = 500;
const MAX_PAGES = 6;

const idFromUrl = (url) => {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  let m;
  if (host === 'joinbytedance.com') {
    // /search/<id>, /jp/search/<id>, /position/<id>/detail, /resume/<id>/apply
    m = u.pathname.match(/\/(?:search|position|resume)\/(\d{15,20})(?:[/?#]|$)/);
  } else if (host === 'jobs.bytedance.com') {
    // /en/position/<id>/detail (global site). /campus/... and /experienced/... are the China portals.
    m = u.pathname.match(/^\/(?:(?!campus\/|experienced\/)[a-z]{2}(?:[-_][a-z]{2})?\/)?(?:position|resume)\/(\d{15,20})(?:[/?#]|$)/i);
  }
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
  if (res?.code !== 0 || !res.data) throw new Error(`bytedance search: code=${res?.code} ${res?.message || ''}`);
  return { list: res.data.job_post_list || [], count: Number(res.data.count) || 0 };
}

export default {
  id: 'bytedance',
  label: 'ByteDance Careers',
  kind: 'company',
  interval: 300,
  instances: [{ key: 'bytedance', company: 'ByteDance' }],

  canon(url) {
    const id = idFromUrl(url);
    return id ? `bytedance:${id}` : null;
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
    if (byId.size < total) complete = false;

    // 2) intern-like titles filed under experienced hiring (e.g. "Management Trainee")
    try {
      const { list } = await search(ctx, { recruitment_id_list: ['1'], keyword: 'trainee', limit: 100, offset: 0 });
      for (const j of list) if (j?.id && !byId.has(String(j.id))) byId.set(String(j.id), j);
    } catch (e) {
      ctx.log('bytedance trainee query failed:', e.message);
      complete = false;
    }

    const items = [];
    for (const [id, j] of byId) {
      const title = String(j.title || '').replace(/\s+/g, ' ').trim();
      if (!title || !ctx.isInternTitle(title)) continue;
      const loc = j.city_info ? location(j.city_info) : '';
      items.push({
        sid: `bytedance:${id}`,
        aliases: [`tiktok:${id}`],
        title,
        url: `https://joinbytedance.com/search/${id}`,
        company: instance.company,
        locations: loc ? [loc] : [],
        postedAt: null,
        comp: null,
      });
    }
    return { complete, items };
  },
};
