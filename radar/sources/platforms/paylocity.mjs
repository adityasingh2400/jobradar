// Paylocity Recruiting job boards (recruiting.paylocity.com).
//
// Job URLs:  https://recruiting.paylocity.com/Recruiting/Jobs/Details/<jobId>[/<slug>]
//            https://recruiting.paylocity.com/Recruiting/Jobs/Apply/<jobId>
// Board:     https://recruiting.paylocity.com/Recruiting/Jobs/All/<companyGuid>[/<slug>]
// jobIds are global integers -> sid = paylocity:<jobId>.
//
// The board page embeds `window.pageData = {ModuleTitle, Jobs:[{JobId, JobTitle, LocationName,
// PublishedDate, IsInternal, IsRemote, JobLocation:{City,State,Country}}]}` = every open job, 1 request.
//
// Problem: a job URL does not contain the company guid, and instanceFromUrl() must be offline.
// So an instance is keyed by the aggregator's company name ('paylocity:<company-slug>', falling back
// to 'paylocity:job:<jobId>' when no name is given) and carries the job id as a "seed". poll()
// resolves seeds -> guid by fetching the job's detail page once (it links "Jobs/All/<guid>") and
// caches the result in module-level Maps. Every URL seen via instanceFromUrl() is also recorded as a
// seed for its key, so if the first seed job closes (closed jobs redirect to /Jobs/JobNotFound and no
// longer reveal the guid) another live one is used. A job id that already appears in a known board's
// list is resolved for free. One company can have several boards ("modules", e.g. ABEC has a separate
// internships board) - all resolved guids of a key are polled.
// Resolved guids are also written back onto the instance object (instance.guids) so an engine that
// persists instances survives restarts; seedInstances below carry pre-resolved guids.

