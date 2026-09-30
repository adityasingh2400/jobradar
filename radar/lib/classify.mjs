// Title/location classification shared by every source.
// Everything here is pure and deterministic so the Mac and GitHub runners agree.

import { readFileSync } from 'node:fs';

const INTERN_RE = new RegExp(
  [
    String.raw`\bintern(s|ship|ships)?\b`,
    String.raw`\bco-?op\b`,
    String.raw`\bcoop\b`,
    String.raw`\bapprentice(ship)?\b`,
    String.raw`\btrainee(ship)?\b`,
    String.raw`\bworking student\b`,
    String.raw`\bwerkstudent`,
    String.raw`\bpraktikum\b`,
    String.raw`\bsummer (analyst|associate|engineer|student|scholar|fellow|program|internship|research)`,
    String.raw`\bstudent (researcher|engineer|developer|programmer|worker|associate)\b`,
    String.raw`\b(undergrad(uate)?|campus) (program|student|intern)`,
    String.raw`\bexplore (program|intern)`,
  ].join('|'),
  'i',
);

/** True for internship / co-op titles; false for recruiters, coordinators and senior roles that mention interns. */
export function isInternTitle(title = '') {
  const t = String(title);
  if (!INTERN_RE.test(t)) return false;
  if (/\b(recruit(er|ing)|coordinator|talent acquisition|supervisor)\b/i.test(t)) return false;
  if (/\b(senior|sr\.?|staff|principal|director|head of|vice president|vp)\b/i.test(t)) return false;
  if (/\b(university|campus|early careers?|intern(ship)?s?) (relations|programs?) (manager|lead|partner|specialist)\b/i.test(t)) return false;
  return true;
}

