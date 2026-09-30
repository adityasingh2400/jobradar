// Builds the watchlist: every company career site we can poll directly, discovered from the
// links aggregators publish (a company that posted internships on Simplify et al. gets its own
// board watched), plus curated seeds. Also builds pay.json from Levels.fyi intern salary reports.

import { readFileSync } from 'node:fs';
import { normCompany, tierOf, isInternTitle } from './lib/classify.mjs';

const RAW = 'https://raw.githubusercontent.com';
const DAY = 86_400_000;

const LISTINGS = [
  { repo: 'SimplifyJobs/Summer2027-Internships', branch: 'dev', path: '.github/scripts/listings.json', intern: true },
  { repo: 'SimplifyJobs/New-Grad-Positions', branch: 'dev', path: '.github/scripts/listings.json', intern: false },
  { repo: 'vanshb03/Summer2027-Internships', branch: 'dev', path: '.github/scripts/listings.json', intern: true },
  { repo: 'vanshb03/Summer2027-Internships', branch: 'dev', path: 'archived/2026/archived.json', intern: true },
  { repo: 'vanshb03/Summer2027-Internships', branch: 'dev', path: 'archived/2025/archived.json', intern: true },
  { repo: 'vanshb03/New-Grad-2027', branch: 'dev', path: '.github/scripts/listings.json', intern: false },
];
const READMES = [
  { repo: 'speedyapply/2027-SWE-College-Jobs', branch: 'main' },
  { repo: 'speedyapply/2027-AI-College-Jobs', branch: 'main' },
];