const DETAILS_RE = /^\/recruiting\/jobs\/(?:details|apply)\/(\d+)(?:[/?#]|$)/i;
const ALL_RE = /^\/recruiting\/jobs\/all\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const GUID_IN_PAGE_RE = /Jobs\/All\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const ORIGIN = 'https://recruiting.paylocity.com';
const RESOLVE_PER_POLL = 2;

const seedsByKey = new Map(); // key -> Set(jobId)
const guidsByKey = new Map(); // key -> Set(guid)
const guidByJob = new Map(); // jobId -> guid | false (closed / not resolvable)
const boardCache = new Map(); // guid -> { at, promise }  (dedupe when several keys share a board)
const BOARD_TTL_MS = 120_000;

function parse(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/^recruiting\.paylocity\.com$/i.test(u.hostname)) return null;
  let m = u.pathname.match(DETAILS_RE);
  if (m) return { jobId: m[1], guid: null };
  m = u.pathname.match(ALL_RE);
  if (m) return { jobId: null, guid: m[1].toLowerCase() };
  return null;
}

const slugify = (s) => String(s || '')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function addTo(map, key, vals) {
  let s = map.get(key);
  if (!s) map.set(key, (s = new Set()));
  for (const v of vals) if (v) s.add(String(v));
  return s;
}

/** Extract the JSON object literal that starts at html[i] (brace matching, string-aware). */
function extractObject(html, i) {
  let depth = 0;
  let inStr = false;
  for (let j = i; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (c === '\\') j++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return html.slice(i, j + 1);
  }
  return null;
}

async function fetchBoard(guid, ctx) {
  const hit = boardCache.get(guid);
  if (hit && Date.now() - hit.at < BOARD_TTL_MS) return hit.promise;
  const promise = (async () => {
    const res = await ctx.http.request(`${ORIGIN}/Recruiting/Jobs/All/${guid}`, { as: 'text' });
    const html = String(res.data || '');
    const k = html.indexOf('window.pageData');
    const start = k < 0 ? -1 : html.indexOf('{', k);
    const raw = start < 0 ? null : extractObject(html, start);
    if (!raw) throw new Error(`paylocity: no pageData on board ${guid} (landed on ${res.url})`);
    const data = JSON.parse(raw);
    if (!Array.isArray(data.Jobs)) throw new Error(`paylocity: pageData.Jobs missing on board ${guid}`);
    return data;
  })();
  boardCache.set(guid, { at: Date.now(), promise });
  promise.catch(() => boardCache.delete(guid));
  if (boardCache.size > 5000) boardCache.clear();
  return promise;
}

async function resolveSeed(jobId, ctx) {
  const res = await ctx.http.request(`${ORIGIN}/Recruiting/Jobs/Details/${jobId}`, { as: 'text' });
  const m = String(res.data || '').match(GUID_IN_PAGE_RE);
  const guid = m ? m[1].toLowerCase() : false; // JobNotFound page -> false
  guidByJob.set(String(jobId), guid);
  return guid;
}

function toIso(s) {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Pre-resolved boards for companies seen on aggregators (guid verified 2026-09-28). Keys match what
// instanceFromUrl() produces for the aggregator's company name, so they merge with discovered ones.
const SEEDS = [
  ['North Atlantic Industries', '03d28297-d3eb-4490-a5a8-e525e673a55a'],
  ['Fervo Energy', '12776fae-4a6e-4875-99e9-78e5a8621042'],
  ['ABEC', '5fa9e5d7-bb1d-4f88-ba0b-4eecc1af560a'],
  ['Western National Insurance', 'c719c45a-5165-498d-828c-fa725512b89a'],
  ['SoundOff Signal', '34ebcf7f-cf28-4e77-b9d9-0ef9631c4ce0'],
  ['Demco Products', '74673d96-b1c6-4cc2-a80b-6a7cb2651486'],
  ['Delta Dental of Iowa', 'aac2a503-7f38-4705-a190-4c9cc43a0794'],
];

export default {
  id: 'paylocity',
  label: 'Paylocity Recruiting',
  kind: 'platform',
  interval: 1500,

  instanceFromUrl(url, company) {
    const p = parse(url);
    if (!p) return null;
    const cs = slugify(company);
    let key;
    if (cs) key = `paylocity:${cs}`;
    else if (p.guid) key = `paylocity:${p.guid}`;
    else key = `paylocity:job:${p.jobId}`;
    // offline bookkeeping only: remember every seed seen for this key
    if (p.jobId) addTo(seedsByKey, key, [p.jobId]);
    if (p.guid) addTo(guidsByKey, key, [p.guid]);
    const inst = { key, company: company || null };
    if (p.jobId) inst.jobId = p.jobId;
    if (p.guid) inst.guids = [p.guid];
    return inst;
  },

  seedInstances: SEEDS.map(([company, guid]) => ({ key: `paylocity:${slugify(company)}`, company, guids: [guid] })),

  canon(url) {
    const p = parse(url);
    return p?.jobId ? `paylocity:${p.jobId}` : null;
  },

  async poll(instance, ctx) {
    const key = instance.key;
    const guids = addTo(guidsByKey, key, [
      ...(instance.guids || []), instance.guid,
      ...(String(key).match(/^paylocity:([0-9a-f-]{36})$/) ? [key.slice(10)] : []),
    ].map((g) => g && String(g).toLowerCase()));
    const seeds = addTo(seedsByKey, key, [instance.jobId, ...(instance.jobIds || [])]);
    for (const s of seeds) {
      const g = guidByJob.get(s);
      if (g) guids.add(g);
    }

    let complete = true;
    const boards = new Map(); // guid -> pageData
    const loadBoards = async () => {
      const todo = [...guids].filter((g) => !boards.has(g));
      const res = await ctx.http.mapLimit(todo, 2, (g) => fetchBoard(g, ctx));
      res.forEach((r, i) => {
        if (r.ok) {
          boards.set(todo[i], r.value);
          for (const j of r.value.Jobs) guidByJob.set(String(j.JobId), todo[i]);
        } else {
          complete = false;
          boards.set(todo[i], null);
          ctx.log?.(`paylocity ${key}: board ${todo[i]} failed: ${r.error?.message}`);
        }
      });
    };

    await loadBoards();

    // Resolve seeds that no known board accounts for (newest ids first; closed ones become false).
    // After each new guid its board is loaded at once, which usually accounts for the other seeds.
    const pendingSeeds = () => [...seeds].filter((s) => !guidByJob.has(s)).sort((a, b) => Number(b) - Number(a));
    const failed = new Set();
    for (let n = 0; n < RESOLVE_PER_POLL; n++) {
      const s = pendingSeeds().find((x) => !failed.has(x));
      if (!s) break;
      try {
        const g = await resolveSeed(s, ctx);
        if (g && !guids.has(g)) { guids.add(g); await loadBoards(); }
      } catch (e) {
        failed.add(s);
        ctx.log?.(`paylocity ${key}: resolving job ${s} failed: ${e.message}`);
      }
    }
    if (pendingSeeds().length) complete = false; // another board may exist; later polls continue

    if (!guids.size) {
      throw new Error(`paylocity: cannot resolve a company board for ${key} (seed jobs ${[...seeds].join(',') || 'none'} closed)`);
    }
    if (![...boards.values()].some(Boolean)) throw new Error(`paylocity: all boards failed for ${key}`);
    instance.guids = [...guids]; // persisted if the engine stores instance objects

    const items = [];
    const seen = new Set();
    for (const data of boards.values()) {
      if (!data) continue;
      for (const j of data.Jobs) {
        const title = String(j.JobTitle || '').replace(/\s+/g, ' ').trim();
        const id = String(j.JobId || '');
        if (!id || seen.has(id) || j.IsInternal || !ctx.isInternTitle(title)) continue;
        seen.add(id);
        const L = j.JobLocation || {};
        const loc = [L.City, L.State, L.City || L.State ? L.Country : null].filter(Boolean).join(', ') || j.LocationName || '';
        const locations = loc ? [loc] : [];
        if (j.IsRemote && !/remote/i.test(loc)) locations.push('Remote');
        const item = {
          sid: `paylocity:${id}`,
          title,
          url: `${ORIGIN}/Recruiting/Jobs/Details/${id}`,
          locations,
          postedAt: toIso(j.PublishedDate),
          comp: null,
        };
        if (!instance.company && data.ModuleTitle) item.company = data.ModuleTitle;
        items.push(item);
      }
    }
    return { complete, items };
  },
};
