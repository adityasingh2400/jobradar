#!/usr/bin/env node
// Usage: node radar/tools/test-adapter.mjs <adapter.mjs> [instanceKey | jobUrl] [--json]
// Polls one instance and validates the adapter contract (see radar/sources/CONTRACT.md).

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import * as http from '../lib/http.mjs';
import { isInternTitle } from '../lib/classify.mjs';

const [file, target, flag] = process.argv.slice(2);
if (!file) {
  console.error('usage: node radar/tools/test-adapter.mjs <adapter.mjs> [instanceKey|jobUrl] [--json]');
  process.exit(2);
}

const mod = (await import(pathToFileURL(resolve(file)).href)).default;
const problems = [];
for (const k of ['id', 'label', 'kind', 'canon', 'poll']) if (!mod[k]) problems.push(`missing export field: ${k}`);

let instance;
if (target && /^https?:\/\//.test(target)) {
  if (mod.kind === 'platform') {
    instance = mod.instanceFromUrl(target, 'Test Co');
    if (!instance) { console.error('instanceFromUrl returned null for', target); process.exit(1); }
  } else {
    instance = mod.instances?.[0];
  }
  const c = mod.canon(target);
  console.log(`canon(${target}) -> ${c}`);
  if (!c) problems.push('canon() returned null for the given job URL');
} else if (target) {
  instance = (mod.instances || mod.seedInstances || []).find((i) => i.key === target);
  if (!instance) { console.error('no instance with key', target); process.exit(1); }
} else {
  instance = (mod.instances || mod.seedInstances || [])[0];
  if (!instance) { console.error('adapter has no instances/seedInstances; pass a job URL'); process.exit(1); }
}

console.log('instance:', JSON.stringify(instance));
const ctx = {
  http,
  isInternTitle,
  log: (...a) => console.log('[adapter]', ...a),
};

const t0 = Date.now();
const res = await mod.poll(instance, ctx);
const ms = Date.now() - t0;

if (!res || !Array.isArray(res.items)) { console.error('poll() must return { complete, items: [] }'); process.exit(1); }
const seen = new Set();
for (const it of res.items) {
  if (!it.sid || !it.sid.startsWith(mod.id + ':')) problems.push(`sid must start with "${mod.id}:" -> ${it.sid}`);
  if (seen.has(it.sid)) problems.push(`duplicate sid ${it.sid}`);
  seen.add(it.sid);
  if (!it.title) problems.push(`missing title for ${it.sid}`);
  if (!/^https?:\/\//.test(it.url || '')) problems.push(`bad url for ${it.sid}: ${it.url}`);
  const c = mod.canon(it.url);
  if (c !== it.sid) problems.push(`canon(url) !== sid: ${it.url} -> ${c} (sid ${it.sid})`);
  if (!isInternTitle(it.title)) problems.push(`title fails isInternTitle: "${it.title}"`);
  if (!Array.isArray(it.locations)) problems.push(`locations must be an array for ${it.sid}`);
  if (it.postedAt && Number.isNaN(Date.parse(it.postedAt))) problems.push(`bad postedAt for ${it.sid}: ${it.postedAt}`);
}

console.log(`\n${res.items.length} intern items, complete=${res.complete}, ${ms} ms, ${http.stats.requests} requests (${http.stats.errors} errors)`);
for (const it of res.items.slice(0, 8)) {
  console.log(` - ${it.title} | ${(it.locations || []).join('; ')} | ${it.postedAt || '-'} | ${it.comp || ''}\n   ${it.url}  [${it.sid}]`);
}
if (flag === '--json') console.log(JSON.stringify(res.items, null, 1));
if (problems.length) {
  console.log(`\nPROBLEMS (${problems.length}):`);
  for (const p of [...new Set(problems)].slice(0, 40)) console.log(' !', p);
  process.exit(1);
}
console.log('\nOK: contract checks passed');
