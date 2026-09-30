// Shared HTTP client: timeouts, retries with backoff, ETag support,
// per-host + global concurrency limits, and per-host request stats.

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

class Semaphore {
  constructor(n) { this.n = n; this.q = []; }
  async acquire() {
    if (this.n > 0) { this.n--; return; }
    await new Promise((r) => this.q.push(r));
  }
  release() {
    const next = this.q.shift();
    if (next) next(); else this.n++;
  }
}

const DEFAULT_HOST_LIMIT = 4;
const hostLimitOverrides = new Map(Object.entries({
  'boards-api.greenhouse.io': 10,
  'api.lever.co': 6,
  'api.ashbyhq.com': 6,
  'jobs.ashbyhq.com': 10,
  'raw.githubusercontent.com': 6,
  'api.smartrecruiters.com': 4,
  'apply.workable.com': 1,
  'www.linkedin.com': 1,
}));
const hostSems = new Map();
let globalSem = new Semaphore(96);

export const stats = { requests: 0, errors: 0, notModified: 0, bytes: 0, byHost: {} };

export function setGlobalLimit(n) { globalSem = new Semaphore(n); }
export function setHostLimit(host, n) { hostLimitOverrides.set(host, n); hostSems.delete(host); }

function hostSem(host) {
  let s = hostSems.get(host);
  if (!s) {
    // Workday tenants share clusters (wd1/wd3/wd5...), so throttle per cluster, not per tenant.
    const limit = hostLimitOverrides.get(host) ?? DEFAULT_HOST_LIMIT;
    s = new Semaphore(limit);
    hostSems.set(host, s);
  }
  return s;
}

function limiterKey(host) {
  const wd = host.match(/\.(wd\d+)\.myworkday(jobs|site)\.com$/) || host.match(/^(wd\d+)\.myworkdaysite\.com$/);
  if (wd) return `workday:${wd[1]}`;
  return host;
}

export class HttpError extends Error {
  constructor(status, url, body = '') {
    super(`HTTP ${status} ${url}`);
    this.status = status;
    this.url = url;
    this.body = String(body).slice(0, 300);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function backoffMs(attempt, retryAfter) {
  const ra = Number(retryAfter);
  if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 30_000);
  return Math.min(1000 * 2 ** attempt, 8000) + Math.random() * 500;
}

/**
 * request(url, opts) -> { status, data, etag, headers, url, notModified }
 * opts: method, headers, body (object => JSON), timeout (ms), retries, etag, as ('json'|'text'), ua
 */
export async function request(url, opts = {}) {
  const {
    method = 'GET', headers = {}, body, timeout = 25_000, retries = 2, etag, as = 'json', ua = DEFAULT_UA,
  } = opts;
  const host = new URL(url).host;
  const key = limiterKey(host);
  const hs = hostSem(key);
  const hstat = (stats.byHost[key] ??= { requests: 0, errors: 0, notModified: 0 });

  await globalSem.acquire();
  await hs.acquire();
  try {
    for (let attempt = 0; ; attempt++) {
      let retryable = true;
      try {
        const h = {
          'user-agent': ua,
          accept: as === 'json'
            ? 'application/json, text/plain, */*'
            : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
          ...headers,
        };
        let b = body;
        if (b != null && typeof b === 'object' && !(b instanceof URLSearchParams)) {
          b = JSON.stringify(b);
          if (!Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) h['content-type'] = 'application/json';
        }
        if (etag) h['if-none-match'] = etag;

        stats.requests++; hstat.requests++;
        const res = await fetch(url, { method, headers: h, body: b, signal: AbortSignal.timeout(timeout), redirect: 'follow' });

        if (res.status === 304) {
          stats.notModified++; hstat.notModified++;
          return { status: 304, notModified: true, etag, headers: res.headers, url: res.url };
        }
        if (res.status === 429 || res.status >= 500) {
          const txt = await res.text().catch(() => '');
          if (attempt < retries) { await sleep(backoffMs(attempt, res.headers.get('retry-after'))); continue; }
          retryable = false;
          throw new HttpError(res.status, url, txt);
        }
        if (!res.ok) {
          retryable = false;
          throw new HttpError(res.status, url, await res.text().catch(() => ''));
        }
        const text = await res.text();
        stats.bytes += text.length;
        let data = text;
        if (as === 'json') {
          try { data = JSON.parse(text); } catch {
            retryable = false;
            throw new HttpError('badjson', url, text);
          }
        }
        return { status: res.status, data, etag: res.headers.get('etag'), headers: res.headers, url: res.url };
      } catch (e) {
        if (retryable && attempt < retries) { await sleep(backoffMs(attempt)); continue; }
        stats.errors++; hstat.errors++;
        throw e;
      }
    }
  } finally {
    hs.release();
    globalSem.release();
  }
}

export const json = (url, o = {}) => request(url, { ...o, as: 'json' }).then((r) => r.data);
export const text = (url, o = {}) => request(url, { ...o, as: 'text' }).then((r) => r.data);

/** Run fn over items with a concurrency cap; returns results in order ({ok, value|error}). */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = { ok: true, value: await fn(items[idx], idx) }; } catch (error) { out[idx] = { ok: false, error }; }
    }
  });
  await Promise.all(workers);
  return out;
}

/** Minimal HTML entity decode + tag strip, for adapters that scrape HTML. */
export function htmlText(s = '') {
  return String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}
