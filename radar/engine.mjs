// The radar's state machine: applies poll results from any source to the job set,
// merges duplicates across sources, tracks first-seen / closed, and serializes the feed.
//
// jobs.json (one job per line, sorted by id) is both the public feed and the persisted state.
// health.json carries per-instance poll health, ETags, aliases and runner heartbeats.

import {
  isInternTitle, seasonOf, seasonOk, categoriesOf, TECH_CATS, isClearlyNonTech, degreeTag, fuzzyKey, tierOf, regionsOf,
} from './lib/classify.mjs';
import { isWeakSid } from './sources/index.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Bump whenever filtering/classification rules change. The first poll of each source under new
// rules is a baseline: jobs the new rules newly accept are not reported as fresh postings.
export const RULES_VERSION = 2;

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const ms = (iso) => {
  if (!iso) return null;
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

export class Engine {
  constructor({ adapters, canon, config, now = () => Date.now(), log = () => {} }) {
    this.adapters = new Map(adapters.map((a) => [a.id, a]));
    this.canon = canon;
    this.cfg = config;
    this.now = now;
    this.log = log;
    this.jobs = new Map();
    this.alias = {};
    this.inst = {};
    this.runners = {};
    this.byInst = new Map();
    this.byFuzzy = new Map();
    this.changed = false; // jobs changed since last save (not just health)
  }

  // ---------- load / save ----------
  load(jobs = [], health = {}, instances = {}) {
    this.jobs.clear();
    this.byInst.clear();
    this.byFuzzy.clear();
    for (const j of jobs || []) this.jobs.set(j.id, j);
    this.alias = health?.alias || {};
    this.inst = instances || health?.inst || {};
    this.runners = health?.runners || {};
    this.revalidate();
    for (const j of this.jobs.values()) this.#index(j);
    this.changed = false;
  }

  /** Re-apply the current filters to stored jobs, so rule changes take effect retroactively. */
  revalidate() {
    let dropped = 0;
    for (const [id, j] of this.jobs) {
      const srcs = Object.keys(j.src || {});
      const curated = srcs.some((s) => this.adapters.get(s)?.curated);
      let keep = seasonOk(j.s || seasonOf(j.t), this.cfg.minStart);
      if (keep && !curated) {
        const cats = categoriesOf(j.t);
        keep = cats.some((c) => TECH_CATS.has(c)) || (!isClearlyNonTech(j.t) && Boolean(tierOf(j.c)));
      }
      if (!keep) { this.jobs.delete(id); dropped++; }
    }
    if (dropped) {
      for (const [k, v] of Object.entries(this.alias)) if (!this.jobs.has(v)) delete this.alias[k];
      this.changed = true;
      this.log(`revalidate: dropped ${dropped} jobs that no longer pass the filters`);
    }
    return dropped;
  }

  #index(j) {
    for (const se of Object.values(j.src || {})) {
      if (!se.i) continue;
      let s = this.byInst.get(se.i);
      if (!s) this.byInst.set(se.i, (s = new Set()));
      s.add(j.id);
    }
    const fk = fuzzyKey(j.c, j.t);
    const cur = this.byFuzzy.get(fk);
    // Prefer a strong (employer) id as the fuzzy representative.
    if (!cur || (isWeakSid(cur) && !isWeakSid(j.id))) this.byFuzzy.set(fk, j.id);
  }

  #staleMs(srcId) {
    const a = this.adapters.get(srcId);
    return (a?.staleDays ?? (srcId === 'linkedin' ? 21 : 3)) * DAY;
  }

  /**
   * open/closed for a job right now, derived from its sources.
   * - The employer's own system is authoritative: if a complete direct poll says the posting is gone,
   *   it's closed even if an aggregator still lists it (aggregators lag on removals too).
   * - A source only counts as "open" while it is fresh: complete sources while their instance keeps
   *   answering, partial sources (searches, LinkedIn) until their stale window passes.
   */
  status(j, now = this.now()) {
    let open = false;
    let directOpen = false;
    let directClosed = 0;
    let closedAt = 0;
    for (const [srcId, se] of Object.entries(j.src || {})) {
      const direct = this.adapters.get(srcId)?.direct;
      if (se.o === 1) {
        const alive = se.c
          ? now - Math.max(this.inst[se.i]?.ok || 0, se.ls || 0) < 3 * DAY
          : now - (se.ls || 0) < this.#staleMs(srcId);
        if (alive) { open = true; if (direct) directOpen = true; } else closedAt = Math.max(closedAt, (se.ls || 0) + this.#staleMs(srcId));
      } else {
        closedAt = Math.max(closedAt, se.ca || se.ls || 0);
        if (direct && se.c) directClosed = Math.max(directClosed, se.ca || 0);
      }
    }
    if (directClosed && !directOpen) return { st: 'closed', ca: directClosed };
    return open ? { st: 'open' } : { st: 'closed', ca: closedAt || now };
  }

  // ---------- applying poll results ----------
  /**
   * Record one instance poll. `result` is { items, complete, notModified?, etag? } or { error }.
   * Returns { added: [ids], closed: n }.
   */
  applyPoll(adapter, inst, result, at = this.now()) {
    const key = inst.key;
    const h = (this.inst[key] ??= { a: adapter.id });
    const out = { added: [], closed: 0 };

    if (result.error) {
      h.err = String(result.error.message || result.error).slice(0, 200);
      h.errAt = at;
      h.fails = (h.fails || 0) + 1;
      if (result.error.status) h.code = result.error.status;
      return out;
    }

    // First successful poll of this instance, or first under new rules: nothing it has is "new".
    const bootstrap = !h.ok || h.rv !== RULES_VERSION;
    h.ok = at;
    h.fails = 0;
    delete h.err; delete h.errAt; delete h.code;
    if (result.etag) h.etag = result.etag;
    if (result.ms != null) h.ms = result.ms;
    if (result.notModified) return out;
    h.n = result.items.length;
    h.rv = RULES_VERSION;

    const seen = new Set();
    for (const it of result.items) {
      const id = this.#upsert(adapter, inst, it, at, bootstrap, out, !!result.complete);
      if (id) seen.add(id);
    }

    if (result.complete) {
      let prevOpen = 0;
      const gone = [];
      for (const id of this.byInst.get(key) || []) {
        const se = this.jobs.get(id)?.src?.[adapter.id];
        if (!se || se.i !== key || se.o !== 1) continue;
        prevOpen++;
        if (!seen.has(id)) gone.push(se);
      }
      // A source that suddenly returns nothing (or loses most of its postings at once) is far more
      // likely broken than truthful. Hold the closures until it says the same thing 3 polls in a row.
      const suspicious = gone.length >= 3 && (result.items.length === 0 || (gone.length >= 10 && gone.length > 0.6 * prevOpen));
      if (suspicious && (h.suspect || 0) < 2) {
        h.suspect = (h.suspect || 0) + 1;
        h.suspectAt = at;
        out.suspect = gone.length;
      } else {
        delete h.suspect; delete h.suspectAt;
        for (const se of gone) { se.o = 0; se.ca = at; out.closed++; }
        if (gone.length) this.changed = true;
      }
    }
    return out;
  }

  #upsert(adapter, inst, it, at, bootstrap, out, complete) {
    const title = clean(it.title);
    const company = clean(it.company || inst.company);
    if (!title || !company) return null;
    if (!it.intern && !isInternTitle(title)) return null;
    const season = seasonOf(title, it.terms);
    if (!seasonOk(season, this.cfg.minStart)) return null;
    const cats = categoriesOf(title, it.catHint);
    // Curated tech lists (Simplify & co.) are trusted as-is. Elsewhere a title with no tech signal is
    // kept only at tier S/A companies (product-named roles like "Autopilot Intern"), never if it's
    // clearly non-tech (marketing, finance, mechanical...).
    if (!adapter.curated && !cats.some((c) => TECH_CATS.has(c)) && (isClearlyNonTech(title) || !tierOf(company))) return null;

    let sid = it.sid || this.canon(it.url);
    if (!sid) return null;
    sid = this.alias[sid] || sid;
    let j = this.jobs.get(sid);
    // Adapters can name other ids the same posting has elsewhere (e.g. a Jibe page fronting iCIMS).
    const aliases = Array.isArray(it.aliases) ? it.aliases.filter((a) => typeof a === 'string' && a !== sid) : [];
    if (!j) {
      for (const a of aliases) {
        const hit = this.jobs.get(this.alias[a] || a);
        if (hit) { this.alias[sid] = hit.id; j = hit; break; }
      }
    }
    const fk = fuzzyKey(company, title);

    if (!j) {
      const match = this.byFuzzy.get(fk);
      const mj = match && this.jobs.get(match);
      if (mj && isWeakSid(sid)) {
        // A board-page link (LinkedIn, Jobright…) for a job we already track: attach to it.
        this.alias[sid] = mj.id;
        j = mj;
      } else if (mj && isWeakSid(mj.id) && !isWeakSid(sid)) {
        // We first saw this job on an aggregator page; now we have the employer's posting. Upgrade.
        j = this.#absorb(mj, sid);
      } else if (mj && mj.id !== sid && this.#sameRoleElsewhere(mj, inst, it, at)) {
        // Same company + same title from a *different* system (e.g. a company on both Ashby and its
        // Phenom site, or two Workday sites): one posting, corroborated by two sources.
        this.alias[sid] = mj.id;
        j = mj;
      }
    }

    const posted = ms(it.postedAt);
    if (!j) {
      j = { id: sid, c: company, t: title, u: it.url, l: [], fs: at, src: {} };
      for (const a of aliases) if (!this.jobs.has(a)) this.alias[a] = sid;
      if (bootstrap) j.b = 1;
      this.jobs.set(sid, j);
      if (!bootstrap) out.added.push(sid);
      this.changed = true;
    }

    // Field precedence: employer (direct) data beats aggregator data for title/url/locations.
    const before = JSON.stringify([j.t, j.u, j.l, j.pa, j.cm, j.sp, j.c]);
    if (adapter.direct || !j.hd) {
      j.t = title;
      if (it.url && (adapter.direct || !j.u || isWeakSid(this.canon(j.u) || ''))) j.u = it.url;
      const locs = (it.locations || []).map(clean).filter(Boolean);
      if (locs.length) j.l = [...new Set(locs)].slice(0, 12);
    }
    if (adapter.direct) j.hd = 1;
    if (!j.c) j.c = company;
    if (posted && posted <= at + HOUR && (!j.pa || posted < j.pa)) j.pa = posted;
    if (it.comp) j.cm = clean(it.comp).slice(0, 60);
    if (it.sponsor) j.sp = clean(it.sponsor).slice(0, 60);
    if (it.workModel && !j.l.some((l) => /remote/i.test(l)) && /remote/i.test(it.workModel)) j.l = [...j.l, 'Remote'];
    j.s = seasonOf(j.t, it.terms) || season || j.s || '';
    j.k = [...new Set([...(j.k || []).filter((c) => c !== 'other'), ...cats])];
    if (j.k.length > 1) j.k = j.k.filter((c) => c !== 'other');
    j.tr = tierOf(j.c);
    j.dg = degreeTag(j.t);
    if (JSON.stringify([j.t, j.u, j.l, j.pa, j.cm, j.sp, j.c]) !== before) this.changed = true;

    const se = j.src[adapter.id];
    if (!se) {
      j.src[adapter.id] = { i: inst.key, fs: at, ls: at, o: 1 };
      this.changed = true;
    } else {
      if (se.o !== 1) this.changed = true;
      se.o = 1;
      se.ls = at;
      se.i = inst.key;
      delete se.ca;
    }
    j.src[adapter.id].c = complete ? 1 : 0;
    if (j.fs > at) j.fs = at;

    let s = this.byInst.get(inst.key);
    if (!s) this.byInst.set(inst.key, (s = new Set()));
    s.add(j.id);
    const cur = this.byFuzzy.get(fk);
    if (!cur || (isWeakSid(cur) && !isWeakSid(j.id))) this.byFuzzy.set(fk, j.id);
    return j.id;
  }

  #sameRoleElsewhere(mj, inst, it, at) {
    if (Object.values(mj.src || {}).some((se) => se.i === inst.key)) return false; // same board: distinct reqs
    const s = this.status(mj, at);
    if (s.st !== 'open' && at - s.ca > 3 * DAY) return false; // old posting; this is a repost
    const a = regionsOf(mj.l || []);
    const b = regionsOf(it.locations || []);
    const ra = Object.keys(a).filter((k) => a[k]);
    const rb = Object.keys(b).filter((k) => b[k]);
    return !ra.length || !rb.length || ra.some((r) => rb.includes(r));
  }

  /** Forget health for instances no longer on the watchlist. */
  pruneInstances(activeKeys) {
    for (const k of Object.keys(this.inst)) if (!activeKeys.has(k)) delete this.inst[k];
  }

  /** Replace a weak (aggregator-page) job with the employer's id, keeping its history. */
  #absorb(weak, sid) {
    const j = { ...weak, id: sid, src: { ...weak.src } };
    this.jobs.delete(weak.id);
    this.jobs.set(sid, j);
    this.alias[weak.id] = sid;
    for (const [k, v] of Object.entries(this.alias)) if (v === weak.id) this.alias[k] = sid;
    for (const se of Object.values(j.src)) this.byInst.get(se.i)?.delete(weak.id);
    this.#index(j);
    this.changed = true;
    return j;
  }

  // ---------- maintenance ----------
  prune(now = this.now()) {
    const keep = (this.cfg.keepClosedDays ?? 30) * DAY;
    let removed = 0;
    for (const [id, j] of this.jobs) {
      const s = this.status(j, now);
      if (s.st === 'closed' && now - s.ca > keep) {
        this.jobs.delete(id);
        for (const se of Object.values(j.src || {})) this.byInst.get(se.i)?.delete(id);
        removed++;
      }
    }
    if (removed) {
      for (const [k, v] of Object.entries(this.alias)) if (!this.jobs.has(v)) delete this.alias[k];
      this.changed = true;
    }
    return removed;
  }

  // ---------- serialization ----------
  serialize({ runner, runnerInfo = {}, sources = [], elite = [], alerts = [] } = {}) {
    const now = this.now();
    this.prune(now);
    const rows = [...this.jobs.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    let open = 0;
    const lines = rows.map((j) => {
      const s = this.status(j, now);
      j.st = s.st;
      if (s.st === 'closed') j.ca = s.ca; else { delete j.ca; open++; }
      const r = regionsOf(j.l || []);
      j.rg = Object.keys(r).filter((k) => r[k]).join(',');
      return JSON.stringify(j);
    });
    if (runner) this.runners[runner] = { ...(this.runners[runner] || {}), ...runnerInfo, at: now };
    const health = {
      v: 1,
      at: now,
      open,
      total: rows.length,
      runners: this.runners,
      sources,
      elite,
      alerts,
      alias: this.alias,
    };
    const inst = Object.keys(this.inst).sort().map((k) => `${JSON.stringify(k)}:${JSON.stringify(this.inst[k])}`);
    return {
      'jobs.json': `[\n${lines.join(',\n')}\n]\n`,
      'health.json': `${JSON.stringify(health)}\n`,
      'instances.json': `{\n${inst.join(',\n')}\n}\n`,
    };
  }
}
