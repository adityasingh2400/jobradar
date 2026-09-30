// Behavioral tests for the radar engine: node test/engine.test.mjs
import assert from 'node:assert/strict';
import { Engine } from '../radar/engine.mjs';
import { urlKey } from '../radar/sources/index.mjs';

const A = { id: 'gh', direct: true, canon: (u) => u.match(/gh_jid=(\d+)/) ? `gh:${u.match(/gh_jid=(\d+)/)[1]}` : null };
const D = { id: 'phenom', direct: true, canon: () => null };
const S = { id: 'simplify', direct: false, canon: () => null };
const L = { id: 'linkedin', direct: false, canon: () => null, staleDays: 21 };
const adapters = [A, D, S, L];
const canon = (u) => A.canon(u) || urlKey(u);
let now = Date.parse('2026-10-01T00:00:00Z');
const e = new Engine({ adapters, canon, config: { minStart: '2026-11' }, now: () => now });
const gi = { key: 'gh:acme', company: 'Acme' };
const job = (id, title = 'Software Engineer Intern', loc = ['San Francisco, CA']) =>
  ({ sid: `gh:${id}`, title, url: `https://boards.greenhouse.io/acme/jobs/${id}?gh_jid=${id}`, locations: loc });
const poll = (ad, inst, items, complete = true) => e.applyPoll(ad, inst, { items, complete }, now);
const tick = (m) => { now += m * 60_000; };

// 1. first poll of a board is a bootstrap: nothing is "new"
let r = poll(A, gi, [job(1), job(2, 'ML Research Intern'), job(3, 'Data Intern'), job(4, 'Infra Intern'), job(5, 'Security Intern')]);
assert.equal(r.added.length, 0);
assert.equal(e.jobs.get('gh:1').b, 1);

// 2. a posting that appears later is new
tick(2); r = poll(A, gi, [job(1), job(2, 'ML Research Intern'), job(3, 'Data Intern'), job(4, 'Infra Intern'), job(5, 'Security Intern'), job(6, 'Backend Intern')]);
assert.deepEqual(r.added, ['gh:6']);

// 3. an aggregator linking the same posting merges into one job with two sources
const si = { key: 'simplify', company: '' };
poll(S, si, [{ title: 'Backend Intern', company: 'Acme', url: 'https://acme.com/careers?gh_jid=6', intern: true, locations: ['SF'] }]);
poll(S, { key: 'simplify-first' }, []); // noop instance
assert.deepEqual(Object.keys(e.jobs.get('gh:6').src).sort(), ['gh', 'simplify']);

// 4. employer authority: board drops it, aggregator still lists it -> closed
tick(2); poll(A, gi, [job(1), job(2, 'ML Research Intern'), job(3, 'Data Intern'), job(4, 'Infra Intern'), job(5, 'Security Intern')]);
poll(S, si, [{ title: 'Backend Intern', company: 'Acme', url: 'https://acme.com/careers?gh_jid=6', intern: true }]);
assert.equal(e.status(e.jobs.get('gh:6')).st, 'closed', 'direct board is authoritative');

// 5. mass-close protection: a board that suddenly returns nothing is held for 2 polls
tick(2); r = poll(A, gi, []);
assert.equal(r.closed, 0); assert.ok(r.suspect);
tick(2); r = poll(A, gi, []);
assert.equal(r.closed, 0);
tick(2); r = poll(A, gi, []);
assert.equal(r.closed, 5, 'third identical empty poll is believed');

// 6. cross-system corroboration: same company+title from another system merges; different country doesn't
const gi2 = { key: 'gh:acme2', company: 'Acme' };
tick(2); poll(A, gi2, [job(10, 'Platform Intern', ['New York, NY'])]);
poll(D, { key: 'phenom:acme', company: 'Acme' }, [{ sid: 'phenom:acme:77', title: 'Platform Intern', url: 'https://careers.acme.com/job/77', locations: ['New York, NY'] }]);
assert.equal(e.jobs.has('phenom:acme:77'), false, 'mirror merged into the Greenhouse job');
assert.deepEqual(Object.keys(e.jobs.get('gh:10').src).sort(), ['gh', 'phenom']);
poll(D, { key: 'phenom:acme', company: 'Acme' }, [{ sid: 'phenom:acme:78', title: 'Platform Intern', url: 'https://careers.acme.com/job/78', locations: ['Toronto, ON'] }], false);
assert.equal(e.jobs.has('phenom:acme:78'), true, 'Canada posting stays separate from the US one');

// 7. LinkedIn corroboration attaches to the employer's posting; LinkedIn-only jobs stand alone
poll(L, { key: 'linkedin:x' }, [
  { title: 'Platform Intern', company: 'Acme', url: 'https://www.linkedin.com/jobs/view/111', intern: true, locations: ['New York, NY'] },
  { title: 'Autopilot Intern', company: 'Tesla', url: 'https://www.linkedin.com/jobs/view/222', intern: true, locations: ['Palo Alto, CA'] },
], false);
assert.ok(e.jobs.get('gh:10').src.linkedin, 'linkedin corroborates');
assert.ok(e.jobs.has('url:linkedin.com/jobs/view/222'), 'tesla via linkedin is kept');

// 8. a weak job upgrades when the employer posting shows up later
poll(A, { key: 'gh:tesla', company: 'Tesla' }, [{ sid: 'gh:999', title: 'Autopilot Intern', url: 'https://x.com?gh_jid=999', locations: ['Palo Alto, CA'] }]);
assert.equal(e.jobs.has('url:linkedin.com/jobs/view/222'), false);
assert.ok(e.jobs.get('gh:999').src.linkedin && e.jobs.get('gh:999').src.gh);
assert.equal(e.alias['url:linkedin.com/jobs/view/222'], 'gh:999');

// 9. serialization round-trip
const files = e.serialize({ runner: 'test' });
const e2 = new Engine({ adapters, canon, config: { minStart: '2026-11' }, now: () => now });
e2.load(JSON.parse(files['jobs.json']), JSON.parse(files['health.json']), JSON.parse(files['instances.json']));
assert.equal(e2.jobs.size, e.jobs.size);
console.log(`engine tests passed (${e.jobs.size} jobs)`);
