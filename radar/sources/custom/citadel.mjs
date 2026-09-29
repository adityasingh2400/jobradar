// Citadel + Citadel Securities — www.citadel.com/careers/details/<slug>/ and
// www.citadelsecurities.com/careers/details/<slug>/
//
// Both WordPress sites sit behind a Cloudflare managed challenge ("Just a moment..." 403) for
// every page, /wp-json/, admin-ajax and RSS, so the job list and detail pages are NOT reachable
// with plain HTTP. The only unchallenged, robots.txt-advertised listing is the Yoast sitemap of
// the "career" post type (/career-sitemap.xml), which lists every published opening's URL.
// It carries no titles, locations or posting dates (lastmod is a bulk re-sync time), so titles
// and locations are reconstructed from the slug, e.g.
//   quantitative-research-analyst-intern-bs-ms-europe-2 -> "Quantitative Research Analyst Intern BS MS (Europe)"
// Slugs are the only stable id, so sid = 'citadel:c:<slug>' (citadel.com) or
// 'citadel:cs:<slug>' (citadelsecurities.com).

const SITES = {
  c: { host: 'www.citadel.com', company: 'Citadel' },
  cs: { host: 'www.citadelsecurities.com', company: 'Citadel Securities' },
};

// Trailing slug tokens that name a region/office -> [title label, location string]
const REGIONS = [
  ['north-america', 'North America', 'United States'],
  ['united-states', 'US', 'United States'],
  ['new-york', 'New York', 'New York, NY, United States'],
  ['hong-kong', 'Hong Kong', 'Hong Kong'],
  ['us', 'US', 'United States'],
  ['usa', 'US', 'United States'],
  ['americas', 'Americas', 'United States'],
  ['chicago', 'Chicago', 'Chicago, IL, United States'],
  ['miami', 'Miami', 'Miami, FL, United States'],
  ['greenwich', 'Greenwich', 'Greenwich, CT, United States'],
  ['houston', 'Houston', 'Houston, TX, United States'],
  ['canada', 'Canada', 'Canada'],
  ['toronto', 'Toronto', 'Toronto, ON, Canada'],
  ['europe', 'Europe', 'Europe'],
  ['emea', 'EMEA', 'EMEA'],
  ['uk', 'UK', 'United Kingdom'],
  ['london', 'London', 'London, United Kingdom'],
  ['dublin', 'Dublin', 'Dublin, Ireland'],
  ['paris', 'Paris', 'Paris, France'],
  ['zurich', 'Zurich', 'Zurich, Switzerland'],
  ['asia', 'Asia', 'Asia (APAC)'],
  ['apac', 'APAC', 'Asia (APAC)'],
  ['singapore', 'Singapore', 'Singapore'],
  ['shanghai', 'Shanghai', 'Shanghai, China'],
  ['tokyo', 'Tokyo', 'Tokyo, Japan'],
  ['india', 'India', 'India'],
  ['gurugram', 'Gurugram', 'Gurugram, India'],
  ['australia', 'Australia', 'Australia'],
  ['sydney', 'Sydney', 'Sydney, Australia'],
];

const WORDS = {
  phd: 'PhD', bs: 'BS', ms: 'MS', mba: 'MBA', fpga: 'FPGA', asic: 'ASIC', dmm: 'DMM', ai: 'AI', ml: 'ML',
  it: 'IT', hr: 'HR', us: 'US', uk: 'UK', ui: 'UI', ux: 'UX', etf: 'ETF', etfs: 'ETFs', fx: 'FX', otc: 'OTC',
  gqs: 'GQS', ficc: 'FICC', cto: 'CTO', cfo: 'CFO', coo: 'COO', ceo: 'CEO', llm: 'LLM', llms: 'LLMs',
  sre: 'SRE', qa: 'QA', gpu: 'GPU', cpu: 'CPU', api: 'API', emea: 'EMEA', apac: 'APAC', esg: 'ESG',
  and: 'and', of: 'of', the: 'the', for: 'for', in: 'in', to: 'to', on: 'on', with: 'with',
};

function parseSlug(slug) {
  let s = slug.toLowerCase().replace(/-\d{1,2}$/, ''); // WordPress de-dupe suffix (-2, -3...)
  let region = null; // up to two trailing region tokens, e.g. "-us-new-york"
  for (let pass = 0; pass < 2; pass++) {
    const hit = REGIONS.find(([tok]) => s.endsWith(`-${tok}`));
    if (!hit) break;
    const [tok, label, loc] = hit;
    s = s.slice(0, -(tok.length + 1));
    region = region ? { label: `${label}, ${region.label}`, loc: region.loc } : { label, loc };
  }
  const title = s.split('-').filter(Boolean)
    .map((w, i) => (WORDS[w] && !(i === 0 && /^[a-z]+$/.test(WORDS[w])) ? WORDS[w] : w[0].toUpperCase() + w.slice(1)))
    .join(' ')
    .replace(/\bPost Doctoral\b/g, 'Post-Doctoral')
    .replace(/\bCo Op\b/g, 'Co-op');
  return { title: region ? `${title} (${region.label})` : title, locations: region ? [region.loc] : [] };
}

function siteOf(host) {
  const h = String(host).toLowerCase().replace(/^www\./, '');
  if (h === 'citadel.com') return 'c';
  if (h === 'citadelsecurities.com') return 'cs';
  return null;
}

function canon(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const site = siteOf(u.hostname);
  if (!site) return null;
  const m = u.pathname.match(/\/careers\/details\/([a-z0-9][a-z0-9-]*)\/?/i);
  return m ? `citadel:${site}:${m[1].toLowerCase()}` : null;
}

export default {
  id: 'citadel',
  label: 'Citadel Careers',
  kind: 'company',
  interval: 600, // sitemap is cached 10 min server-side; robots.txt asks for Crawl-delay: 10
  instances: [
    { key: 'citadel', company: 'Citadel', site: 'c' },
    { key: 'citadelsecurities', company: 'Citadel Securities', site: 'cs' },
  ],

  canon,

  async poll(instance, ctx) {
    const site = SITES[instance.site] ? instance.site : (instance.key === 'citadelsecurities' ? 'cs' : 'c');
    const { host } = SITES[site];
    const urls = [];
    // Yoast splits a post type's sitemap every 1000 URLs (career-sitemap2.xml, ...).
    for (let n = 1; n <= 3; n++) {
      const xml = await ctx.http.text(`https://${host}/career-sitemap${n === 1 ? '' : n}.xml`, { timeout: 20_000 });
      if (!/<urlset/i.test(xml)) throw new Error(`citadel: ${host} sitemap is not a urlset (bot wall?)`);
      const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
      urls.push(...locs);
      if (locs.length < 1000) break;
    }

    const items = [];
    const seen = new Set();
    for (const url of urls) {
      const sid = canon(url);
      if (!sid || !sid.startsWith(`citadel:${site}:`) || seen.has(sid)) continue;
      const slug = sid.slice(`citadel:${site}:`.length);
      const { title, locations } = parseSlug(slug);
      if (!ctx.isInternTitle(title)) continue;
      seen.add(sid);
      items.push({
        sid,
        title,
        url: `https://${host}/careers/details/${slug}/`,
        company: SITES[site].company,
        locations,
        postedAt: null,
        comp: null,
      });
    }
    if (!urls.length) throw new Error(`citadel: empty sitemap for ${host}`);
    return { complete: true, items };
  },
};
