#!/usr/bin/env node
// Radar runner.
//   node radar/run.mjs once     --runner actions   one sweep of everything due, publish, exit (GitHub Actions)
//   node radar/run.mjs daemon   --runner mac       continuous per-source scheduling (always-on Mac)
//   node radar/run.mjs discover                    rebuild the watchlist + pay data
//   node radar/run.mjs squash                      collapse data-branch history
// Flags: --data-dir <dir>  --dry (never push)  --self-update (daemon: follow origin/main)

import { hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as http from './lib/http.mjs';
import { isInternTitle } from './lib/classify.mjs';
import { loadAdapters, makeCanonicalizer } from './sources/index.mjs';
import { Engine } from './engine.mjs';
import { DataStore } from './store.mjs';
import { discover, buildPay } from './discover.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(ROOT, 'config/config.json'), 'utf8'));

const argv = process.argv.slice(2);
const mode = argv[0] || 'once';
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const runner = opt('runner', process.env.GITHUB_ACTIONS ? 'actions' : 'local');
const DRY = flag('dry');

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function codeVersion() {
  try { return execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return 'dev'; }
}

function remoteUrl() {
  const tok = process.env.RADAR_PUSH_TOKEN || process.env.GITHUB_TOKEN;
  return tok ? `https://x-access-token:${tok}@github.com/${cfg.repo}.git` : `https://github.com/${cfg.repo}.git`;
}

const dataDir = opt('data-dir', runner === 'actions' ? join(ROOT, '.data') : join(process.env.HOME, '.jobradar', 'data'));
const store = new DataStore({ dir: dataDir, remote: opt('remote', remoteUrl()), branch: cfg.dataBranch, log });

const adapters = await loadAdapters({ log });
const canon = makeCanonicalizer(adapters);
const engine = new Engine({ adapters, canon, config: cfg, log });
const ctx = { http, isInternTitle, log: (...a) => log('[adapter]', ...a) };

function loadFromStore() {
  engine.load(store.read('jobs.json') || [], store.read('health.json') || {}, store.read('instances.json') || {});
}

// ---------- tasks ----------
function buildTasks(watch) {
  const tasks = [];
  for (const a of adapters) {
    if (a.runners && !a.runners.includes(runner) && runner !== 'local') continue;
    const insts = a.kind === 'platform' ? (watch?.instances || []).filter((i) => i.a === a.id) : (a.instances || []);
    for (const inst of insts) {
      const hot = a.kind !== 'platform' || inst.hot;
      const interval = hot ? (a.interval || 600) : (a.coldInterval || (a.interval || 600) * 4);
      const rank = a.group === 'aggregator' ? 0 : a.kind === 'company' ? 1 : hot ? 2 : 3;
      tasks.push({ a, inst, key: inst.key, interval, rank });
    }
  }
  return tasks;
}

function dueAt(t, floorSec = 0) {
  const h = engine.inst[t.key];
  if (!h || (!h.ok && !h.errAt)) return 0;
  let iv = Math.max(t.interval, floorSec) * 1000;
  if (h.fails) iv *= Math.min(2 ** h.fails, 32);
  if (h.fails >= 5 && [401, 403, 404, 410].includes(h.code)) iv = Math.max(iv, 24 * 3_600_000);
  return Math.max(h.ok || 0, h.errAt || 0) + iv;
}

async function runTask(t) {
  const inst = t.inst; // same object every poll, so adapters may cache resolved state on it
  inst.etag = engine.inst[t.key]?.etag;
  const t0 = Date.now();
  let timer;
  try {
    const res = await Promise.race([
      t.a.poll(inst, ctx),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('poll timeout (150s)')), 150_000); }),
    ]);
    if (!res || (!res.notModified && !Array.isArray(res.items))) throw new Error('adapter returned no items array');
    return { ...res, ms: Date.now() - t0 };
  } catch (error) {
    return { error, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

// Per-source task caps. Without them, slow sources (Workday) fill every slot while waiting on
// their own rate limits and starve everything else (head-of-line blocking).
const TASK_CAPS = { gh: 12, lever: 6, ashby: 8, wd: 14, sr: 4, wk: 3, linkedin: 1 };
const capFor = (a) => a.concurrency ?? TASK_CAPS[a.id] ?? 4;

/** Run tasks round-robin across sources, honoring per-source caps and a global cap. */
function runPool(tasks, { global, deadline = Infinity, onResult }) {
  const queues = new Map();
  for (const t of tasks) {
    if (!queues.has(t.a.id)) queues.set(t.a.id, []);
    queues.get(t.a.id).push(t);
  }
  const active = new Map();
  let inflight = 0;
  return new Promise((resolve) => {
    const pump = () => {
      if (Date.now() <= deadline) {
        let launched = true;
        while (inflight < global && launched) {
          launched = false;
          for (const [id, q] of queues) {
            if (inflight >= global) break;
            if (!q.length || (active.get(id) || 0) >= capFor(q[0].a)) continue;
            const t = q.shift();
            active.set(id, (active.get(id) || 0) + 1);
            inflight++;
            launched = true;
            runTask(t).then((res) => {
              onResult(t, res);
              active.set(id, active.get(id) - 1);
              inflight--;
              pump();
            });
          }
        }
      }
      const pending = Date.now() <= deadline && [...queues.values()].some((q) => q.length);
      if (!inflight && !pending) resolve();
    };
    pump();
  });
}

function sourceSummary(tasks) {
  const by = new Map();
  const now = Date.now();
  for (const t of tasks) {
    const s = by.get(t.a.id) || { id: t.a.id, label: t.a.label, group: t.a.group, kind: t.a.kind, instances: 0, healthy: 0, failing: 0, never: 0, items: 0, lastOk: 0 };
    const h = engine.inst[t.key];
    s.instances++;
    if (!h?.ok) s.never++;
    else if (!h.fails && now - h.ok < Math.max(t.interval * 4000, 3 * 3_600_000)) s.healthy++;
    if (h?.fails) s.failing++;
    s.items += h?.n || 0;
    s.lastOk = Math.max(s.lastOk, h?.ok || 0);
    by.set(t.a.id, s);
  }
  return [...by.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// ---------- publishing with compare-and-swap + replay ----------
let journal = []; // [task, result, at] since last successful publish

async function publish(tasks, runnerInfo, message) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const files = engine.serialize({ runner, runnerInfo, sources: sourceSummary(tasks) });
    if (DRY) { log(`dry run: would publish (${(files['jobs.json'].length / 1e6).toFixed(2)} MB jobs)`); return { ok: true }; }
    const r = store.publish(files, message);
    if (r.ok) { journal = []; engine.changed = false; return r; }
    log(`publish conflict (attempt ${attempt + 1}); replaying ${journal.length} polls on latest data`);
    store.pull();
    loadFromStore();
    for (const [t, res, at] of journal) engine.applyPoll(t.a, t.inst, res, at);
    await sleep(500 + Math.random() * 1500);
  }
  throw new Error('publish failed after 5 attempts');
}

async function ensureWatchlist() {
  let watch = store.read('watchlist.json');
  if (!watch) {
    log('no watchlist yet: running discovery');
    watch = await discover({ adapters, http, prev: null, log });
    const pay = await buildPay(http, log);
    if (!DRY) {
      const files = { 'watchlist.json': JSON.stringify(watch) };
      if (pay) files['pay.json'] = JSON.stringify(pay);
      for (let i = 0; i < 5; i++) {
        const r = store.publish(files, 'discover: initial watchlist');
        if (r.ok) break;
        store.pull();
      }
    }
  }
  return watch;
}

function applyResult(t, res, at, stats) {
  const out = engine.applyPoll(t.a, t.inst, res, at);
  journal.push([t, res, at]);
  stats.polls++;
  if (res.error) {
    stats.errors++;
    if ((engine.inst[t.key]?.fails || 0) <= 2) log(`  ✗ ${t.key}: ${String(res.error.message || res.error).slice(0, 140)}`);
  }
  if (out.added.length) {
    stats.added += out.added.length;
    for (const id of out.added.slice(0, 5)) {
      const j = engine.jobs.get(id);
      log(`  ★ NEW ${j?.c} — ${j?.t} [${t.a.id}]`);
    }
  }
  stats.closed += out.closed;
}

// ---------- modes ----------
async function once() {
  const started = Date.now();
  store.ensure();
  store.pull();
  loadFromStore();
  const macAt = engine.runners?.mac?.at || 0;
  if (runner === 'actions' && !flag('force') && Date.now() - macAt < cfg.macFreshMinutes * 60_000) {
    log(`Mac runner is live (last publish ${Math.round((Date.now() - macAt) / 1000)}s ago); skipping this sweep.`);
    return;
  }
  const watch = await ensureWatchlist();
  const tasks = buildTasks(watch);
  const floor = runner === 'actions' ? cfg.actions.minIntervalSeconds : 0;
  const now = Date.now();
  const due = tasks.filter((t) => dueAt(t, floor) <= now)
    .sort((a, b) => a.rank - b.rank || dueAt(a, floor) - dueAt(b, floor));
  log(`${runner}: ${due.length}/${tasks.length} instances due`);
  const budget = (cfg.actions.budgetSeconds || 210) * 1000;
  const stats = { polls: 0, errors: 0, added: 0, closed: 0 };
  await runPool(due, {
    global: cfg.actions.concurrency || 48,
    deadline: started + budget,
    onResult: (t, res) => applyResult(t, res, Date.now(), stats),
  });
  const info = { host: hostname(), version: codeVersion(), ...stats, requests: http.stats.requests, notModified: http.stats.notModified, ms: Date.now() - started };
  log(`sweep done: ${JSON.stringify(info)}`);
  const r = await publish(tasks, info, `${runner}: +${stats.added} new, ${stats.closed} closed, ${stats.polls} polls`);
  log(`published ${r.sha || ''} · ${engine.jobs.size} jobs tracked`);
}

async function daemon() {
  store.ensure();
  store.pull();
  loadFromStore();
  let watch = await ensureWatchlist();
  let tasks = buildTasks(watch);
  const conc = cfg.mac.concurrency || 24;
  const inflight = new Set();
  const activeBy = new Map();
  const stats = { polls: 0, errors: 0, added: 0, closed: 0, since: Date.now() };
  let lastPublish = 0;
  let lastTick = Date.now();
  let lastUpdateCheck = Date.now();
  let lastWatchCheck = Date.now();
  let publishing = false;
  log(`daemon (${runner}) watching ${tasks.length} instances across ${new Set(tasks.map((t) => t.a.id)).size} sources`);

  const doPublish = async () => {
    publishing = true;
    try {
      // Someone else (Actions, discovery) moved the branch: rebase onto it before writing.
      const head = store.remoteHead();
      if (head && head !== store.base) {
        store.pull();
        loadFromStore();
        for (const [t, res, at] of journal) engine.applyPoll(t.a, t.inst, res, at);
        const w = store.read('watchlist.json');
        if (w && w.generatedAt !== watch?.generatedAt) { watch = w; tasks = buildTasks(watch); log(`watchlist reloaded: ${tasks.length} instances`); }
      }
      const info = { host: hostname(), version: codeVersion(), ...stats, requests: http.stats.requests, notModified: http.stats.notModified, inflight: inflight.size };
      const r = await publish(tasks, info, `mac: +${stats.added} new total, ${stats.polls} polls`);
      lastPublish = Date.now();
      if (!r.noop) log(`published ${String(r.sha || '').slice(0, 7)} · ${engine.jobs.size} jobs · ${stats.polls} polls · ${stats.added} new since start`);
    } catch (e) {
      log(`publish error: ${e.message}`);
      lastPublish = Date.now() - (cfg.mac.publishEverySeconds || 45) * 500; // retry sooner
    } finally {
      publishing = false;
    }
  };

  for (;;) {
    const now = Date.now();
    if (now - lastTick > 120_000) log(`woke up after ${Math.round((now - lastTick) / 1000)}s pause (sleep?)`);
    lastTick = now;

    if (inflight.size < conc) {
      const due = tasks.filter((t) => !inflight.has(t.key) && dueAt(t) <= now)
        .sort((a, b) => a.rank - b.rank || dueAt(a) - dueAt(b));
      const byAdapter = new Map();
      for (const t of due) {
        if (!byAdapter.has(t.a.id)) byAdapter.set(t.a.id, []);
        byAdapter.get(t.a.id).push(t);
      }
      // Round-robin across sources, each within its own cap.
      let launched = true;
      while (inflight.size < conc && launched) {
        launched = false;
        for (const [id, q] of byAdapter) {
          if (inflight.size >= conc) break;
          if (!q.length || (activeBy.get(id) || 0) >= capFor(q[0].a)) continue;
          const t = q.shift();
          inflight.add(t.key);
          activeBy.set(id, (activeBy.get(id) || 0) + 1);
          launched = true;
          runTask(t).then((res) => {
            inflight.delete(t.key);
            activeBy.set(id, activeBy.get(id) - 1);
            applyResult(t, res, Date.now(), stats);
          });
        }
      }
    }

    const sincePub = now - lastPublish;
    if (!publishing && ((engine.changed && sincePub > (cfg.mac.publishEverySeconds || 45) * 1000) || sincePub > (cfg.mac.heartbeatEverySeconds || 180) * 1000)) {
      await doPublish();
    }

    if (now - lastWatchCheck > (cfg.mac.watchlistReloadMinutes || 180) * 60_000) {
      lastWatchCheck = now;
      lastPublish = 0; // next publish checks remote head and reloads the watchlist
    }

    if (flag('self-update') && now - lastUpdateCheck > 20 * 60_000) {
      lastUpdateCheck = now;
      try {
        execFileSync('git', ['-C', ROOT, 'fetch', '-q', 'origin', 'main'], { stdio: 'ignore', timeout: 60_000 });
        const local = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
        const remote = execFileSync('git', ['-C', ROOT, 'rev-parse', 'origin/main'], { encoding: 'utf8' }).trim();
        if (local !== remote) {
          log('new code on origin/main: publishing, updating and restarting');
          if (journal.length) await doPublish();
          execFileSync('git', ['-C', ROOT, 'reset', '-q', '--hard', 'origin/main']);
          process.exit(0); // launchd restarts us on the new code
        }
      } catch (e) { log(`self-update check failed: ${e.message}`); }
    }

    await sleep(2000);
  }
}

async function runDiscover() {
  store.ensure();
  store.pull();
  const prev = store.read('watchlist.json');
  const watch = await discover({ adapters, http, prev, log });
  const pay = await buildPay(http, log);
  if (DRY) { log('dry run: not publishing watchlist'); return; }
  for (let i = 0; i < 5; i++) {
    const files = { 'watchlist.json': JSON.stringify(watch) };
    if (pay) files['pay.json'] = JSON.stringify(pay);
    const r = store.publish(files, `discover: ${watch.instances.length} instances`);
    if (r.ok) { log(`watchlist published (${watch.instances.length} instances)`); return; }
    store.pull();
    await sleep(1000 + Math.random() * 2000);
  }
  throw new Error('could not publish watchlist');
}

async function runSquash() {
  store.ensure();
  for (let i = 0; i < 5; i++) {
    const r = store.squash(`squash @ ${new Date().toISOString()}`);
    if (r.ok) { log(`squashed data branch to ${r.sha}`); return; }
    await sleep(2000);
  }
  log('squash skipped (branch busy)');
}

process.on('unhandledRejection', (e) => { log('unhandled rejection:', e?.stack || e); });

try {
  if (mode === 'once') await once();
  else if (mode === 'daemon') await daemon();
  else if (mode === 'discover') await runDiscover();
  else if (mode === 'squash') await runSquash();
  else { console.error(`unknown mode ${mode}`); process.exit(2); }
} catch (e) {
  log('fatal:', e?.stack || e);
  process.exit(1);
}
