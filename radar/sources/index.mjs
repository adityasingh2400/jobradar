// Loads every adapter (core ATS + platform + custom company sites) and the aggregator feeds,
// and builds the canonicalizer that maps any job URL to one id across all sources.

import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import aggregators from './aggregators/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export async function loadAdapters({ log = console.error } = {}) {
  const out = [];
  const ids = new Set();
  for (const dir of ['ats', 'platforms', 'custom']) {
    let files = [];
    try { files = readdirSync(join(here, dir)).filter((f) => f.endsWith('.mjs') && !f.startsWith('_')).sort(); } catch { /* optional dir */ }
    for (const f of files) {
      try {
        const m = (await import(pathToFileURL(join(here, dir, f)).href)).default;
        if (!m?.id || typeof m.poll !== 'function' || typeof m.canon !== 'function') {
          log(`adapter ${dir}/${f}: missing id/poll/canon, skipped`);
          continue;
        }
        if (ids.has(m.id)) { log(`adapter ${dir}/${f}: duplicate id ${m.id}, skipped`); continue; }
        ids.add(m.id);
        m.group = dir;
        m.direct = true;
        out.push(m);
      } catch (e) {
        log(`adapter ${dir}/${f} failed to load: ${e.message}`);
      }
    }
  }
  for (const a of aggregators) { a.group = 'aggregator'; a.direct = false; out.push(a); }
  return out;
}

// Links that point at an aggregator's own page rather than the employer's posting.
// Jobs known only by one of these get merged into the real posting by company + title.
const WEAK_HOSTS = /^(www\.)?(jobright\.ai|simplify\.jobs|linkedin\.com|intern-list\.com|levels\.fyi|builtin\.com)$/;

export function urlKey(url) {
  try {
    const x = new URL(url);
    const path = x.pathname.replace(/\/+$/, '').replace(/\/(apply|application|apply-now)$/i, '');
    let key = `${x.hostname.replace(/^www\./, '').toLowerCase()}${path.toLowerCase()}`;
    // Keep the one query param that identifies a job on sites that route by query string.
    for (const p of ['jobId', 'jobid', 'job', 'id', 'jid', 'req', 'requisitionId', 'gh_jid']) {
      const v = x.searchParams.get(p);
      if (v) { key += `?${p}=${v}`; break; }
    }
    return `url:${key}`;
  } catch {
    return null;
  }
}

export function isWeakSid(sid) {
  if (!sid?.startsWith('url:')) return false;
  const host = sid.slice(4).split('/')[0];
  return WEAK_HOSTS.test(host);
}

export function makeCanonicalizer(adapters) {
  // Company-site adapters win over generic rules (e.g. janestreet.com links carry gh_jid).
  const order = { custom: 0, platforms: 1, ats: 2 };
  const direct = adapters.filter((a) => a.direct).sort((a, b) => (order[a.group] ?? 3) - (order[b.group] ?? 3));
  return (url) => {
    if (!url) return null;
    for (const a of direct) {
      try {
        const c = a.canon(url);
        if (c) return c;
      } catch { /* adapter bug: ignore for canonicalization */ }
    }
    return urlKey(url);
  };
}
