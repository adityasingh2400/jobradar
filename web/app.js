// Internship Radar — web app. Reads the radar's data branch straight from GitHub and keeps
// your application tracker in this browser, optionally synced to a private GitHub repo.

const CFG = {
  owner: 'adityasingh2400',
  repo: 'jobradar',
  branch: 'data',
  trackerRepo: 'jobradar-tracker',
  trackerPath: 'tracker.json',
};
const LOCAL = new URLSearchParams(location.search).has('local'); // dev: read ./data/*.json

// ---------- small utils ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '#');
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
};
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dayMs = (ymd) => (ymd ? new Date(`${ymd}T12:00:00`).getTime() : null);
const daysSince = (ymd) => (ymd ? Math.floor((Date.now() - dayMs(ymd)) / DAY) : null);
function ago(ms) {
  if (ms == null) return '—';
  const d = Date.now() - ms;
  if (d < MIN) return 'now';
  if (d < HOUR) return `${Math.floor(d / MIN)}m`;
  if (d < DAY) return `${Math.floor(d / HOUR)}h`;
  if (d < 60 * DAY) return `${Math.floor(d / DAY)}d`;
  return `${Math.floor(d / (30 * DAY))}mo`;
}
const agoText = (ms) => (ms == null ? '—' : ago(ms) === 'now' ? 'just now' : `${ago(ms)} ago`);
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
const fmtDur = (ms) => (ms < HOUR ? `${Math.max(1, Math.round(ms / MIN))}m` : ms < 2 * DAY ? `${Math.round(ms / HOUR)}h` : `${Math.round(ms / DAY)}d`);
const fmtLeft = (ms) => { const m = Math.floor(ms / MIN); return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`; };
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
function normCompany(name = '') {
  return String(name).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/\(.*?\)/g, ' ')
    .replace(/\b(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|plc|gmbh|s\.?a|ag|holdings|group|the)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, '').trim();
}

// ---------- constants ----------
const CATS = [['swe', 'SWE'], ['ai', 'AI/ML'], ['data', 'Data'], ['quant', 'Quant'], ['hw', 'Hardware'], ['pm', 'Product'], ['other', 'Other']];
const REGIONS = [['us', 'US'], ['remote', 'Remote'], ['ca', 'Canada'], ['intl', 'Intl'], ['unknown', '?']];
const SEASONS = [['summer', 'Summer 2027'], ['off', 'Off-season'], ['unknown', 'Unspecified']];
const AGES = [['all', 'Any age'], ['8h', '8-hour window'], ['1h', '1 hour'], ['24h', '24 hours'], ['3d', '3 days'], ['7d', '7 days'], ['30d', '30 days']];
const APPLY_WINDOW = 8 * HOUR; // the slogan: apply in the first 8 hours
const AGE_MS = { '8h': APPLY_WINDOW, '1h': HOUR, '6h': 6 * HOUR, '24h': DAY, '3d': 3 * DAY, '7d': 7 * DAY, '30d': 30 * DAY };
const STATUSES = [
  ['To Apply', '#ECEFF1', '#37474F', '#2b3237', '#c9d3d9'],
  ['Applied', '#D6E4F7', '#1A3E6E', '#1b2a3e', '#9ec5f4'],
  ['OA / Take-Home', '#E3DAF5', '#4527A0', '#2a2340', '#c2b4f0'],
  ['Recruiter Screen', '#D3ECF2', '#01579B', '#15303a', '#8fd0e6'],
  ['Technical Interview', '#FDEBC8', '#8A5A00', '#342710', '#f5c451'],
  ['Final / Onsite', '#FBDCC4', '#A14300', '#3a2415', '#f2a36b'],
  ['Offer', '#CDEBD6', '#16642F', '#15291a', '#7fdc98'],
  ['Accepted', '#A8DAB5', '#0B4A20', '#12311b', '#9be6ae'],
  ['Rejected', '#F8D7D5', '#A32B22', '#321a1a', '#f08a8a'],
  ['Ghosted', '#E8EAED', '#80868B', '#262728', '#a0a4a8'],
  ['Withdrawn', '#E8EAED', '#80868B', '#262728', '#a0a4a8'],
];
const STATUS_NAMES = STATUSES.map((s) => s[0]);
const CLOSED_STATUSES = new Set(['Rejected', 'Ghosted', 'Withdrawn']);
const ALIVE = new Set(['Applied', 'OA / Take-Home', 'Recruiter Screen', 'Technical Interview', 'Final / Onsite', 'Offer']);
const HEARD = new Set(['OA / Take-Home', 'Recruiter Screen', 'Technical Interview', 'Final / Onsite', 'Offer', 'Accepted', 'Rejected']);
const INTERVIEWED = new Set(['Recruiter Screen', 'Technical Interview', 'Final / Onsite', 'Offer', 'Accepted']);
const TYPES = ['Internship', 'Co-op', 'New Grad', 'Part-time', 'Contract', 'Full-time'];
const MODES = ['Onsite', 'Hybrid', 'Remote'];
const SOURCES = ['Company Site', 'Referral', 'Recruiter Reached Out', 'LinkedIn', 'Handshake', 'Job Board', 'Career Fair', 'Cold Email', 'Other'];
const PRIORITIES = ['Dream', 'High', 'Medium', 'Low'];
const DEFAULT_FILTERS = {
  seasons: ['summer', 'off', 'unknown'], cats: ['swe', 'ai'], regions: ['us', 'remote', 'unknown'],
  tier: 'all', age: 'all', hideGrad: true, hideDone: true, openOnly: true, sort: 'new',
};

function isDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
}
function statusStyle(name) {
  const s = STATUSES.find((x) => x[0] === name) || STATUSES[0];
  return isDark() ? `background:${s[3]};color:${s[4]}` : `background:${s[1]};color:${s[2]}`;
}

// ---------- state ----------
const S = {
  jobs: [], byId: new Map(), health: null, pay: {}, alias: {}, labels: {},
  sha: null, refEtag: null, loadedAt: 0, loading: true, error: null,
  tab: LS.get('radar.tab', 'radar'),
  filters: { ...DEFAULT_FILTERS, ...LS.get('radar.filters', {}) },
  seenAt: LS.get('radar.seenAt', 0),
  tracker: loadTracker(),
  token: LS.get('radar.token', ''),
  sync: { state: 'off', at: 0, msg: '' },
  q: '',
  shown: 150,
  sel: -1,
  visible: [],
  notify: LS.get('radar.notify', false),
  pendingApply: null,
  maxFs: 0,
};
if (!S.seenAt) { S.seenAt = Date.now(); LS.set('radar.seenAt', S.seenAt); }

function loadTracker() {
  const t = LS.get('radar.tracker.v1', null);
  return t && t.items ? { v: 1, items: t.items, dismissed: t.dismissed || {}, opened: t.opened || {} } : { v: 1, items: {}, dismissed: {}, opened: {} };
}
const saveTrackerLocal = () => LS.set('radar.tracker.v1', S.tracker);
function trackerChanged() {
  saveTrackerLocal();
  scheduleSync();
  renderCounts();
}

// ---------- data loading ----------
const RAW = `https://raw.githubusercontent.com/${CFG.owner}/${CFG.repo}`;
const API = 'https://api.github.com';

async function headSha() {
  const headers = { Accept: 'application/vnd.github+json' };
  if (S.token) headers.Authorization = `Bearer ${S.token}`;
  if (S.refEtag) headers['If-None-Match'] = S.refEtag;
  const r = await fetch(`${API}/repos/${CFG.owner}/${CFG.repo}/git/ref/heads/${CFG.branch}`, { headers, cache: 'no-store' });
  if (r.status === 304) return S.sha;
  if (r.status === 401 && S.token) { toast('GitHub rejected your sync token; data still loads without it.'); S.token = ''; return headSha(); }
  if (!r.ok) throw Object.assign(new Error(`GitHub API ${r.status}`), { status: r.status });
  S.refEtag = r.headers.get('etag');
  return (await r.json()).object.sha;
}

async function fetchJson(path, sha) {
  const url = LOCAL ? `./data/${path}?t=${Date.now()}` : sha ? `${RAW}/${sha}/${path}` : `${RAW}/refs/heads/${CFG.branch}/${path}`;
  const r = await fetch(url, { cache: sha ? 'force-cache' : 'no-store' });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

async function refresh(force = false) {
  try {
    let sha = null;
    if (!LOCAL) {
      try { sha = await headSha(); } catch (e) {
        // Rate-limited or offline API: fall back to the branch URL (CDN-cached ≤5 min).
        if (S.sha && !force) { S.error = null; return; }
        sha = null;
      }
      if (sha && sha === S.sha && !force) { S.loadedAt = Date.now(); renderStatus(); return; }
    }
    const [jobs, health] = await Promise.all([fetchJson('jobs.json', sha), fetchJson('health.json', sha)]);
    if (!Object.keys(S.pay).length) fetchJson('pay.json', sha).then((p) => { S.pay = p || {}; if (S.tab === 'radar') renderList(); }).catch(() => {});
    ingest(jobs, health);
    S.sha = sha;
    S.error = null;
  } catch (e) {
    S.error = e.message;
  } finally {
    S.loading = false;
    S.loadedAt = Date.now();
    renderStatus();
    renderView();
  }
}

function ingest(jobs, health) {
  const prevMax = S.maxFs;
  const prevIds = S.byId;
  S.jobs = jobs;
  S.byId = new Map(jobs.map((j) => [j.id, j]));
  S.health = health;
  S.alias = health.alias || {};
  S.labels = Object.fromEntries((health.sources || []).map((s) => [s.id, s.label]));
  S.maxFs = Math.max(0, ...jobs.map((j) => j.fs || 0));
  for (const j of jobs) {
    j._t = freshTime(j);
    j._cats = j.k || [];
    j._rg = j.rg ? j.rg.split(',') : [];
    j._grad = j.dg === 'phd' || j.dg === 'ms' || j.dg === 'mba';
    j._search = `${j.c} ${j.t} ${(j.l || []).join(' ')} ${j.s || ''}`.toLowerCase();
    const srcs = Object.entries(j.src || {}).sort((a, b) => a[1].fs - b[1].fs);
    j._srcs = srcs;
  }
  // New arrivals while the page is open: flash + optional desktop notification.
  if (prevMax && prevIds.size) {
    const fresh = jobs.filter((j) => !prevIds.has(j.id) && !j.b && j.fs > prevMax - MIN && matches(j));
    if (fresh.length) {
      S.flash = new Set(fresh.map((j) => j.id));
      notifyNew(fresh);
    }
  }
}

const dateOnly = (t) => t != null && t % DAY === 0; // sources that only publish a posting date
function freshTime(j) {
  // Seen live by the radar: first-seen is the real appearance time, unless the posting is clearly older.
  if (!j.b) return j.pa && j.fs - j.pa > (dateOnly(j.pa) ? 36 * HOUR : 2 * HOUR) ? j.pa : j.fs;
  return j.pa ?? null;
}
/** Time left in the 8-hour apply window, or 0 once it has passed / age is unknown. */
function windowLeft(j) {
  if (j._t == null || j.st !== 'open' || (j.b && dateOnly(j.pa))) return 0;
  const left = APPLY_WINDOW - (Date.now() - j._t);
  return left > 0 ? left : 0;
}
function ageLabel(j) {
  if (j._t == null) return '—';
  if (j.b && dateOnly(j.pa)) {
    const d = Math.floor((Date.now() - j.pa) / DAY);
    return d <= 0 ? 'today' : `${d}d`;
  }
  return ago(j._t);
}

// ---------- filtering ----------
function seasonBucket(s) {
  if (!s) return 'unknown';
  if (/^Summer( 2027)?$/.test(s) || s === '2027') return 'summer';
  if (/^(Fall|Winter|Spring)/.test(s)) return 'off';
  if (/^Summer 20(2[8-9]|3)/.test(s)) return 'off';
  return 'unknown';
}
const trackItem = (id) => S.tracker.items[id] && !S.tracker.items[id].del ? S.tracker.items[id] : null;
function trackedFor(j) {
  return trackItem(j.id) || Object.values(S.tracker.items).find((it) => !it.del && it.jobId && (S.alias[it.jobId] === j.id)) || null;
}

function matches(j, f = S.filters) {
  if (f.openOnly && j.st !== 'open') return false;
  if (!f.seasons.includes(seasonBucket(j.s))) return false;
  if (!j._cats.some((c) => f.cats.includes(c))) return false;
  if (j._rg.length ? !j._rg.some((r) => f.regions.includes(r)) : !f.regions.includes('unknown')) return false;
  if (f.tier === 'S' && j.tr !== 'S') return false;
  if (f.tier === 'SA' && !j.tr) return false;
  if (f.hideGrad && j._grad) return false;
  if (f.age !== 'all' && (j._t == null || Date.now() - j._t > AGE_MS[f.age])) return false;
  if (f.hideDone) {
    if (S.tracker.dismissed[j.id]) return false;
    const it = trackItem(j.id);
    if (it && it.status !== 'To Apply') return false;
  }
  return true;
}

function queryMatch(j) {
  if (!S.q) return true;
  return S.q.split(/\s+/).every((w) => j._search.includes(w));
}

function visibleJobs() {
  const out = S.jobs.filter((j) => matches(j) && queryMatch(j));
  const f = S.filters;
  if (f.sort === 'tier') out.sort((a, b) => (tierRank(a) - tierRank(b)) || ((b._t || 0) - (a._t || 0)));
  else if (f.sort === 'company') out.sort((a, b) => a.c.localeCompare(b.c) || ((b._t || 0) - (a._t || 0)));
  else out.sort((a, b) => ((b._t || 0) - (a._t || 0)) || (b.fs - a.fs));
  return out;
}
const tierRank = (j) => (j.tr === 'S' ? 0 : j.tr === 'A' ? 1 : 2);
const isNew = (j) => !j.b && j.fs > S.seenAt && !S.tracker.opened[j.id] && !trackItem(j.id);

// ---------- rendering: shell ----------
function setTab(tab) {
  S.tab = tab;
  LS.set('radar.tab', tab);
  for (const b of $$('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const v of $$('.view')) v.hidden = v.id !== `view-${tab}`;
  renderView();
  window.scrollTo({ top: 0 });
}

function renderView() {
  renderCounts();
  if (S.tab === 'radar') { renderFilters(); renderList(); }
  else if (S.tab === 'pipeline') renderBoard();
  else if (S.tab === 'dash') renderDash();
  else if (S.tab === 'settings') renderSettings();
}

function renderCounts() {
  const newN = S.jobs.filter((j) => isNew(j) && matches(j)).length;
  $('#count-radar').textContent = newN ? `${newN} new` : '';
  const active = Object.values(S.tracker.items).filter((i) => !i.del && !CLOSED_STATUSES.has(i.status)).length;
  $('#count-pipeline').textContent = active || '';
  document.title = newN ? `(${newN}) Internship Radar` : 'Internship Radar';
}

function renderStatus() {
  const el = $('#status');
  const h = S.health;
  el.className = 'status';
  if (S.error && !h) { el.classList.add('bad'); el.querySelector('span').textContent = 'Offline'; el.title = S.error; return; }
  if (!h) { el.querySelector('span').textContent = 'Loading…'; return; }
  const age = Date.now() - h.at;
  const last = Object.entries(h.runners || {}).sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0))[0]?.[0];
  const who = { mac: 'Mac', actions: 'Cloud', local: 'Local' }[last] || 'Radar';
  const cls = age < 4 * MIN ? 'live' : age < 20 * MIN ? 'ok' : age < 60 * MIN ? 'warn' : 'bad';
  el.classList.add(cls);
  el.querySelector('span').textContent = `${cls === 'live' ? 'Live' : cls === 'bad' ? 'Stale' : 'Updated'} · ${who} · ${agoText(h.at)}`;
  el.title = `Last radar publish ${fmtDate(h.at)} by the ${who} runner. ${h.open?.toLocaleString()} open internships tracked.${S.error ? `\nLast refresh error: ${S.error}` : ''}`;
}

// ---------- rendering: radar ----------
function chip(label, pressed, attrs) {
  return `<button class="chip-btn" aria-pressed="${pressed}" ${attrs}>${esc(label)}</button>`;
}
function renderFilters() {
  const f = S.filters;
  const multi = (key, opts) => opts.map(([v, l]) => chip(l, f[key].includes(v), `data-f="${key}" data-v="${v}"`)).join('');
  $('#filters').innerHTML = `
    <div class="fgroup"><label>Season</label>${multi('seasons', SEASONS)}</div>
    <div class="fgroup"><label>Area</label>${multi('cats', CATS)}</div>
    <div class="fgroup"><label>Where</label>${multi('regions', REGIONS)}</div>
    <div class="fgroup"><label>Tier</label>${chip('All', f.tier === 'all', 'data-tier="all"')}${chip('S', f.tier === 'S', 'data-tier="S"')}${chip('S + A', f.tier === 'SA', 'data-tier="SA"')}</div>
    <div class="fgroup"><label>Age</label><select class="fsel" data-sel="age">${AGES.map(([v, l]) => `<option value="${v}" ${f.age === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select class="fsel" data-sel="sort"><option value="new" ${f.sort === 'new' ? 'selected' : ''}>Newest first</option><option value="tier" ${f.sort === 'tier' ? 'selected' : ''}>Tier first</option><option value="company" ${f.sort === 'company' ? 'selected' : ''}>Company A–Z</option></select></div>
    <div class="fgroup">${chip('Hide PhD/MS/MBA', f.hideGrad, 'data-toggle="hideGrad"')}${chip('Hide applied & dismissed', f.hideDone, 'data-toggle="hideDone"')}${chip('Open only', f.openOnly, 'data-toggle="openOnly"')}</div>`;
}

function locSummary(l = []) {
  if (!l.length) return '';
  const short = l.map((x) => x.replace(/,\s*(United States|USA|US)$/i, '').replace(/\s*\(HQ\)/, ''));
  return short.length > 2 ? `${short.slice(0, 2).join(' · ')} +${short.length - 2}` : short.join(' · ');
}
function payFor(j) {
  if (j.cm) return { text: j.cm, title: 'Pay listed on the posting' };
  const p = S.pay[normCompany(j.c)];
  if (p) return { text: `~$${Math.round(p[0])}/hr`, title: `Median intern pay at ${j.c} on Levels.fyi (${p[1]}, ${p[2]} reports)` };
  return null;
}
function leadFor(j) {
  if (j.b || j._srcs.length < 2) return null;
  const [firstId, first] = j._srcs[0];
  if (!['simplify', 'vansh', 'speedy-swe', 'speedy-ai', 'jobright', 'linkedin'].includes(firstId)) {
    const agg = j._srcs.find(([id]) => ['simplify', 'vansh', 'speedy-swe', 'speedy-ai', 'jobright', 'linkedin'].includes(id));
    if (agg && agg[1].fs - first.fs > 10 * MIN) return `⚡ ${fmtDur(agg[1].fs - first.fs)} before ${S.labels[agg[0]] || agg[0]}`;
  }
  return null;
}
const srcLabel = (id) => S.labels[id] || id;

function rowHtml(j, i) {
  const it = trackItem(j.id);
  const fresh = j._t != null && !(j.b && dateOnly(j.pa)) && Date.now() - j._t < HOUR;
  const left = windowLeft(j);
  const nw = isNew(j);
  const pay = payFor(j);
  const lead = leadFor(j);
  const firstSrc = j._srcs[0]?.[0];
  const ageBasis = j._t == null ? 'age unknown' : j.pa && j.pa <= j.fs ? 'posted' : 'seen';
  const title = `First seen ${fmtDate(j.fs)}${j.pa ? ` · posted ${fmtDate(j.pa)}` : ''}${j.b ? ' · already open when the radar started watching' : ''}`;
  const cls = ['row', nw && 'new', j.st !== 'open' && 'closed', i === S.sel && 'sel', S.flash?.has(j.id) && 'flash'].filter(Boolean).join(' ');
  return `<div class="${cls}" data-id="${esc(j.id)}" role="listitem">
    <div class="r-main">
      <div class="r-top">${j.tr ? `<span class="tier ${j.tr}" title="Tier ${j.tr}">${j.tr}</span>` : ''}${nw ? '<span class="newdot" title="New since you last marked seen"></span>' : ''}<span class="co">${esc(j.c)}</span>${j.l?.length ? `<span class="muted">·</span><span class="loc">${esc(locSummary(j.l))}</span>` : ''}</div>
      <a class="r-title ${S.tracker.opened[j.id] ? 'visited' : ''}" href="${esc(safeUrl(j.u))}" target="_blank" rel="noopener noreferrer" data-act="open">${esc(j.t)}</a>
      <div class="r-meta">
        ${it ? `<span class="tag status" style="${statusStyle(it.status)}">${esc(it.status)}</span>` : ''}
        ${left && !(it && it.status !== 'To Apply') ? `<span class="tag window" title="Apply within 8 hours of posting">⏱ ${esc(fmtLeft(left))} left</span>` : ''}
        ${j.st !== 'open' ? '<span class="tag closed">closed</span>' : ''}
        ${j.s ? `<span class="tag">${esc(j.s)}</span>` : ''}
        ${pay ? `<span class="tag pay" title="${esc(pay.title)}">${esc(pay.text)}</span>` : ''}
        ${j._grad ? `<span class="tag grad">${esc(j.dg.toUpperCase())}</span>` : ''}
        ${lead ? `<span class="tag lead" title="Caught directly from the employer before the aggregators listed it">${esc(lead)}</span>` : ''}
        <span class="tag src" title="${esc(j._srcs.map(([id]) => srcLabel(id)).join(', '))}">${esc(srcLabel(firstSrc))}${j._srcs.length > 1 ? ` +${j._srcs.length - 1}` : ''}</span>
      </div>
    </div>
    <div class="r-age" title="${esc(title)}"><b class="${fresh ? 'fresh' : ''}">${ageLabel(j)}</b><small>${ageBasis}</small></div>
    <div class="r-act">
      <button class="ibtn ${it ? 'on' : ''}" data-act="save" title="Save to pipeline (s)" aria-label="Save">★</button>
      <button class="ibtn ${it && it.status !== 'To Apply' ? 'done' : ''}" data-act="applied" title="Mark applied (a)" aria-label="Mark applied">✓</button>
      <button class="ibtn" data-act="dismiss" title="Dismiss (x)" aria-label="Dismiss">✕</button>
    </div>
  </div>`;
}

let io;
function renderList() {
  const list = $('#list');
  if (S.loading && !S.jobs.length) {
    list.innerHTML = Array.from({ length: 8 }, () => '<div class="skel"></div>').join('');
    $('#summary').innerHTML = '<span class="muted">Loading the radar…</span>';
    return;
  }
  const vis = visibleJobs();
  S.visible = vis;
  const newN = vis.filter(isNew).length;
  const hourN = vis.filter((j) => j._t != null && Date.now() - j._t < HOUR).length;
  const windowN = vis.filter((j) => windowLeft(j) && !(trackItem(j.id) && trackItem(j.id).status !== 'To Apply')).length;
  const replyN = Object.values(S.tracker.items).filter((i) => !i.del && i.next === REPLY_TASK && i.nextDate && dayMs(i.nextDate) <= Date.now()).length;
  $('#motto').innerHTML = `<b>Apply first 8 hours</b><span class="dot">·</span><b>Reply same day</b>
    <span class="motto-stats">${windowN ? `<button class="linkbtn" data-act="window">${windowN} in the 8-hour window</button>` : '<span class="muted">nothing in the 8-hour window right now</span>'}${replyN ? ` · <button class="linkbtn warn" data-tab="pipeline">${replyN} to reply to today</button>` : ''}</span>`;
  const dayN = vis.filter((j) => j._t != null && Date.now() - j._t < DAY).length;
  const alerts = (S.health?.alerts || []).filter((a) => a.level === 'warn');
  $('#summary').innerHTML = `
    ${S.error ? `<span class="banner bad">Couldn't refresh: ${esc(S.error)}</span>` : ''}
    ${alerts.length ? `<button class="banner warnb" data-tab="settings" title="${esc(alerts.map((a) => a.text).join('\n'))}">⚠ ${alerts.length} source${alerts.length > 1 ? 's' : ''} degraded — see Settings</button>` : ''}
    <span><b>${vis.length.toLocaleString()}</b> matching of ${S.jobs.filter((j) => j.st === 'open').length.toLocaleString()} open</span>
    ${newN ? `<span class="new-count">● ${newN} new</span><button class="linkbtn" data-act="seen">Mark all seen</button>` : ''}
    <span class="muted">${hourN} in the last hour · ${dayN} today</span>
    <button class="linkbtn ftoggle" data-act="toggle-filters">${$('#filters').classList.contains('open') ? 'Hide filters' : 'Filters'}</button>`;
  if (!vis.length) {
    list.innerHTML = `<div class="empty">${S.jobs.length ? 'No internships match these filters.' : 'No data yet — the radar publishes within a few minutes of its first run.'}</div>`;
    $('#more').innerHTML = '';
    return;
  }
  const shown = vis.slice(0, S.shown);
  let html = '';
  let lastSec = null;
  shown.forEach((j, i) => {
    const sec = S.filters.sort !== 'new' ? null : windowLeft(j) ? 'Apply now — inside the 8-hour window' : isNew(j) ? 'New since last visit' : j._t == null ? 'Already open when the radar started' : Date.now() - j._t < DAY ? 'Last 24 hours' : Date.now() - j._t < 7 * DAY ? 'This week' : 'Earlier';
    if (sec && sec !== lastSec) { html += `<div class="sec">${sec}</div>`; lastSec = sec; }
    html += rowHtml(j, i);
  });
  list.innerHTML = html;
  $('#more').innerHTML = vis.length > S.shown ? `Showing ${S.shown} of ${vis.length.toLocaleString()} · <button class="linkbtn" data-act="more">show more</button>` : '';
  S.flash = null;
  io?.disconnect();
  if (vis.length > S.shown) {
    io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { S.shown += 150; renderList(); } }, { rootMargin: '600px' });
    io.observe($('#more'));
  }
}

// ---------- tracker actions ----------
function itemFromJob(j, status) {
  const now = Date.now();
  return {
    id: j.id, jobId: j.id, company: j.c, title: j.t, type: /co-?op/i.test(j.t) ? 'Co-op' : 'Internship',
    location: (j.l || []).slice(0, 3).join('; '), mode: (j.l || []).some((l) => /remote/i.test(l)) ? 'Remote' : '',
    source: 'Company Site', referral: '', applied: '', status, updated: today(), next: '', nextDate: '',
    priority: j.tr === 'S' ? 'High' : '', comp: payFor(j)?.text || '', link: j.u, resume: '', notes: '',
    created: now, radarSeen: j._t ?? j.fs, u: now,
  };
}
const REPLY_TASK = 'Reply same day';
const RESPONSE_STAGES = new Set(['OA / Take-Home', 'Recruiter Screen', 'Technical Interview', 'Final / Onsite', 'Offer']);
function setStatus(it, status) {
  const prev = it.status;
  it.status = status;
  it.updated = today();
  // They moved: the ball is in your court. Reply the same day.
  if (RESPONSE_STAGES.has(status) && status !== prev && (!it.next || it.next === REPLY_TASK)) {
    it.next = REPLY_TASK;
    it.nextDate = today();
  }
  if (CLOSED_STATUSES.has(status) && it.next === REPLY_TASK) { it.next = ''; it.nextDate = ''; }
  if (status !== 'To Apply' && !it.applied) {
    it.applied = today();
    if (it.radarSeen) it.delayH = Math.max(0, Math.round((Date.now() - it.radarSeen) / HOUR * 10) / 10);
  }
  it.u = Date.now();
  return prev;
}
function saveJob(j, { toggle = true } = {}) {
  const it = trackItem(j.id);
  if (it && toggle) {
    if (it.status === 'To Apply') { it.del = true; it.u = Date.now(); toast(`Removed ${j.c} from your pipeline`); }
    else toast(`${j.c} is already in your pipeline as ${it.status}`);
  } else if (!it) {
    S.tracker.items[j.id] = itemFromJob(j, 'To Apply');
    delete S.tracker.dismissed[j.id];
    toast(`Saved ${j.c} to To Apply`, [['Undo', () => { S.tracker.items[j.id].del = true; S.tracker.items[j.id].u = Date.now(); trackerChanged(); renderView(); }]]);
  }
  trackerChanged();
  renderView();
}
function markApplied(j) {
  let it = trackItem(j.id);
  if (!it) { it = S.tracker.items[j.id] = itemFromJob(j, 'To Apply'); }
  if (it.status !== 'To Apply') { openItem(it.id); return; }
  setStatus(it, 'Applied');
  delete S.tracker.dismissed[j.id];
  trackerChanged();
  toast(`Applied to ${j.c}${it.delayH != null ? ` · ${fmtDur(it.delayH * HOUR)} after it appeared` : ''}`, [['Undo', () => { it.status = 'To Apply'; it.applied = ''; delete it.delayH; it.u = Date.now(); trackerChanged(); renderView(); }], ['Details', () => openItem(it.id)]]);
  renderView();
}
function dismissJob(j) {
  S.tracker.dismissed[j.id] = Date.now();
  trackerChanged();
  toast(`Dismissed ${j.c}`, [['Undo', () => { delete S.tracker.dismissed[j.id]; trackerChanged(); renderView(); }]]);
  renderView();
}
function openJobLink(j) {
  S.tracker.opened[j.id] = Date.now();
  S.pendingApply = { id: j.id, at: Date.now() };
  trackerChanged();
  setTimeout(renderList, 50);
}

// ---------- drawer: job & tracker item ----------
function openDrawer(html) {
  $('#drawer-body').innerHTML = html;
  $('#drawer').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
}
function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
}

function openJob(id) {
  const j = S.byId.get(id) || S.byId.get(S.alias[id]);
  if (!j) return;
  const it = trackItem(j.id);
  const pay = payFor(j);
  const srcRows = j._srcs.map(([sid, se]) => `<li><span>${esc(srcLabel(sid))}</span><span class="muted">${j.b && se.fs <= j.fs ? 'at radar start' : `first seen ${fmtDate(se.fs)}`}${se.o === 1 ? '' : ' · closed'}</span></li>`).join('');
  openDrawer(`
    <div class="d-co">${j.tr ? `<span class="tier ${j.tr}">${j.tr}</span>` : ''}<b>${esc(j.c)}</b></div>
    <h2 class="d-title" id="drawer-title">${esc(j.t)}</h2>
    <div class="r-meta">${j.st !== 'open' ? '<span class="tag closed">closed</span>' : ''}${j.s ? `<span class="tag">${esc(j.s)}</span>` : ''}${j._cats.map((c) => `<span class="tag">${esc(CATS.find((x) => x[0] === c)?.[1] || c)}</span>`).join('')}${pay ? `<span class="tag pay" title="${esc(pay.title)}">${esc(pay.text)}</span>` : ''}${j._grad ? `<span class="tag grad">${esc(j.dg.toUpperCase())}</span>` : ''}${it ? `<span class="tag status" style="${statusStyle(it.status)}">${esc(it.status)}</span>` : ''}</div>
    <div class="d-actions">
      <a class="btn primary" href="${esc(safeUrl(j.u))}" target="_blank" rel="noopener noreferrer" data-act="open" data-id="${esc(j.id)}">Open posting ↗</a>
      ${it ? `<button class="btn" data-act="edit-item" data-id="${esc(it.id)}">Edit in pipeline</button>` : `<button class="btn" data-act="save" data-id="${esc(j.id)}">★ Save</button>`}
      ${!it || it.status === 'To Apply' ? `<button class="btn" data-act="applied" data-id="${esc(j.id)}">✓ Mark applied</button>` : ''}
      <button class="btn" data-act="dismiss" data-id="${esc(j.id)}">Dismiss</button>
    </div>
    <dl class="d-facts">
      <dt>Locations</dt><dd>${esc((j.l || []).join(' · ') || '—')}</dd>
      <dt>Posted</dt><dd>${j.pa ? `${fmtDate(j.pa)} <span class="muted">(${ago(j.pa)} ago)</span>` : '<span class="muted">not published by the source</span>'}</dd>
      <dt>First seen</dt><dd>${j.b ? '<span class="muted">already open when the radar started watching</span>' : `${fmtDate(j.fs)} <span class="muted">(${agoText(j.fs)})</span>`}</dd>
      ${j.st !== 'open' ? `<dt>Closed</dt><dd>${fmtDate(j.ca)}</dd>` : ''}
      ${j.sp ? `<dt>Sponsorship</dt><dd>${esc(j.sp)}</dd>` : ''}
      <dt>Radar id</dt><dd class="mono muted">${esc(j.id)}</dd>
    </dl>
    <div class="d-sec">Seen on</div>
    <ul class="src-list">${srcRows}</ul>
    ${leadFor(j) ? `<p class="muted" style="font-size:13px;margin-top:10px">${esc(leadFor(j))} — caught directly from the employer's careers site.</p>` : ''}`);
}

function itemForm(it) {
  const opt = (list, v) => `<option value=""></option>${list.map((x) => `<option ${x === v ? 'selected' : ''}>${esc(x)}</option>`).join('')}`;
  const j = it.jobId ? (S.byId.get(it.jobId) || S.byId.get(S.alias[it.jobId])) : null;
  return `
    <div class="d-co"><b>${esc(it.company || 'New application')}</b>${j && j.st !== 'open' ? '<span class="tag closed">posting closed</span>' : ''}</div>
    <h2 class="d-title" id="drawer-title">${esc(it.title || 'Add an application')}</h2>
    ${it.delayH != null ? `<p class="muted" style="margin:-4px 0 12px;font-size:13px">Applied ${fmtDur(it.delayH * HOUR)} after the posting appeared.</p>` : ''}
    <form id="item-form" class="grid2" data-id="${esc(it.id)}" autocomplete="off">
      <label class="field"><span>Company</span><input name="company" value="${esc(it.company)}" required></label>
      <label class="field"><span>Role / Title</span><input name="title" value="${esc(it.title)}" required></label>
      <label class="field"><span>Status</span><select name="status">${STATUS_NAMES.map((s) => `<option ${s === it.status ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
      <label class="field"><span>Priority</span><select name="priority">${opt(PRIORITIES, it.priority)}</select></label>
      <label class="field"><span>Date applied</span><input type="date" name="applied" value="${esc(it.applied)}"></label>
      <label class="field"><span>Last update</span><input type="date" name="updated" value="${esc(it.updated)}"></label>
      <label class="field full"><span>Next action</span><input name="next" value="${esc(it.next)}" placeholder="A verb: “Send thank-you to Priya”, “Finish take-home”"></label>
      <label class="field"><span>Next action date</span><input type="date" name="nextDate" value="${esc(it.nextDate)}"></label>
      <label class="field"><span>Type</span><select name="type">${opt(TYPES, it.type)}</select></label>
      <label class="field"><span>Location</span><input name="location" value="${esc(it.location)}"></label>
      <label class="field"><span>Work mode</span><select name="mode">${opt(MODES, it.mode)}</select></label>
      <label class="field"><span>Source</span><select name="source">${opt(SOURCES, it.source)}</select></label>
      <label class="field"><span>Referral / contact</span><input name="referral" value="${esc(it.referral)}"></label>
      <label class="field"><span>Comp / stipend</span><input name="comp" value="${esc(it.comp)}"></label>
      <label class="field"><span>Resume version</span><input name="resume" value="${esc(it.resume)}" placeholder="v3-swe"></label>
      <label class="field full"><span>Job link</span><input name="link" type="url" value="${esc(it.link)}"></label>
      <label class="field full"><span>Notes</span><textarea name="notes" placeholder="Recruiter and interviewer names, questions asked, comp conversations, gut feel…">${esc(it.notes)}</textarea></label>
      <div class="full row-inline" style="justify-content:space-between;margin-top:4px">
        <div class="row-inline"><button class="btn primary" type="submit">Save</button>${it.link ? `<a class="btn" href="${esc(safeUrl(it.link))}" target="_blank" rel="noopener noreferrer">Open posting ↗</a>` : ''}</div>
        ${S.tracker.items[it.id] ? '<button class="btn danger" type="button" data-act="delete-item">Delete</button>' : ''}
      </div>
    </form>`;
}
function openItem(id) {
  const it = S.tracker.items[id];
  if (!it) return;
  openDrawer(itemForm(it));
}
function newItem() {
  const it = { id: `m:${Date.now().toString(36)}`, company: '', title: '', type: 'Internship', location: '', mode: '', source: 'Company Site', referral: '', applied: '', status: 'To Apply', updated: today(), next: '', nextDate: '', priority: '', comp: '', link: '', resume: '', notes: '', created: Date.now() };
  openDrawer(itemForm(it));
}
function saveItemForm(form) {
  const id = form.dataset.id;
  const data = Object.fromEntries(new FormData(form).entries());
  const it = S.tracker.items[id] || { id, created: Date.now() };
  const prevStatus = it.status;
  Object.assign(it, data);
  if (prevStatus && prevStatus !== data.status) {
    it.status = prevStatus;
    setStatus(it, data.status);
    if (data.applied) it.applied = data.applied;
  } else if (!prevStatus && data.status !== 'To Apply' && !data.applied) {
    it.applied = today();
  }
  it.u = Date.now();
  delete it.del;
  S.tracker.items[id] = it;
  trackerChanged();
  closeDrawer();
  toast(`Saved ${it.company}`);
  renderView();
}

// ---------- pipeline board ----------
function followUp(it) {
  if (!ALIVE.has(it.status) || it.status === 'Offer') return false;
  const last = Math.max(dayMs(it.applied) || 0, dayMs(it.updated) || 0);
  return last && Date.now() - last >= 14 * DAY;
}
const dueSoon = (it) => it.nextDate && dayMs(it.nextDate) <= Date.now() + DAY / 2;

function cardHtml(it) {
  const j = it.jobId ? (S.byId.get(it.jobId) || S.byId.get(S.alias[it.jobId])) : null;
  const ds = daysSince(it.applied);
  if (S.q && !`${it.company} ${it.title} ${it.notes} ${it.location}`.toLowerCase().includes(S.q)) return '';
  return `<div class="card" draggable="true" data-item="${esc(it.id)}">
    <div class="c-co">${it.priority ? `<span class="prio ${esc(it.priority)}" title="${esc(it.priority)} priority"></span>` : ''}<b>${esc(it.company)}</b>${j?.tr ? `<span class="tier ${j.tr}">${j.tr}</span>` : ''}</div>
    <div class="c-t">${esc(it.title)}</div>
    <div class="c-m">
      ${followUp(it) ? '<span class="flag follow">Follow up</span>' : ''}
      ${it.next === REPLY_TASK && dueSoon(it) ? '<span class="flag follow">Reply today</span>' : dueSoon(it) ? `<span class="flag due">Due ${esc(it.nextDate.slice(5))}</span>` : ''}
      ${it.applied ? `<span>applied ${ds === 0 ? 'today' : `${ds}d ago`}</span>` : `<span>saved ${agoText(it.created)}</span>`}
      ${j && j.st !== 'open' ? '<span class="tag closed">closed</span>' : ''}
      ${it.next ? `<span title="${esc(it.next)}">→ ${esc(it.next.length > 28 ? `${it.next.slice(0, 28)}…` : it.next)}</span>` : ''}
    </div>
  </div>`;
}

function renderBoard() {
  const items = Object.values(S.tracker.items).filter((i) => !i.del);
  const cols = [
    ['To Apply', ['To Apply']], ['Applied', ['Applied']], ['OA / Take-Home', ['OA / Take-Home']],
    ['Recruiter Screen', ['Recruiter Screen']], ['Technical Interview', ['Technical Interview']],
    ['Final / Onsite', ['Final / Onsite']], ['Offer', ['Offer', 'Accepted']], ['Closed out', ['Rejected', 'Ghosted', 'Withdrawn']],
  ];
  const sortKey = (it) => (it.priority === 'Dream' ? 0 : it.priority === 'High' ? 1 : 2) * 1e13 - (it.u || it.created || 0);
  $('#board').innerHTML = cols.map(([name, sts]) => {
    const inCol = items.filter((i) => sts.includes(i.status)).sort((a, b) => sortKey(a) - sortKey(b));
    const st = STATUSES.find((s) => s[0] === sts[0]);
    return `<div class="col ${name === 'Closed out' ? 'closedcol' : ''}" data-drop="${esc(sts[0])}">
      <div class="col-h"><span class="sw" style="background:${isDark() ? st[4] : st[2]}"></span>${esc(name)}<span class="n">${inCol.length}</span></div>
      <div class="col-b">${inCol.map(cardHtml).join('') || '<div class="muted" style="font-size:12px;padding:4px 2px 8px">—</div>'}</div>
    </div>`;
  }).join('');
  const applied = items.filter((i) => i.applied).length;
  const follow = items.filter(followUp).length;
  const due = items.filter((i) => dueSoon(i) && !CLOSED_STATUSES.has(i.status)).length;
  $('#pipe-sum').innerHTML = `<b>${items.length}</b> tracked · <b>${applied}</b> applied${follow ? ` · <span class="flag follow">${follow} need a follow-up</span>` : ''}${due ? ` · <span class="flag due">${due} due</span>` : ''} <span class="muted hide-touch">· drag cards between columns</span>`;
}

// ---------- dashboard ----------
function median(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }
function pct(n, d) { return d ? `${Math.round((n / d) * 100)}%` : '—'; }
function barsHtml(rows, max) {
  const m = max || Math.max(1, ...rows.map((r) => r[1]));
  return `<div class="bars">${rows.map(([label, v, note]) => `<div class="bar-row" data-tip="${esc(`${label}: ${v}${note ? ` · ${note}` : ''}`)}"><span class="bl">${esc(label)}</span><span class="bt"><span class="bf" style="width:${(v / m) * 100}%;${v ? '' : 'display:none'}"></span></span><span class="bv">${v}${note ? ` <span class="muted">${esc(note)}</span>` : ''}</span></div>`).join('')}</div>`;
}
function renderDash() {
  const items = Object.values(S.tracker.items).filter((i) => !i.del);
  const submitted = items.filter((i) => i.applied);
  const n = (set) => items.filter((i) => set.has(i.status)).length;
  const heard = n(HEARD), iv = n(INTERVIEWED), offers = items.filter((i) => i.status === 'Offer' || i.status === 'Accepted').length;
  const delays = submitted.map((i) => i.delayH).filter((x) => x != null);
  const med = median(delays);
  const last7 = submitted.filter((i) => Date.now() - dayMs(i.applied) < 7 * DAY).length;
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const thisMonth = submitted.filter((i) => dayMs(i.applied) >= monthStart.getTime()).length;
  const tile = (v, l, s = '') => `<div class="tile"><div class="v">${v}</div><div class="l">${l}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;

  // applications per week, last 12 weeks
  const weeks = [];
  const startOfWeek = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x.getTime(); };
  const w0 = startOfWeek(Date.now());
  for (let k = 11; k >= 0; k--) {
    const ws = w0 - k * 7 * DAY;
    weeks.push([ws, submitted.filter((i) => { const t = dayMs(i.applied); return t >= ws && t < ws + 7 * DAY; }).length]);
  }
  const wmax = Math.max(1, ...weeks.map((w) => w[1]));

  const follow = items.filter(followUp).sort((a, b) => (dayMs(a.applied) || 0) - (dayMs(b.applied) || 0));
  const due = items.filter((i) => i.nextDate && !CLOSED_STATUSES.has(i.status) && dayMs(i.nextDate) <= Date.now() + 14 * DAY).sort((a, b) => dayMs(a.nextDate) - dayMs(b.nextDate));
  const bySource = {};
  for (const i of submitted) {
    const s = i.source || 'Other';
    bySource[s] ??= [0, 0];
    bySource[s][0]++;
    if (HEARD.has(i.status)) bySource[s][1]++;
  }
  const pipeRows = STATUS_NAMES.map((s) => [s, items.filter((i) => i.status === s).length]).filter((r) => r[1] || ALIVE.has(r[0]));
  const openMatching = S.jobs.filter((j) => matches(j));
  const newToday = openMatching.filter((j) => !j.b && Date.now() - j.fs < DAY).length;
  const newWeek = openMatching.filter((j) => !j.b && Date.now() - j.fs < 7 * DAY).length;
  const coCount = {};
  for (const j of openMatching) if (!j.b && Date.now() - j.fs < 7 * DAY) coCount[j.c] = (coCount[j.c] || 0) + 1;
  const topCos = Object.entries(coCount).sort((a, b) => b[1] - a[1]).slice(0, 8);

  $('#dash').innerHTML = `
    <div class="tiles" style="margin-bottom:12px">
      ${tile(items.length, 'Roles tracked')}
      ${tile(submitted.length, 'Applications', `${last7} this week · ${thisMonth} this month`)}
      ${tile(n(ALIVE), 'Still alive')}
      ${tile(heard, 'Heard back', pct(heard, submitted.length) + ' response rate')}
      ${tile(iv, 'Interviews', pct(iv, submitted.length) + ' of applications')}
      ${tile(offers, 'Offers', pct(offers, submitted.length) + ' offer rate')}
      ${tile(med == null ? '—' : fmtDur(med * HOUR), 'Median speed to apply', 'from posting appearing to you applying')}
    </div>
    <div class="dash-grid">
      <div class="panel span-8"><h3>Applications per week</h3>
        <div class="cols">${weeks.map(([ws, v]) => `<div class="cb" style="height:${(v / wmax) * 100}%" data-tip="${esc(`Week of ${new Date(ws).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}: ${v} applied`)}"></div>`).join('')}</div>
        <div class="cols-x">${weeks.map(([ws], k) => `<span>${k % 2 ? '' : new Date(ws).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })}</span>`).join('')}</div>
      </div>
      <div class="panel span-4"><h3>Radar pulse <span class="muted" style="font-weight:400">(your filters)</span></h3>
        <div class="tiles">${tile(openMatching.length.toLocaleString(), 'Open matches')}${tile(newToday, 'New today')}${tile(newWeek, 'New this week')}</div>
      </div>
      <div class="panel span-6"><h3>Needs a follow-up <span class="muted" style="font-weight:400">(silent 14+ days)</span></h3>
        ${follow.length ? `<ul class="mini-list">${follow.map((i) => `<li data-item="${esc(i.id)}"><span class="ml-t"><b>${esc(i.company)}</b> · ${esc(i.title)}</span><span class="flag follow">${daysSince(i.applied)}d</span></li>`).join('')}</ul>` : '<p class="muted">Nothing to chase right now.</p>'}
      </div>
      <div class="panel span-6"><h3>Due in the next 2 weeks</h3>
        ${due.length ? `<ul class="mini-list">${due.map((i) => `<li data-item="${esc(i.id)}"><span class="ml-t"><b>${esc(i.company)}</b> · ${esc(i.next || i.title)}</span><span class="${dayMs(i.nextDate) <= Date.now() ? 'flag due' : 'muted'}">${esc(i.nextDate)}</span></li>`).join('')}</ul>` : '<p class="muted">Nothing on the calendar.</p>'}
      </div>
      <div class="panel span-6"><h3>Pipeline</h3>${barsHtml(pipeRows)}</div>
      <div class="panel span-6"><h3>By source <span class="muted" style="font-weight:400">(which channel converts)</span></h3>
        ${Object.keys(bySource).length ? barsHtml(Object.entries(bySource).sort((a, b) => b[1][0] - a[1][0]).map(([s, [a, h]]) => [s, a, `${pct(h, a)} heard back`])) : '<p class="muted">Log a few applications and this shows which channels actually get responses.</p>'}
      </div>
      <div class="panel span-12"><h3>Most new internships this week <span class="muted" style="font-weight:400">(your filters)</span></h3>
        ${topCos.length ? barsHtml(topCos) : '<p class="muted">No new postings this week yet.</p>'}
      </div>
    </div>`;
}

// ---------- settings ----------
function renderSettings() {
  const h = S.health;
  const standby = (h?.runners?.mac?.at || 0) > Date.now() - 6 * MIN && (h?.runners?.actions?.at || 0) < (h?.runners?.mac?.at || 0) - 10 * MIN;
  const runner = (name, r, isCloud = false) => {
    if (!r?.at || (isCloud && standby)) return `<tr><td><span class="pill idle"><i></i>${name}</span></td><td colspan="3" class="muted">${isCloud && standby ? 'standing by while the Mac is live' : 'not run yet'}</td></tr>`;
    const age = Date.now() - r.at;
    const cls = age < 10 * MIN ? 'good' : age < 60 * MIN ? 'warn' : 'idle';
    return `<tr><td><span class="pill ${cls}"><i></i>${name}</span></td><td>${agoText(r.at)}</td><td class="num">${(r.polls ?? 0).toLocaleString()} polls</td><td class="muted">${esc(r.host || '')} ${esc(r.version || '')}</td></tr>`;
  };
  const srcRows = (h?.sources || []).sort((a, b) => (a.group || '').localeCompare(b.group || '') || a.label.localeCompare(b.label)).map((s) => {
    const cls = s.never === s.instances ? 'idle' : s.failing > s.instances / 2 ? 'bad' : s.failing ? 'warn' : 'good';
    return `<tr><td><span class="pill ${cls}"><i></i>${esc(s.label)}</span></td><td class="muted">${esc(s.group === 'aggregator' ? 'aggregator' : s.kind === 'company' ? 'company site' : 'ATS platform')}</td><td class="num">${s.instances.toLocaleString()}</td><td class="num">${s.healthy.toLocaleString()}</td><td class="num">${s.failing ? s.failing.toLocaleString() : ''}</td><td class="num">${s.items.toLocaleString()}</td><td>${s.lastOk ? agoText(s.lastOk) : '—'}</td></tr>`;
  }).join('');
  const syncMsg = !S.token ? 'Not connected — your tracker lives only in this browser.'
    : S.sync.state === 'ok' ? `Synced ${ago(S.sync.at)} ago.` : S.sync.state === 'busy' ? 'Syncing…' : S.sync.state === 'error' ? `Sync error: ${esc(S.sync.msg)}` : 'Connected.';
  const theme = document.documentElement.dataset.theme || 'auto';
  const tokenUrl = `https://github.com/settings/personal-access-tokens/new?name=jobradar-tracker&description=${encodeURIComponent('Sync the Internship Radar tracker')}&target_name=${CFG.owner}&expires_in=366&contents=write`;
  $('#settings').innerHTML = `
    <div class="set-grid">
      <div class="panel span-6"><h3>Sync your tracker across devices</h3>
        <p><span class="pill ${!S.token ? 'idle' : S.sync.state === 'error' ? 'bad' : 'good'}"><i></i>${syncMsg}</span></p>
        ${S.token ? `
          <div class="row-inline"><button class="btn" data-act="sync-now">Sync now</button><button class="btn" data-act="copy-setup">Copy phone setup link</button><button class="btn danger" data-act="disconnect">Disconnect</button></div>
          <p class="muted" style="margin-top:10px;font-size:12px">The phone link contains your sync key. Send it only to yourself (AirDrop / Notes), open it once on the phone, and it's connected.</p>`
    : `<ol>
            <li><a href="${esc(tokenUrl)}" target="_blank" rel="noopener noreferrer">Create a fine-grained GitHub token</a>.</li>
            <li>Repository access: <b>Only select repositories → ${esc(CFG.trackerRepo)}</b>.</li>
            <li>Permissions → Repository → <b>Contents: Read and write</b>. Generate, then paste it here.</li>
          </ol>
          <div class="row-inline"><input class="input" id="token-in" type="password" placeholder="github_pat_…" style="flex:1;min-width:220px"><button class="btn primary" data-act="connect">Connect</button></div>
          <p class="muted" style="margin-top:10px;font-size:12px">The token can only touch the private <b>${esc(CFG.trackerRepo)}</b> repo. It's stored in this browser and sent only to api.github.com. Every save becomes a commit, so your tracker has full history.</p>`}
      </div>
      <div class="panel span-6"><h3>Radar</h3>
        <div class="row-inline" style="margin-bottom:10px">
          <button class="btn" data-act="notify">${S.notify && 'Notification' in window && Notification.permission === 'granted' ? '🔔 Desktop alerts on' : '🔕 Desktop alerts off'}</button>
          <select class="fsel" data-act="theme"><option value="auto" ${theme === 'auto' ? 'selected' : ''}>Theme: auto</option><option value="light" ${theme === 'light' ? 'selected' : ''}>Theme: light</option><option value="dark" ${theme === 'dark' ? 'selected' : ''}>Theme: dark</option></select>
          <button class="btn" data-act="reset-filters">Reset filters</button>
        </div>
        <p>Desktop alerts fire while this tab is open whenever a new posting matches your filters.</p>
        <div class="row-inline"><button class="btn" data-act="export-json">Export tracker (JSON)</button><button class="btn" data-act="export-csv">Export pipeline (CSV)</button><label class="btn">Import JSON<input type="file" accept="application/json" data-act="import" hidden></label></div>
      </div>
      <div class="panel span-12"><h3>Runners</h3>
        <div class="table-wrap"><table class="tbl"><tbody>${runner('Mac (instant, every ~1 min while awake)', h?.runners?.mac)}${runner('GitHub Actions (every ~5 min when the Mac is off)', h?.runners?.actions, true)}</tbody></table></div>
        <p class="muted" style="margin:10px 0 0;font-size:12.5px">${h ? `${h.open?.toLocaleString()} open internships · ${h.total?.toLocaleString()} tracked incl. recently closed · last publish ${fmtDate(h.at)}` : ''}</p>
      </div>
      <div class="panel span-12"><h3>Elite companies <span class="muted" style="font-weight:400">— direct feeds, open internships, and every source that confirms them</span></h3>
        ${(h?.alerts || []).length ? `<ul class="alert-list">${h.alerts.map((a) => `<li class="${esc(a.level)}">${a.level === 'warn' ? '⚠' : 'ℹ'} ${esc(a.text)}</li>`).join('')}</ul>` : ''}
        <div class="table-wrap"><table class="tbl"><thead><tr><th>Company</th><th>Direct feed</th><th class="num">Open interns</th><th>Confirmed by</th><th>Last direct success</th></tr></thead><tbody>${(h?.elite || []).map((e) => {
          const cls = { ok: 'good', degraded: 'warn', down: 'bad', aggregators: 'idle' }[e.state];
          const label = { ok: 'healthy', degraded: 'partly failing', down: 'failing', aggregators: 'aggregators only' }[e.state];
          const last = Math.max(0, ...e.feeds.map((f) => f.ok || 0));
          return `<tr><td><b>${esc(e.name)}</b></td><td><span class="pill ${cls}" title="${esc(e.feeds.map((f) => `${f.label}: ${f.healthy ? 'ok' : f.err || 'stale'}`).join('\n'))}"><i></i>${label}</span> <span class="muted">${esc([...new Set(e.feeds.map((f) => f.label))].join(', '))}</span></td><td class="num">${e.open}</td><td class="muted">${esc(e.sources.map(srcLabel).join(', '))}</td><td>${last ? agoText(last) : '—'}</td></tr>`;
        }).join('') || '<tr><td colspan="5" class="muted">Loading…</td></tr>'}</tbody></table></div>
      </div>
      <div class="panel span-12"><h3>Sources</h3>
        <div class="table-wrap"><table class="tbl"><thead><tr><th>Source</th><th>Type</th><th class="num">Sites</th><th class="num">Healthy</th><th class="num">Failing</th><th class="num">Interns (last poll)</th><th>Last success</th></tr></thead><tbody>${srcRows || '<tr><td colspan="7" class="muted">Loading…</td></tr>'}</tbody></table></div>
      </div>
    </div>`;
}

// ---------- tracker sync (private GitHub repo) ----------
const b64enc = (str) => { const bytes = new TextEncoder().encode(str); let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(bin); };
const b64dec = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, '')), (c) => c.charCodeAt(0)));

function mergeTracker(a, b) {
  if (!b) return a;
  const out = { v: 1, items: { ...(b.items || {}) }, dismissed: { ...(b.dismissed || {}) }, opened: { ...(b.opened || {}) } };
  for (const [id, it] of Object.entries(a.items || {})) { const o = out.items[id]; if (!o || (it.u || 0) >= (o.u || 0)) out.items[id] = it; }
  for (const [id, t] of Object.entries(a.dismissed || {})) out.dismissed[id] = Math.max(t, out.dismissed[id] || 0);
  for (const [id, t] of Object.entries(a.opened || {})) out.opened[id] = Math.max(t, out.opened[id] || 0);
  return out;
}
async function gh(path, opts = {}) {
  return fetch(`${API}${path}`, {
    ...opts,
    cache: 'no-store',
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${S.token}`, 'X-GitHub-Api-Version': '2022-11-28', ...(opts.headers || {}) },
  });
}
let syncing = false;
async function syncNow() {
  if (!S.token || syncing) return;
  syncing = true;
  S.sync = { ...S.sync, state: 'busy' };
  try {
    const path = `/repos/${CFG.owner}/${CFG.trackerRepo}/contents/${CFG.trackerPath}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await gh(path);
      let remote = null, sha;
      if (r.status === 404) remote = null;
      else if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? `token rejected (${r.status})` : `GitHub ${r.status}`);
      else { const j = await r.json(); sha = j.sha; remote = JSON.parse(b64dec(j.content || '') || 'null'); }
      const merged = mergeTracker(S.tracker, remote);
      S.tracker = merged;
      saveTrackerLocal();
      const out = JSON.stringify(merged);
      if (remote && JSON.stringify(mergeTracker(remote, null)) === out) break;
      const put = await gh(path, { method: 'PUT', body: JSON.stringify({ message: `tracker: ${Object.values(merged.items).filter((i) => !i.del).length} items`, content: b64enc(out), ...(sha ? { sha } : {}) }) });
      if (put.ok) break;
      if (put.status === 409 || put.status === 422) continue;
      throw new Error(`GitHub ${put.status}`);
    }
    S.sync = { state: 'ok', at: Date.now(), msg: '' };
  } catch (e) {
    S.sync = { state: 'error', at: Date.now(), msg: e.message };
  } finally {
    syncing = false;
    if (S.tab === 'settings') renderSettings();
    if (S.tab === 'pipeline') renderBoard();
  }
}
const scheduleSync = debounce(() => syncNow(), 1500);

// ---------- notifications & toasts ----------
function notifyNew(fresh) {
  if (!S.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
  const top = fresh.slice(0, 3);
  for (const j of top) {
    const n = new Notification(`${j.c}`, { body: `${j.t}${j.l?.length ? `\n${locSummary(j.l)}` : ''}`, tag: j.id, icon: 'favicon.svg' });
    n.onclick = () => { window.focus(); setTab('radar'); openJob(j.id); };
  }
  if (fresh.length > 3) new Notification(`+${fresh.length - 3} more new internships`, { body: 'Open the radar to see them all.', tag: 'more' });
}
function toast(msg, actions = [], ms = 5000) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${esc(msg)}</span><span class="tb">${actions.map(([l], i) => `<button class="${i === actions.length - 1 ? 'p' : ''}" data-i="${i}">${esc(l)}</button>`).join('')}</span>`;
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    actions[Number(b.dataset.i)]?.[1]();
    el.remove();
  });
  $('#toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

// ---------- export / import ----------
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function exportCsv() {
  const cols = ['company', 'title', 'type', 'location', 'mode', 'source', 'referral', 'applied', 'status', 'updated', 'next', 'nextDate', 'priority', 'comp', 'link', 'resume', 'notes', 'delayH'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = Object.values(S.tracker.items).filter((i) => !i.del).map((i) => cols.map((c) => q(i[c])).join(','));
  download(`pipeline-${today()}.csv`, [cols.join(','), ...rows].join('\n'), 'text/csv');
}

// ---------- events ----------
function jobFromEvent(e) {
  const idEl = e.target.closest('[data-id]');
  const id = idEl?.dataset.id;
  return id ? (S.byId.get(id) || S.byId.get(S.alias[id])) : null;
}

document.addEventListener('click', (e) => {
  const tabBtn = e.target.closest('[data-tab]');
  if (tabBtn) { e.preventDefault(); setTab(tabBtn.dataset.tab); return; }
  if (e.target.closest('[data-close]')) { closeDrawer(); return; }
  if (e.target.closest('[data-close-help]')) { $('#help').hidden = true; return; }

  const act = e.target.closest('[data-act]')?.dataset.act;
  const fbtn = e.target.closest('[data-f]');
  if (fbtn) {
    const { f: key, v } = fbtn.dataset;
    const arr = S.filters[key];
    S.filters[key] = arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
    return filtersChanged();
  }
  const tier = e.target.closest('[data-tier]');
  if (tier) { S.filters.tier = tier.dataset.tier; return filtersChanged(); }
  const tog = e.target.closest('[data-toggle]');
  if (tog) { const k = tog.dataset.toggle; S.filters[k] = !S.filters[k]; return filtersChanged(); }

  const card = e.target.closest('[data-item]');
  if (card && !act) { openItem(card.dataset.item); return; }

  switch (act) {
    case 'open': { const j = jobFromEvent(e); if (j) openJobLink(j); return; } // let the link navigate
    case 'save': { e.preventDefault(); const j = jobFromEvent(e); if (j) saveJob(j); return; }
    case 'applied': { e.preventDefault(); const j = jobFromEvent(e); if (j) markApplied(j); return; }
    case 'dismiss': { e.preventDefault(); const j = jobFromEvent(e); if (j) { dismissJob(j); closeDrawer(); } return; }
    case 'edit-item': openItem(e.target.closest('[data-id]').dataset.id); return;
    case 'delete-item': {
      const id = $('#item-form').dataset.id;
      const it = S.tracker.items[id];
      if (it && confirm(`Delete ${it.company} — ${it.title} from your pipeline?`)) { it.del = true; it.u = Date.now(); trackerChanged(); closeDrawer(); renderView(); }
      return;
    }
    case 'seen': S.seenAt = Date.now(); LS.set('radar.seenAt', S.seenAt); renderView(); return;
    case 'more': S.shown += 150; renderList(); return;
    case 'window': S.filters.age = S.filters.age === '8h' ? 'all' : '8h'; return filtersChanged();
    case 'toggle-filters': $('#filters').classList.toggle('open'); renderList(); return;
    case 'sync-now': syncNow(); return;
    case 'connect': {
      const v = $('#token-in').value.trim();
      if (!v) return;
      S.token = v; LS.set('radar.token', v);
      syncNow().then(() => toast(S.sync.state === 'ok' ? 'Tracker sync connected' : `Sync failed: ${S.sync.msg}`));
      renderSettings();
      return;
    }
    case 'disconnect': S.token = ''; LS.del('radar.token'); S.sync = { state: 'off' }; renderSettings(); return;
    case 'copy-setup': {
      const link = `${location.origin}${location.pathname}#setup=${encodeURIComponent(S.token)}`;
      navigator.clipboard?.writeText(link).then(() => toast('Setup link copied. Send it only to yourself.'), () => prompt('Copy this link', link));
      return;
    }
    case 'notify': {
      if (!('Notification' in window)) { toast('This browser does not support notifications'); return; }
      if (S.notify && Notification.permission === 'granted') { S.notify = false; LS.set('radar.notify', false); renderSettings(); return; }
      Notification.requestPermission().then((p) => { S.notify = p === 'granted'; LS.set('radar.notify', S.notify); renderSettings(); if (p !== 'granted') toast('Notifications are blocked for this site in your browser settings'); });
      return;
    }
    case 'reset-filters': S.filters = { ...DEFAULT_FILTERS }; LS.set('radar.filters', S.filters); toast('Filters reset'); renderView(); return;
    case 'export-json': download(`tracker-${today()}.json`, JSON.stringify(S.tracker, null, 1), 'application/json'); return;
    case 'export-csv': exportCsv(); return;
    default: break;
  }

  const row = e.target.closest('.row');
  if (row && !e.target.closest('a,button')) {
    S.sel = S.visible.findIndex((j) => j.id === row.dataset.id);
    $$('.row.sel').forEach((r) => r.classList.remove('sel'));
    row.classList.add('sel');
    openJob(row.dataset.id);
  }
  const li = e.target.closest('.mini-list li[data-item]');
  if (li) openItem(li.dataset.item);
});

document.addEventListener('change', (e) => {
  const sel = e.target.closest('[data-sel]');
  if (sel) { S.filters[sel.dataset.sel] = sel.value; return filtersChanged(); }
  if (e.target.dataset.act === 'theme') {
    const v = e.target.value;
    if (v === 'auto') { delete document.documentElement.dataset.theme; LS.del('radar.theme'); } else { document.documentElement.dataset.theme = v; LS.set('radar.theme', v); }
    return;
  }
  if (e.target.dataset.act === 'import') {
    const file = e.target.files?.[0];
    if (!file) return;
    file.text().then((t) => {
      const data = JSON.parse(t);
      if (!data.items) throw new Error('not a tracker export');
      S.tracker = mergeTracker(S.tracker, data);
      trackerChanged();
      toast(`Imported ${Object.keys(data.items).length} items`);
    }).catch((err) => toast(`Import failed: ${err.message}`));
  }
});

document.addEventListener('submit', (e) => {
  if (e.target.id === 'item-form') { e.preventDefault(); saveItemForm(e.target); }
});

function filtersChanged() {
  LS.set('radar.filters', S.filters);
  S.shown = 150;
  S.sel = -1;
  renderFilters();
  renderList();
  renderCounts();
}

$('#q').addEventListener('input', debounce((e) => {
  S.q = e.target.value.trim().toLowerCase();
  S.shown = 150;
  if (S.tab === 'radar') renderList(); else if (S.tab === 'pipeline') renderBoard();
}, 120));

$('#add-app').addEventListener('click', newItem);

// drag & drop on the board
document.addEventListener('dragstart', (e) => {
  const c = e.target.closest?.('.card');
  if (!c) return;
  c.classList.add('dragging');
  e.dataTransfer.setData('text/plain', c.dataset.item);
  e.dataTransfer.effectAllowed = 'move';
});
document.addEventListener('dragend', (e) => e.target.closest?.('.card')?.classList.remove('dragging'));
document.addEventListener('dragover', (e) => {
  const col = e.target.closest?.('[data-drop]');
  if (!col) return;
  e.preventDefault();
  $$('.col.drop').forEach((c) => c !== col && c.classList.remove('drop'));
  col.classList.add('drop');
});
document.addEventListener('drop', (e) => {
  const col = e.target.closest?.('[data-drop]');
  $$('.col.drop').forEach((c) => c.classList.remove('drop'));
  if (!col) return;
  e.preventDefault();
  const it = S.tracker.items[e.dataTransfer.getData('text/plain')];
  if (!it || it.status === col.dataset.drop || (col.dataset.drop === 'Rejected' && CLOSED_STATUSES.has(it.status)) || (col.dataset.drop === 'Offer' && it.status === 'Accepted')) return;
  setStatus(it, col.dataset.drop);
  trackerChanged();
  renderBoard();
  toast(`${it.company} → ${it.status}`);
});

// chart tooltips
let tipEl;
document.addEventListener('mousemove', (e) => {
  const t = e.target.closest?.('[data-tip]');
  if (!t) { tipEl?.remove(); tipEl = null; return; }
  if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'tip'; document.body.append(tipEl); }
  tipEl.textContent = t.dataset.tip;
  tipEl.style.left = `${e.clientX}px`;
  tipEl.style.top = `${e.clientY}px`;
});

// keyboard
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const key = e.key;
  if (key === 'Escape') { closeDrawer(); $('#help').hidden = true; return; }
  if (key === '/') { e.preventDefault(); $('#q').focus(); return; }
  if (key === '?') { $('#help').hidden = false; return; }
  if (['1', '2', '3', '4'].includes(key)) { setTab(['radar', 'pipeline', 'dash', 'settings'][Number(key) - 1]); return; }
  if (S.tab !== 'radar' || !S.visible.length) return;
  const move = (d) => {
    S.sel = Math.max(0, Math.min(S.visible.length - 1, S.sel + d));
    if (S.sel >= S.shown) { S.shown += 150; renderList(); }
    $$('.row.sel').forEach((r) => r.classList.remove('sel'));
    const row = $(`.row[data-id="${CSS.escape(S.visible[S.sel].id)}"]`);
    row?.classList.add('sel');
    row?.scrollIntoView({ block: 'nearest' });
  };
  const cur = S.visible[S.sel];
  if (key === 'j' || key === 'ArrowDown') { e.preventDefault(); move(1); }
  else if (key === 'k' || key === 'ArrowUp') { e.preventDefault(); move(-1); }
  else if (!cur) return;
  else if (key === 'o' || key === 'Enter') { openJobLink(cur); window.open(safeUrl(cur.u), '_blank', 'noopener'); }
  else if (key === ' ') { e.preventDefault(); openJob(cur.id); }
  else if (key === 's') saveJob(cur);
  else if (key === 'a') markApplied(cur);
  else if (key === 'x') dismissJob(cur);
});