// ---------- degree level ----------
export function degreeTag(title = '') {
  const t = String(title);
  if (/\b(bachelor'?s?|undergrad(uate)?|b\.?s\.?\b|bs\/ms)\b/i.test(t)) return '';
  if (/\b(ph\.?\s?d|doctoral|doctorate|post-?doc)\b/i.test(t)) return 'phd';
  if (/\bmba\b/i.test(t)) return 'mba';
  if (/\b(master'?s|m\.?s\.? student|graduate student)\b/i.test(t)) return 'ms';
  return '';
}

// ---------- season ----------
const SEASON_WORD = { winter: 'Winter', spring: 'Spring', summer: 'Summer', fall: 'Fall', autumn: 'Fall' };
const SEASON_MONTH = { Winter: 1, Spring: 3, Summer: 6, Fall: 9 };

function normYear(y) {
  const n = Number(String(y).replace("'", ''));
  return n < 100 ? 2000 + n : n;
}

/** Returns e.g. "Summer 2027", "Fall 2026", "2027", "Summer", or "" */
export function seasonOf(title = '', terms = []) {
  for (const term of terms || []) {
    const s = seasonOf(String(term));
    if (s) return s;
  }
  const t = String(title);
  let m = t.match(/\b(summer|fall|autumn|winter|spring)\s*[-/,]?\s*('?\d{2}|20\d{2})\b/i);
  if (m) return `${SEASON_WORD[m[1].toLowerCase()]} ${normYear(m[2])}`;
  m = t.match(/\b(20\d{2})\s*[-/,]?\s*(summer|fall|autumn|winter|spring)\b/i);
  if (m) return `${SEASON_WORD[m[2].toLowerCase()]} ${m[1]}`;
  const sw = t.match(/\b(summer|fall|autumn|winter|spring)\b/i);
  const yr = t.match(/\b(202[5-9]|203\d)\b/);
  if (sw && yr) return `${SEASON_WORD[sw[1].toLowerCase()]} ${yr[1]}`;
  if (yr) return yr[1];
  if (sw) return SEASON_WORD[sw[1].toLowerCase()];
  return '';
}

/** Month index (year*12+month) for season strings, or null when unknown. */
export function seasonStart(season = '') {
  let m = String(season).match(/^(Winter|Spring|Summer|Fall) (\d{4})$/);
  if (m) return Number(m[2]) * 12 + SEASON_MONTH[m[1]];
  m = String(season).match(/^(\d{4})$/);
  if (m) return Number(m[1]) * 12 + 12; // year only: could start any time that year (co-ops, rolling)
  return null;
}

/** Keep roles that start at/after minStart ("YYYY-MM"); unknown seasons are kept. */
export function seasonOk(season, minStart = '2026-11') {
  const s = seasonStart(season);
  if (s == null) return true;
  const [y, mo] = minStart.split('-').map(Number);
  return s >= y * 12 + mo;
}

export function isCoop(title = '', season = '') {
  return /\bco-?op\b|\bcoop\b/i.test(title) || /^(Fall|Winter|Spring) /.test(season);
}

// ---------- categories ----------
const CAT_RULES = [
  ['quant', /\b(quant|quantitative|trad(ing|er)|algorithmic|market mak(er|ing))\b/i],
  ['ai', /\b(machine learning|ml|ai|a\.i\.|artificial intelligence|deep learning|(?<!(market|clinical|policy|legal|economic|user|ux) )research(er|ers)?|applied scien\w*|data scien\w*|nlp|natural language|computer vision|llms?|gen ?ai|generative|reinforcement learning|robot learning|perception|autopilot|self-driving|mlops|foundation models?|multimodal|recommend(er|ation)s?|autonomy|autonomous|speech|inference|neural)\b/i],
  ['data', /\b(data|analytics|business intelligence|bi engineer|big data|etl)\b/i],
  ['hw', /\b(data cent(er|re)s?|hardware|asic|fpga|rtl|vlsi|silicon|chip|soc|embedded|firmware|electrical|electronics?|circuits?|analog|mixed[- ]signal|rf|pcb|verification|robotics|mechatronics|semiconductor|photonics|optical|power electronics|gpu|cpu|computer architecture|dsp)\b/i],
  ['swe', /\b(software|swe|sde|developer|development engineer|programmer|programming|backend|back[- ]end|frontend|front[- ]end|full[- ]?stack|mobile|ios|android|web|platform|infra|infrastructure|cloud|devops|sre|site reliability|security|cyber\w*|systems?|distributed|compiler|kernel|game|graphics|tools|automation|qa|test engineer|sdet|database|computer science|cs|coding|technology|technical|it)\b/i],
  ['pm', /\b(product manag\w*|product intern|associate product|apm|technical program|tpm|program manag\w*|product design\w*|ux|ui\/ux|designer)\b/i],
];
const OTHER_ENG_RE =
  /\b(mechanical|civil|chemical|manufacturing|process|industrial|structural|environmental|materials|biomedical|aerospace|nuclear|petroleum|mining|field|facilities|construction|quality|supply chain|packaging|plant|maintenance|geotechnical|water|hvac)\b/i;
const NON_TECH_RE =
  /\b(marketing|sales|account (executive|manager)|human resources|hr|people (ops|operations|partner)|recruit\w*|talent|finance|financial analyst|accounting|accountant|audit|tax|legal|paralegal|law|communications|public relations|pr|content|social media|brand|events?|business development|customer|support|operations intern|retail|store|merchandis\w*|nurs\w*|clinical|pharmac\w*|medical|healthcare|real estate|procurement|purchasing|logistics|policy|government affairs|writer|editor|journalis\w*|video|photograph\w*|creative|graphic design|fashion|hospitality|culinary|teacher|tutor)\b/i;

const SIMPLIFY_CAT = {
  software: 'swe', 'software engineering': 'swe',
  'ai/ml/data': 'ai', 'data science, ai & machine learning': 'ai',
  hardware: 'hw', 'hardware engineering': 'hw',
  quant: 'quant', 'quantitative finance': 'quant',
  product: 'pm', 'product management': 'pm',
};

/** Returns an array like ['swe','ai'], or ['other']. `hint` is an aggregator category label. */
export function categoriesOf(title = '', hint = '') {
  const t = String(title);
  const cats = new Set();
  const h = SIMPLIFY_CAT[String(hint || '').toLowerCase()];
  if (h) cats.add(h);
  for (const [cat, re] of CAT_RULES) if (re.test(t)) cats.add(cat);
  if (cats.size === 0 && /\bengineer(ing)?\b/i.test(t) && !OTHER_ENG_RE.test(t)) cats.add('swe');
  // "Engineering Intern" at a software company is SWE; "Mechanical Engineering Intern" is not.
  if (cats.has('swe') && OTHER_ENG_RE.test(t) && !/\b(software|developer|programm\w*|computer)\b/i.test(t) && !h) cats.delete('swe');
  if (cats.size && NON_TECH_RE.test(t) && !/\b(engineer\w*|software|developer|data|machine learning|ai|research|scien\w*|quant\w*|technical|product manag\w*)\b/i.test(t) && !h) {
    cats.clear();
  }
  return cats.size ? [...cats] : ['other'];
}

export const TECH_CATS = new Set(['swe', 'ai', 'data', 'quant', 'hw', 'pm']);

const TECH_WORD_RE = /\b(engineer\w*|software|developer|data|machine learning|ai|research\w*|scien\w*|quant\w*|technical|technology|product manag\w*|computer|robot\w*|autonom\w*)\b/i;

/**
 * Titles we can confidently say are not tech (marketing, HR, finance, mechanical engineering, ...).
 * Direct career-site sources drop these; ambiguous titles ("Autopilot Intern") are kept as 'other'.
 */
export function isClearlyNonTech(title = '') {
  const t = String(title);
  if (TECH_WORD_RE.test(t) && !OTHER_ENG_RE.test(t)) return false;
  if (NON_TECH_RE.test(t) && !TECH_WORD_RE.test(t)) return true;
  return OTHER_ENG_RE.test(t) && !/\b(software|developer|programm\w*|computer|data|machine learning|ai)\b/i.test(t);
}

// ---------- locations ----------
const US_STATES = 'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC';
const US_STATE_RE = new RegExp(String.raw`(^|,\s*|\s-\s|\s)(${US_STATES})(\s*\d{5})?(\s*,\s*(US|USA|United States))?\s*$`);
const US_STATE_NAMES_RE = /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)\b/i;
const US_WORDS_RE = /\b(united states|usa|u\.s\.a?\.?|us|america|nyc|sf|bay area|silicon valley|san francisco|new york|seattle|austin|boston|chicago|los angeles|mountain view|palo alto|menlo park|sunnyvale|san jose|redmond|bellevue|denver|atlanta|pittsburgh|philadelphia|san diego|santa clara|cupertino|miami|dallas|houston|portland|salt lake|raleigh|durham|detroit|minneapolis|phoenix|nashville|boulder|irvine|santa monica|culver city|oakland|berkeley|princeton|ann arbor|madison|columbus|st\.? louis|kansas city|charlotte|baltimore|arlington|reston|mclean|herndon|huntsville|orlando|tampa|jersey city|hoboken|stamford|greenwich|brooklyn|manhattan|washington,? d\.?c\.?|santa barbara|goleta|san mateo|redwood city|foster city|south san francisco|burlingame|emeryville|el segundo|hawthorne|long beach|pasadena|sacramento|fremont|milpitas|kirkland|cambridge, ma|somerville|waltham|new haven|providence|hartford|richmond|norfolk|annapolis|columbia, md|fort worth|san antonio|el paso|albuquerque|tucson|scottsdale|tempe|chandler|las vegas|reno|boise|spokane|anchorage|honolulu|omaha|des moines|milwaukee|indianapolis|cincinnati|cleveland|louisville|memphis|new orleans|birmingham|jacksonville|fort lauderdale|west palm|boca raton|savannah|greenville|knoxville|chattanooga|lexington|dayton|akron|buffalo|rochester|syracuse|albany|newark|trenton|wilmington|dover)\b/i;
const CANADA_RE = /\b(canada|toronto|vancouver|montr[eé]al|ottawa|waterloo|calgary|edmonton|winnipeg|halifax|quebec|ontario|british columbia|alberta|kitchener|mississauga|burnaby|victoria, bc)\b|,\s*(ON|BC|QC|AB|MB|NS|NB|SK|NL|PE)(\s*,\s*(CA|Canada))?\s*$/i;
const INTL_RE = /\b(india|bengaluru|bangalore|hyderabad|pune|chennai|mumbai|delhi|gurgaon|gurugram|noida|london|united kingdom|uk|england|scotland|edinburgh|manchester|ireland|dublin|germany|berlin|munich|m[uü]nchen|hamburg|frankfurt|stuttgart|france|paris|netherlands|amsterdam|switzerland|z[uü]rich|geneva|spain|madrid|barcelona|italy|milan|rome|portugal|lisbon|belgium|brussels|austria|vienna|poland|warsaw|krak[oó]w|wroc[lł]aw|czech|prague|romania|bucharest|hungary|budapest|sweden|stockholm|denmark|copenhagen|norway|oslo|finland|helsinki|estonia|israel|tel aviv|singapore|japan|tokyo|china|shanghai|beijing|shenzhen|hangzhou|guangzhou|hong kong|taiwan|taipei|hsinchu|korea|seoul|australia|sydney|melbourne|new zealand|mexico|guadalajara|brazil|s[aã]o paulo|argentina|buenos aires|chile|colombia|bogot[aá]|costa rica|philippines|manila|vietnam|malaysia|kuala lumpur|indonesia|jakarta|thailand|bangkok|uae|dubai|abu dhabi|saudi|riyadh|egypt|cairo|nigeria|lagos|kenya|nairobi|south africa|cape town|johannesburg|turkey|istanbul|serbia|belgrade|ukraine|kyiv|greece|athens|luxembourg|emea|apac|latam|europe)\b/i;

// Country codes that don't collide with US state abbreviations (so "CO" stays Colorado).
const INTL_ISO2_TAIL = /,\s*(IE|ES|MX|NZ|GB|UK|FR|CN|JP|KR|SG|AU|BR|NL|PL|IL|CH|SE|IT|PT|BE|AT|DK|NO|FI|CZ|RO|HU|GR|TR|AE|ZA|PH|MY|TH|VN|TW|HK|CL|PE|CR|EG|NG|KE|SK|BG|HR|RS|UA|EE|LV|LT|LU|IS|QA|SA|PK|BD|LK|UY|EC|BO|DO|JM|PR)\s*$/;
const INTL_ISO3 = /\b(CHN|THA|SGP|MYS|IND|GBR|DEU|FRA|JPN|KOR|AUS|BRA|NLD|POL|ISR|CHE|SWE|ITA|ESP|PRT|BEL|AUT|DNK|NOR|FIN|CZE|ROU|HUN|GRC|TUR|ARE|ZAF|PHL|VNM|IDN|TWN|HKG|ARG|CHL|COL|PER|CRI|MEX|IRL|NZL|SVK|BGR|HRV|SRB|UKR|EST|LVA|LTU|LUX|EGY|MAR|NGA|KEN|PAK|SAU|QAT)\b/;
const MORE_COUNTRIES_RE = /\b(peru|morocco|qatar|bahrain|kuwait|oman|lebanon|pakistan|bangladesh|sri lanka|nepal|ghana|ethiopia|uganda|tanzania|rwanda|tunisia|algeria|ecuador|uruguay|paraguay|bolivia|venezuela|guatemala|panama|el salvador|honduras|nicaragua|dominican republic|jamaica|iceland|latvia|lithuania|slovakia|slovak republic|slovenia|croatia|bulgaria|cyprus|malta|bosnia|macedonia|albania|belarus|russia|kazakhstan|uzbekistan|armenia|azerbaijan|mongolia|cambodia|myanmar|laos|brunei|macau|macao|mauritius|senegal|cameroon|zambia|zimbabwe|botswana|namibia|angola|mozambique|ivory coast|c[oô]te d'ivoire|trinidad|barbados|bahamas|kosovo|montenegro|moldova|england|wales|northern ireland)\b/i;
const INTL_WORDS_RE = /\b(kraj|provincia|prov[ií]ncia|prefecture|voivodeship|oblast|bundesland|kanton|departamento|comunidad de madrid|île-de-france|eindhoven|cork|galway|limerick|suzhou|wuxi|tianjin|dalian|chengdu|xi'?an|wuhan|nanjing|quezon|makati|cebu|belo horizonte|campinas|curitiba|monterrey|tijuana|guadalajara|casablanca|aarhus|auckland|wellington|ditzingen|gratkorn|martos|samut prakan|penang|petaling jaya|cyberjaya|johor|hanoi|ho chi minh|kaohsiung|taichung|tainan|yokohama|osaka|kyoto|busan|incheon|pangyo|gurugram|noida|ahmedabad|kolkata|kochi|coimbatore|thiruvananthapuram|mysore|jaipur|chandigarh|lisboa|porto|sevilla|valencia|bilbao|lyon|toulouse|grenoble|nice|sophia antipolis|eschborn|darmstadt|karlsruhe|nuremberg|n[uü]rnberg|cologne|k[oö]ln|d[uü]sseldorf|leipzig|dresden|heidelberg|mannheim|erlangen|wroc[lł]aw|gda[nń]sk|pozna[nń]|brno|ostrava|bratislava|ko[sš]ice|cluj|timi[sș]oara|ia[sș]i|sofia|zagreb|ljubljana|tallinn|riga|vilnius|reykjav[ií]k|gothenburg|g[oö]teborg|malm[oö]|lund|espoo|tampere|bergen|trondheim|odense|aalborg|antwerp|ghent|leuven|rotterdam|utrecht|the hague|den haag|delft|haifa|herzliya|petah tikva|ra'?anana|jerusalem|doha|jeddah|dammam|abu dhabi|sharjah|nairobi|lagos|accra|kigali)\b/i;

/** 'us' | 'remote' | 'ca' | 'intl' | '' */
export function regionOf(loc = '') {
  const l = String(loc).replace(/<br\s*\/?>/gi, ' ').trim();
  if (!l) return '';
  const remote = /\bremote(ly)?\b|\banywhere\b|\bwork from home\b|\bdistributed\b|\bvirtual\b/i.test(l);
  if (/\b(united states( of america)?|usa|u\.s\.a?\.?)\b/i.test(l) && !CANADA_RE.test(l)) return 'us';
  if (/\bCAN\b/.test(l) || /\b[A-Z]\d[A-Z] ?\d[A-Z]\d\b/.test(l)) return 'ca';
  if (US_STATE_RE.test(l) && !CANADA_RE.test(l) && !INTL_ISO2_TAIL.test(l)) return 'us';
  if (CANADA_RE.test(l)) return remote && /\b(us|usa|united states)\b/i.test(l) ? 'us' : 'ca';
  if (INTL_RE.test(l) || MORE_COUNTRIES_RE.test(l) || INTL_WORDS_RE.test(l) || INTL_ISO2_TAIL.test(l) || INTL_ISO3.test(l)) return 'intl';
  // Postal-code shapes: "821 04" (CZ/SK/SE/GR), 6 digits (IN/CN/SG/CR…), UK postcodes, Irish Eircodes.
  if (/\b\d{3} \d{2}\b|\b\d{6}\b|\b[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}\b|\b[A-Z]\d{2} [A-Z\d]{4}\b/.test(l)) return 'intl';
  if (/^(US|USA|U\.S\.)\s*[-,:]/i.test(l) || new RegExp(`^(${US_STATES})(\\s+[A-Z][a-z]|-)`).test(l)) return 'us';
  if (US_STATE_NAMES_RE.test(l) || US_WORDS_RE.test(l) || /\b\d{5}(-\d{4})?\b/.test(l)) return 'us';
  if (remote) return 'remote';
  return '';
}

/** Summarize a location list: { us, remote, ca, intl } booleans. */
export function regionsOf(locs = []) {
  const out = { us: false, remote: false, ca: false, intl: false };
  for (const l of locs) {
    const r = regionOf(l);
    if (r) out[r] = true;
    if (/\bremote(ly)?\b/i.test(l)) out.remote = true;
  }
  return out;
}

// ---------- names & keys ----------
export function normCompany(name = '') {
  return String(name)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|plc|gmbh|s\.?a|ag|holdings|group|the)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

export function normTitle(title = '') {
  return String(title)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export const fuzzyKey = (company, title) => `${normCompany(company)}|${normTitle(title)}`;

// ---------- tiers ----------
let TIERS = null;
function loadTiers() {
  if (TIERS) return TIERS;
  TIERS = new Map();
  try {
    const raw = JSON.parse(readFileSync(new URL('../../config/tiers.json', import.meta.url), 'utf8'));
    for (const [tier, names] of Object.entries(raw)) {
      if (tier.startsWith('_')) continue;
      for (const n of names) TIERS.set(normCompany(n), tier);
    }
  } catch { /* tiers are optional */ }
  return TIERS;
}

export function tierOf(company = '') {
  return loadTiers().get(normCompany(company)) || '';
}
