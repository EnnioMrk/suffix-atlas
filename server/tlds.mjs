import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { domainToUnicode, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cachePath = path.join(here, '..', 'data', 'tlds.json');
const IANA_URL = 'https://data.iana.org/TLD/tlds-alpha-by-domain.txt';

// Multi-level registries where a brand commonly owns a name, e.g. google.co.uk.
// Kept deliberately finite: a scan has to finish in seconds, not minutes.
const SECOND_LEVEL = [
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au', 'id.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz', 'geek.nz',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'ed.jp', 'gr.jp', 'lg.jp',
  'co.in', 'net.in', 'org.in', 'firm.in', 'gen.in', 'ind.in', 'ac.in', 'gov.in', 'nic.in',
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br', 'art.br', 'blog.br',
  'com.mx', 'org.mx', 'net.mx', 'gob.mx', 'edu.mx',
  'com.ar', 'net.ar', 'org.ar', 'gob.ar', 'edu.ar',
  'com.tr', 'net.tr', 'org.tr', 'gov.tr', 'edu.tr', 'av.tr', 'bel.tr',
  'co.za', 'net.za', 'org.za', 'gov.za', 'ac.za', 'web.za',
  'com.sg', 'net.sg', 'org.sg', 'edu.sg', 'gov.sg', 'per.sg',
  'com.hk', 'net.hk', 'org.hk', 'edu.hk', 'gov.hk', 'idv.hk',
  'com.tw', 'net.tw', 'org.tw', 'edu.tw', 'gov.tw', 'idv.tw',
  'co.kr', 'or.kr', 'ne.kr', 'go.kr', 'ac.kr', 're.kr',
  'co.id', 'net.id', 'or.id', 'web.id', 'go.id', 'ac.id', 'sch.id',
  'com.my', 'net.my', 'org.my', 'gov.my', 'edu.my',
  'com.ph', 'net.ph', 'org.ph', 'gov.ph', 'edu.ph',
  'com.vn', 'net.vn', 'org.vn', 'gov.vn', 'edu.vn',
  'com.pk', 'net.pk', 'org.pk', 'gov.pk', 'edu.pk',
  'com.eg', 'net.eg', 'org.eg', 'gov.eg', 'edu.eg',
  'com.sa', 'net.sa', 'org.sa', 'gov.sa', 'edu.sa',
  'co.ae', 'net.ae', 'org.ae', 'ac.ae', 'gov.ae',
  'com.ua', 'net.ua', 'org.ua', 'gov.ua', 'edu.ua',
  'com.pl', 'net.pl', 'org.pl', 'edu.pl', 'gov.pl',
  'co.il', 'org.il', 'net.il', 'ac.il', 'gov.il', 'muni.il',
  'co.th', 'in.th', 'or.th', 'ac.th', 'go.th', 'mi.th',
  'com.co', 'net.co', 'org.co', 'edu.co', 'gov.co',
  'com.pe', 'net.pe', 'org.pe', 'edu.pe', 'gob.pe',
  'com.ve', 'net.ve', 'org.ve', 'co.ve',
  'com.ec', 'net.ec', 'org.ec',
  'com.uy', 'net.uy', 'org.uy', 'edu.uy', 'gub.uy',
  'com.py', 'net.py', 'org.py', 'edu.py', 'gov.py',
  'com.bo', 'net.bo', 'org.bo', 'edu.bo', 'gob.bo',
  'com.do', 'net.do', 'org.do', 'edu.do', 'gob.do',
  'com.gt', 'net.gt', 'org.gt', 'edu.gt', 'gob.gt',
  'com.pa', 'net.pa', 'org.pa', 'edu.pa', 'gob.pa',
  'com.ng', 'net.ng', 'org.ng', 'edu.ng', 'gov.ng',
  'com.gh', 'net.gh', 'org.gh', 'edu.gh', 'gov.gh',
  'co.ke', 'or.ke', 'ne.ke', 'go.ke', 'ac.ke', 'sc.ke',
  'co.tz', 'or.tz', 'ne.tz', 'go.tz', 'ac.tz',
  'co.ug', 'or.ug', 'ne.ug', 'go.ug', 'ac.ug', 'sc.ug',
  'com.bd', 'net.bd', 'org.bd', 'edu.bd', 'gov.bd',
  'com.np', 'net.np', 'org.np', 'edu.np', 'gov.np',
  'com.lk', 'net.lk', 'org.lk', 'edu.lk', 'gov.lk',
  'com.kh', 'net.kh', 'org.kh', 'edu.kh', 'gov.kh',
  'com.mm', 'net.mm', 'org.mm', 'edu.mm', 'gov.mm',
  'com.qa', 'net.qa', 'org.qa', 'edu.qa', 'gov.qa',
  'com.kw', 'net.kw', 'org.kw', 'edu.kw', 'gov.kw',
  'com.bh', 'net.bh', 'org.bh', 'edu.bh', 'gov.bh',
  'com.om', 'net.om', 'org.om', 'edu.om', 'gov.om',
  'com.jo', 'net.jo', 'org.jo', 'edu.jo', 'gov.jo',
  'com.lb', 'net.lb', 'org.lb', 'edu.lb', 'gov.lb',
  'com.cy', 'net.cy', 'org.cy', 'ac.cy', 'gov.cy',
  'com.mt', 'net.mt', 'org.mt', 'edu.mt', 'gov.mt',
  'com.gr', 'net.gr', 'org.gr', 'edu.gr', 'gov.gr',
  'com.pt', 'com.es', 'nom.es', 'org.es', 'gob.es', 'edu.es',
  'com.ru', 'net.ru', 'org.ru', 'pp.ru',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'co.at', 'or.at', 'ac.at', 'gv.at',
  'co.no', 'priv.no',
  'co.cz', 'com.ro', 'net.ro', 'org.ro', 'co.ro',
  'com.hr', 'com.rs', 'net.rs', 'org.rs', 'edu.rs', 'gov.rs',
  'com.ba', 'net.ba', 'org.ba', 'edu.ba', 'gov.ba',
  'com.mk', 'net.mk', 'org.mk', 'edu.mk', 'gov.mk',
  'com.al', 'net.al', 'org.al', 'edu.al', 'gov.al',
  'com.ee', 'org.ee', 'net.ee',
  'com.lv', 'net.lv', 'org.lv', 'edu.lv', 'gov.lv',
  'com.lt', 'net.lt', 'org.lt', 'edu.lt', 'gov.lt',
  'com.by', 'net.by', 'org.by', 'gov.by',
  'com.kz', 'net.kz', 'org.kz', 'edu.kz', 'gov.kz',
  'com.uz', 'net.uz', 'org.uz', 'co.uz',
  'com.az', 'net.az', 'org.az', 'edu.az', 'gov.az',
  'com.ge', 'net.ge', 'org.ge', 'edu.ge', 'gov.ge',
  'com.am', 'net.am', 'org.am', 'edu.am', 'gov.am',
  'com.md', 'net.md', 'org.md', 'edu.md', 'gov.md',
  'com.tm', 'net.tm', 'org.tm', 'edu.tm', 'gov.tm',
  'com.kg', 'net.kg', 'org.kg', 'edu.kg', 'gov.kg',
  'com.tj', 'net.tj', 'org.tj', 'edu.tj', 'gov.tj',
  'com.mn', 'net.mn', 'org.mn', 'edu.mn', 'gov.mn',
  'com.mo', 'net.mo', 'org.mo', 'edu.mo', 'gov.mo',
  'com.bn', 'net.bn', 'org.bn', 'edu.bn', 'gov.bn',
  'com.mv', 'net.mv', 'org.mv', 'edu.mv', 'gov.mv',
  'com.fj', 'net.fj', 'org.fj', 'ac.fj', 'gov.fj',
  'com.pg', 'net.pg', 'org.pg', 'ac.pg', 'gov.pg',
  'com.sb', 'net.sb', 'org.sb', 'edu.sb', 'gov.sb',
  'com.ws', 'net.ws', 'org.ws', 'edu.ws', 'gov.ws',
  'com.to', 'net.to', 'org.to', 'edu.to', 'gov.to',
  'com.tv', 'net.tv', 'org.tv', 'edu.tv', 'gov.tv',
  'com.fm', 'net.fm', 'org.fm', 'edu.fm', 'gov.fm',
];

const FALLBACK = [
  'com', 'org', 'net', 'edu', 'gov', 'mil', 'int', 'io', 'ai', 'co', 'dev', 'app',
  'site', 'online', 'xyz', 'info', 'biz', 'me', 'tv', 'cc', 'us', 'uk', 'de', 'fr',
  'jp', 'cn', 'in', 'br', 'au', 'ca', 'ch', 'nl', 'se', 'no', 'es', 'it', 'ru',
  'za', 'mx', 'ar', 'tr', 'sg', 'hk', 'tw', 'kr', 'id', 'my', 'ph', 'vn', 'pk',
  'eg', 'sa', 'ae', 'ua', 'pl', 'il', 'th', 'co', 'pe', 'cl', 've', 'ng', 'ke',
  'museum', 'aero', 'coop', 'jobs', 'mobi', 'travel', 'pro', 'name', 'cat',
  'academy', 'agency', 'art', 'blog', 'cloud', 'club', 'design', 'digital',
  'email', 'finance', 'global', 'group', 'health', 'legal', 'life', 'live',
  'media', 'news', 'ninja', 'photography', 'shop', 'store', 'studio', 'tech',
  'today', 'tools', 'world', 'zone', 'sucks', 'rocks', 'cool', 'fun', 'guru',
  'space', 'website', 'wiki', 'work', 'works', 'company', 'center', 'city',
];

let index = null;
let loading = null;

function unicodeSuffix(suffix) {
  if (!suffix.startsWith('xn--') && !suffix.includes('.xn--')) return suffix;
  try {
    return domainToUnicode(`x.${suffix}`).slice(2);
  } catch {
    return suffix;
  }
}

function makeIndex(tlds, meta) {
  const seen = new Set();
  const suffixes = [];
  for (const tld of tlds) {
    if (!tld || seen.has(tld)) continue;
    seen.add(tld);
    suffixes.push({ ascii: tld, display: unicodeSuffix(tld), type: 'tld', index: suffixes.length });
  }
  for (const second of SECOND_LEVEL) {
    if (seen.has(second)) continue;
    seen.add(second);
    suffixes.push({ ascii: second, display: second, type: 'multi', index: suffixes.length });
  }
  return { suffixes, meta: { ...meta, total: suffixes.length, tlds: tlds.length, multiLevel: SECOND_LEVEL.length } };
}

async function fetchIana() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch(IANA_URL, { signal: controller.signal, headers: { 'user-agent': 'SuffixAtlas/1.0' } });
    if (!response.ok) throw new Error(`IANA returned ${response.status}`);
    const text = await response.text();
    const tlds = text.trim().split(/\r?\n/).slice(1).map((line) => line.trim().toLowerCase()).filter(Boolean);
    if (tlds.length < 100) throw new Error('IANA list too short');
    return { tlds, fetchedAt: new Date().toISOString(), source: 'IANA' };
  } finally {
    clearTimeout(timer);
  }
}