// "Did you apply?" when you come back from a posting
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  refresh();
  if (S.token) syncNow();
  const p = S.pendingApply;
  if (p && Date.now() - p.at > 20_000 && Date.now() - p.at < 3 * HOUR) {
    S.pendingApply = null;
    const j = S.byId.get(p.id);
    const it = j && trackItem(j.id);
    if (j && (!it || it.status === 'To Apply')) toast(`Did you apply to ${j.c}?`, [['Not yet', () => {}], ['Yes, mark applied', () => markApplied(j)]], 15000);
  }
});

// ---------- boot ----------
(function boot() {
  const m = location.hash.match(/setup=([^&]+)/);
  if (m) {
    S.token = decodeURIComponent(m[1]);
    LS.set('radar.token', S.token);
    history.replaceState(null, '', location.pathname + location.search);
    setTimeout(() => toast('Tracker sync connected on this device'), 500);
  }
  setTab(S.tab);
  refresh();
  if (S.token) syncNow();
  setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, S.token ? 30_000 : 75_000);
  setInterval(() => { renderStatus(); if (S.token && document.visibilityState === 'visible') syncNow(); }, 60_000);
  setInterval(() => { if (S.tab === 'radar' && document.visibilityState === 'visible' && !$('#drawer').classList.contains('open')) renderList(); }, 60_000);
}());
