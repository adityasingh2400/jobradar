# Source adapter contract

Every career-site adapter is one ES module in `radar/sources/platforms/` (one ATS platform
that many companies use) or `radar/sources/custom/` (one company's own careers site).
The registry (`radar/sources/index.mjs`) auto-loads every `.mjs` file in both folders, so
adding an adapter never requires editing a shared file.

```js
// radar/sources/custom/google.mjs
export default {
  id: 'goog',               // unique, short, lowercase; the prefix of every sid it emits
  label: 'Google Careers',  // shown in the UI as the source name
  kind: 'company',          // 'company' (fixed instances) | 'platform' (instances discovered from URLs)
  interval: 300,            // seconds between polls of ONE instance by the always-on Mac runner

  // kind === 'company': fixed list of instances to poll
  instances: [{ key: 'goog', company: 'Google' }],

  // kind === 'platform': derive a pollable instance from any job URL seen on an aggregator
  // (return null if the URL is not this platform). `key` must be stable and unique.
  instanceFromUrl(url, company) { return { key: 'oracle:jpmc.fa.oraclecloud.com:CX_1001', company, host: '...', site: '...' }; },
  // optional: important instances that aggregators might not link to
  seedInstances: [],

  // Canonical id for a job URL of this site/platform, or null if not ours.
  // MUST return exactly the `sid` that poll() emits for the same job, for every URL form
  // the job can appear under (apply page, detail page, localized paths, tracking params...).
  // This is how the same job seen on Simplify and on the company site gets merged.
  canon(url) { return 'goog:123456789'; },

  // Poll one instance. Return ONLY internship / co-op postings (filter with ctx.isInternTitle,
  // and use the site's own keyword search for "intern" when it has one so we don't page through
  // thousands of unrelated jobs). All locations are fine; the core filters regions.
  async poll(instance, ctx) {
    return {
      complete: true, // true ONLY if `items` is the full set of currently-open intern postings for
                      // this instance (jobs missing from it will be marked closed). If results are
                      // capped/relevance-limited/partially failed, return false.
      items: [{
        sid: 'goog:123456789',       // === canon(url)
        title: 'Software Engineering Intern, BS, Summer 2027',
        url: 'https://...',          // best human-facing link (detail or apply page)
        company: 'Google',           // optional; defaults to instance.company
        locations: ['Mountain View, CA, USA'],
        postedAt: '2026-09-28T17:00:00Z', // ISO string if the site exposes it, else null
        comp: '$50/hr',              // optional pay string if exposed, else null
      }],
    };
  },
};
```

`ctx` gives you:

- `ctx.http.json(url, opts)` / `ctx.http.text(url, opts)` / `ctx.http.request(url, opts)` — fetch with
  timeout, retries on 429/5xx, per-host concurrency limits, browser UA.
  `opts`: `method`, `headers`, `body` (objects are JSON-encoded), `timeout` (ms), `retries`, `etag`.
- `ctx.http.mapLimit(items, n, fn)`, `ctx.http.htmlText(html)` (strip tags + decode entities).
- `ctx.isInternTitle(title)` — the shared intern/co-op title test.
- `ctx.log(...args)`.

Rules:

- No npm dependencies. Node 22+ built-ins only (global `fetch`, `URL`, regex HTML parsing).
- Be polite: no more than ~10 requests per poll of one instance unless the site paginates small pages;
  never hammer. Throw on total failure (the core records the error and keeps last-known data).
- Never emit non-intern roles. Never emit duplicates within one poll.
- Test with: `node radar/tools/test-adapter.mjs <file> [instanceKey|jobUrl]`
  (it checks that every item's `canon(url) === sid`, that titles pass `isInternTitle`, and times the poll).
- Real sample job URLs per host from Simplify are in `radar/tools/sample-urls.json`.