async function readCache() {
  try {
    const raw = await readFile(cachePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.tlds) || parsed.tlds.length < 100) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function saveCache(data) {
  try {
    await writeFile(cachePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  } catch {
    // A read-only deployment can still run on the cache it has.
  }
}

export async function getSuffixIndex() {
  if (index) return index;
  if (loading) return loading;
  loading = (async () => {
    const cached = await readCache();
    let payload = cached;
    let source = cached?.source || 'IANA';
    let fetchedAt = cached?.fetchedAt || null;
    if (!cached || Date.now() - new Date(cached.fetchedAt).getTime() > 7 * 24 * 60 * 60 * 1000) {
      try {
        const fresh = await fetchIana();
        payload = fresh;
        source = 'IANA';
        fetchedAt = fresh.fetchedAt;
        await saveCache(fresh);
      } catch {
        if (!cached) {
          payload = { tlds: FALLBACK, fetchedAt: new Date().toISOString(), source: 'built-in' };
          source = 'built-in';
          fetchedAt = payload.fetchedAt;
        } else {
          source = 'cache';
        }
      }
    }
    index = makeIndex(payload.tlds, { source, fetchedAt });
    return index;
  })();
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

export function normalizeTerm(input) {
  if (typeof input !== 'string') return { error: 'Enter a word to scan.' };
  let term = input.trim().toLowerCase();
  term = term.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
  if (!term) return { error: 'Enter a word to scan.' };
  if (term.length > 63) return { error: 'Keep the word to 63 characters or fewer.' };
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(term)) {
    return { error: 'Use one word: letters, numbers, or hyphens. No spaces or dots.' };
  }
  return { term };
}