async function gatherLinks(http, log) {
  const links = []; // { url, company, at, intern }
  for (const L of LISTINGS) {
    try {
      const data = await http.json(`${RAW}/${L.repo}/${L.branch}/${L.path}`, { timeout: 90_000 });
      for (const x of data) {
        if (!x.url) continue;
        links.push({ url: x.url, company: x.company_name, at: (x.date_posted || 0) * 1000, intern: L.intern || isInternTitle(x.title || '') });
      }
      log(`discover: ${L.repo}/${L.path}: ${data.length} records`);
    } catch (e) { log(`discover: ${L.repo}/${L.path} failed: ${e.message}`); }
  }
  for (const R of READMES) {
    try {
      const md = await http.text(`${RAW}/${R.repo}/${R.branch}/README.md`);
      for (const line of md.split('\n')) {
        if (!line.startsWith('|')) continue;
        const hrefs = [...line.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
        const company = line.match(/<strong>([^<]+)<\/strong>/)?.[1];
        if (hrefs.length > 1 && company) links.push({ url: hrefs[hrefs.length - 1], company, at: Date.now(), intern: true });
      }
    } catch (e) { log(`discover: ${R.repo} failed: ${e.message}`); }
  }
  return links;
}

// Company-hosted Greenhouse pages (…?gh_jid=123) hide the board token. Try likely tokens and
// confirm with the job id itself, which is globally unique.
function ghCandidates(company, url) {
  const out = new Set();
  const base = normCompany(company);
  if (base) out.add(base);
  const words = String(company).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
  if (words[0]) out.add(words[0]);
  if (words.length > 1) out.add(words.slice(0, 2).join(''));
  try {
    const host = new URL(url).hostname.replace(/^(www|careers?|jobs|boards)\./, '');
    const label = host.split('.').slice(-2, -1)[0];
    if (label) { out.add(label); out.add(label.replace(/^(with|join|we?are|life(at)?|careers?at)/, '')); }
  } catch { /* ignore */ }
  for (const b of [...out]) { out.add(`${b}inc`); out.add(`${b}careers`); }
  return [...out].filter((t) => t.length >= 2).slice(0, 10);
}

const DEAD_CODES = new Set([401, 403, 404, 410, 422]);
/** A board that has only failed with "gone" codes for days is retired, not retried forever. */
export function isDead(h, now = Date.now()) {
  if (!h || !h.fails) return false;
  if (!h.ok && h.fails >= 10) return true; // never worked once in 10 tries (moved, unresolvable, ...)
  if (h.fails < 5 || !DEAD_CODES.has(h.code)) return false;
  return now - (h.ok || 0) > 3 * DAY;
}

export async function discover({ adapters, http, prev = null, health = {}, log = console.error }) {
  const platforms = adapters.filter((a) => a.kind === 'platform' && typeof a.instanceFromUrl === 'function');
  const companySites = adapters.filter((a) => a.kind === 'company');
  const ownedByCompanyAdapter = (url) => companySites.some((a) => { try { return Boolean(a.canon(url)); } catch { return false; } });
  const links = await gatherLinks(http, log);
  const found = new Map(); // key -> { a, inst, company counts, last, internLast, n }
  const ghPending = new Map(); // company-hosted gh_jid pages to resolve: company -> {jid, url, at}

  for (const L of links) {
    let matched = false;
    for (const a of platforms) {
      let inst = null;
      try { inst = a.instanceFromUrl(L.url, L.company); } catch { inst = null; }
      if (!inst?.key) continue;
      matched = true;
      let f = found.get(inst.key);
      if (!f) found.set(inst.key, (f = { a: a.id, inst, names: {}, last: 0, internLast: 0, n: 0 }));
      f.names[L.company] = (f.names[L.company] || 0) + 1;
      f.last = Math.max(f.last, L.at);
      if (L.intern) f.internLast = Math.max(f.internLast, L.at);
      f.n++;
      break;
    }
    if (!matched && !ownedByCompanyAdapter(L.url)) {
      try {
        const u = new URL(L.url);
        const jid = u.searchParams.get('gh_jid');
        if (jid && /^\d+$/.test(jid) && !u.hostname.endsWith('greenhouse.io')) {
          const p = ghPending.get(L.company);
          if (!p || L.at > p.at) ghPending.set(L.company, { jid, url: L.url, at: L.at, intern: L.intern });
        }
      } catch { /* ignore */ }
    }
  }

  // Resolve company-hosted Greenhouse boards (cached across runs).
  const ghResolved = { ...(prev?.ghResolved || {}) };
  const toResolve = [...ghPending.entries()].filter(([co]) => !(co in ghResolved) || (ghResolved[co] === null && Math.random() < 0.15));
  await http.mapLimit(toResolve, 8, async ([company, p]) => {
    for (const tok of ghCandidates(company, p.url)) {
      try {
        await http.json(`https://boards-api.greenhouse.io/v1/boards/${tok}/jobs/${p.jid}`, { retries: 0, timeout: 15_000 });
        ghResolved[company] = tok;
        return;
      } catch { /* try next */ }
    }
    ghResolved[company] = null;
  });
  for (const [company, p] of ghPending) {
    const tok = ghResolved[company];
    if (!tok) continue;
    const key = `gh:${tok}`;
    let f = found.get(key);
    if (!f) found.set(key, (f = { a: 'gh', inst: { key, token: tok, company }, names: {}, last: 0, internLast: 0, n: 0 }));
    f.names[company] = (f.names[company] || 0) + 1;
    f.last = Math.max(f.last, p.at);
    if (p.intern) f.internLast = Math.max(f.internLast, p.at);
    f.n++;
  }
  log(`discover: resolved ${Object.values(ghResolved).filter(Boolean).length}/${Object.keys(ghResolved).length} company-hosted Greenhouse boards`);

  // Seeds: validate each candidate board once; keep the ones that answer.
  let seeds = {};
  try { seeds = JSON.parse(readFileSync(new URL('../config/seeds.json', import.meta.url), 'utf8')); } catch { /* optional */ }
  const seedChecks = [];
  for (const [aid, list] of Object.entries(seeds)) {
    if (aid.startsWith('_')) continue;
    for (const [token, company] of list) {
      const key = `${aid}:${token.toLowerCase()}`;
      if (found.has(key)) { found.get(key).seed = true; continue; }
      seedChecks.push({ aid, token, company, key });
    }
  }
  const prevValid = new Set(prev?.seedValid || []);
  const seedValid = [];
  await http.mapLimit(seedChecks, 8, async (s) => {
    const url = s.aid === 'gh' ? `https://boards-api.greenhouse.io/v1/boards/${s.token}/jobs`
      : s.aid === 'lever' ? `https://api.lever.co/v0/postings/${s.token}?mode=json&limit=1`
        : `https://api.ashbyhq.com/posting-api/job-board/${s.token}`;
    let ok = prevValid.has(s.key) && Math.random() < 0.8; // re-validate ~20% per day
    if (!ok) {
      try { const d = await http.json(url, { retries: 0, timeout: 20_000 }); ok = Array.isArray(d) ? d.length > 0 : (d.jobs || []).length > 0; } catch { ok = false; }
    }
    if (!ok) return;
    seedValid.push(s.key);
    const inst = s.aid === 'gh' ? { key: s.key, token: s.token.toLowerCase(), company: s.company }
      : s.aid === 'lever' ? { key: s.key, org: s.token, company: s.company }
        : { key: s.key, org: s.token, company: s.company };
    found.set(s.key, { a: s.aid, inst, names: { [s.company]: 1 }, last: Date.now(), internLast: 0, n: 0, seed: true });
  });
  log(`discover: ${seedValid.length}/${seedChecks.length} seed boards valid`);

  // Adapter-provided seed instances (platform adapters may know important tenants).
  for (const a of platforms) {
    for (const inst of a.seedInstances || []) {
      if (!inst?.key || found.has(inst.key)) continue;
      found.set(inst.key, { a: a.id, inst, names: { [inst.company || '']: 1 }, last: Date.now(), internLast: 0, n: 0, seed: true });
    }
  }

  const now = Date.now();
  const instances = [];
  let retired = 0;
  for (const [key, f] of found) {
    if (isDead(health[key], now)) { retired++; continue; }
    const company = Object.entries(f.names).sort((a, b) => b[1] - a[1])[0]?.[0] || f.inst.company || '';
    const tier = tierOf(company);
    const recentIntern = f.internLast && now - f.internLast < 240 * DAY;
    if (!f.seed && !tier && now - f.last > 540 * DAY) continue; // long-dead companies
    instances.push({
      ...f.inst,
      key,
      a: f.a,
      company,
      tier,
      hot: Boolean(tier === 'S' || tier === 'A' || recentIntern || f.seed),
      n: f.n,
      last: f.last || null,
    });
  }
  instances.sort((x, y) => (x.key < y.key ? -1 : 1));
  const byAdapter = {};
  for (const i of instances) byAdapter[i.a] = (byAdapter[i.a] || 0) + 1;
  log(`discover: ${instances.length} instances ${JSON.stringify(byAdapter)} (${retired} dead boards retired)`);

  return { v: 1, generatedAt: now, instances, ghResolved, seedValid, byAdapter };
}

/** Median intern hourly pay per company from Levels.fyi's public intern salary reports. */
export async function buildPay(http, log = console.error) {
  try {
    const rows = await http.json('https://www.levels.fyi/js/internshipData.json', { timeout: 60_000 });
    const by = new Map();
    const maxYr = Math.max(...rows.map((r) => Number(r.yr) || 0));
    for (const r of rows) {
      const yr = Number(r.yr);
      const hr = Number(r.hourlySalary);
      if (!yr || !hr || hr < 10 || hr > 250 || yr < maxYr - 2) continue;
      if (!/software|engineer|developer|machine learning|data|research|quant/i.test(r.title || '')) continue;
      const k = normCompany(r.company);
      if (!k) continue;
      const e = by.get(k) || { name: r.company, pts: [] };
      e.pts.push([yr, hr]);
      by.set(k, e);
    }
    const pay = {};
    for (const [k, e] of by) {
      const top = Math.max(...e.pts.map((p) => p[0]));
      const hrs = e.pts.filter((p) => p[0] >= top - 1).map((p) => p[1]).sort((a, b) => a - b);
      pay[k] = [hrs[Math.floor(hrs.length / 2)], top, hrs.length];
    }
    log(`pay: ${Object.keys(pay).length} companies from levels.fyi`);
    return pay;
  } catch (e) {
    log(`pay: levels.fyi failed: ${e.message}`);
    return null;
  }
}
