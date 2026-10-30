import dns from 'node:dns/promises';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const resolver = new dns.Resolver({ timeout: 2800, tries: 1 });
const wildcardResolver = new dns.Resolver({ timeout: 5000, tries: 2 });
const USER_AGENT = 'Mozilla/5.0 (compatible; SuffixAtlas/1.0; domain-reachability-check)';
const DNS_CONCURRENCY = 90;
const WILDCARD_CONCURRENCY = 6;
const PROBE_CONCURRENCY = 42;
const PROBE_TIMEOUT = 4200;
const FALLBACK_TIMEOUT = 2500;
const MAX_REDIRECTS = 4;
const WILDCARD_TTL = 24 * 60 * 60 * 1000;
const wildcardCache = new Map();
const wildcardChecks = new Map();

function isPublicIp(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const octets = address.split('.').map(Number);
    const [a, b, c] = octets;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
    if (a === 192 && b === 168) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    if (a >= 224) return false;
    return true;
  }
  if (family === 6) {
    const value = address.toLowerCase();
    if (value === '::' || value === '::1') return false;
    if (value.startsWith('fc') || value.startsWith('fd')) return false;
    if (/^fe[89ab]/.test(value)) return false;
    if (value.startsWith('ff')) return false;
    if (value.startsWith('2001:db8')) return false;
    const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicIp(mapped[1]);
    return true;
  }
  return false;
}

async function resolveWildcard(domain) {
  try {
    return { addresses: await wildcardResolver.resolve4(domain) };
  } catch (error) {
    return { error: error.code || 'DNS_ERROR' };
  }
}

async function isWildcardSuffix(suffix) {
  const cached = wildcardCache.get(suffix);
  if (cached && Date.now() - cached.at < WILDCARD_TTL) return cached.value;
  if (wildcardChecks.has(suffix)) return wildcardChecks.get(suffix);

  const check = (async () => {
    let value = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const label = `atlas-wildcard-${randomBytes(8).toString('hex')}`;
      const result = await resolveWildcard(`${label}.${suffix}`);
      if (result.addresses?.length) {
        value = true;
        break;
      }
      if (['ENOTFOUND', 'ENODATA', 'ENODOMAIN'].includes(result.error)) break;
      await new Promise((resolve) => setTimeout(resolve, 180));
    }
    wildcardCache.set(suffix, { value, at: Date.now() });
    return value;
  })().finally(() => wildcardChecks.delete(suffix));

  wildcardChecks.set(suffix, check);
  return check;
}

async function resolveDomain(domain) {
  // IPv4 is deliberate: this host can reach IPv4 reliably, while an IPv6
  // route failure must not become an unhandled socket error.
  let records = [];
  try {
    records = await resolver.resolve4(domain);
  } catch {
    return [];
  }
  const addresses = [];
  const seen = new Set();
  for (const address of records) {
    if (!isPublicIp(address) || seen.has(address)) continue;
    seen.add(address);
    addresses.push({ address, family: 4 });
  }
  return addresses;
}

function requestOnce(urlString, addresses, timeout) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch {
      resolve({ error: 'BAD_URL', note: 'Invalid redirect target.' });
      return;
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      resolve({ error: 'BAD_URL', note: 'Unsupported redirect target.' });
      return;
    }
    if (!addresses.some((address) => address.family === 4)) {
      resolve({ error: 'NO_ADDRESS', note: 'No public IPv4 address.' });
      return;
    }

    const secure = parsed.protocol === 'https:';
    const module = secure ? https : http;
    const started = Date.now();
    let settled = false;
    let timer;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };

    const options = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (secure ? 443 : 80),
      path: `${parsed.pathname || '/'}${parsed.search || ''}`,
      method: 'GET',
      headers: {
        host: parsed.host,
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'accept-encoding': 'identity',
        connection: 'close',
      },
      timeout,
      rejectUnauthorized: true,
      family: 4,
      autoSelectFamily: false,
      lookup: (hostname, lookupOptions, callback) => {
        const chosen = addresses.find((address) => address.family === 4);
        if (!chosen) {
          callback(Object.assign(new Error('No public address'), { code: 'ENOTFOUND' }));
          return;
        }
        if (lookupOptions?.all) callback(null, [chosen]);
        else callback(null, chosen.address, chosen.family);
      },
    };
    if (secure) options.servername = parsed.hostname;

    const request = module.request(options, (response) => {
      const location = response.headers.location || null;
      const payload = {
        url: parsed.href,
        status: response.statusCode || 0,
        location,
        ms: Date.now() - started,
        headers: {
          server: response.headers.server || null,
          type: response.headers['content-type'] || null,
        },
      };
      response.on('error', () => {});
      response.destroy();
      finish(payload);
    });

    timer = setTimeout(() => {
      request.destroy(Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' }));
    }, timeout);

    request.on('socket', (socket) => {
      socket.on('error', () => {
        if (!settled) {
          finish({
            url: parsed.href,
            error: 'SOCKET_ERROR',
            note: 'No response.',
            ms: Date.now() - started,
          });
        }
      });
    });
    request.on('timeout', () => {
      request.destroy(Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' }));
    });
    request.on('error', (error) => {
      finish({
        url: parsed.href,
        error: error.code || 'REQUEST_FAILED',
        note: error.code === 'ETIMEDOUT' ? 'Timed out.' : 'No response.',
        ms: Date.now() - started,
      });
    });
    request.end();
  });
}

async function probeUrl(url, addresses, timeout = PROBE_TIMEOUT) {
  const attempts = addresses.slice(0, 2);
  let last = null;
  for (const address of attempts) {
    const result = await requestOnce(url, [address], timeout);
    last = result;
    if (result.status || result.error === 'BAD_URL') return result;
  }
  return last || { error: 'NO_ADDRESS', note: 'No public address.' };
}

function isSameSite(domain, hostname) {
  const target = hostname.toLowerCase().replace(/\.$/, '');
  const base = domain.toLowerCase().replace(/\.$/, '');
  if (target === base) return true;
  if (target === `www.${base}`) return true;
  if (base === `www.${target}`) return true;
  return false;
}

function redirectTarget(location, currentUrl) {
  try {
    const target = new URL(location, currentUrl);
    if (!['http:', 'https:'].includes(target.protocol)) return null;
    if (target.username || target.password) return null;
    return target;
  } catch {
    return null;
  }
}

function classifyStatus(status) {
  if (!status) return 'error';
  if (status >= 200 && status < 300) return 'live';
  if (status >= 300 && status < 400) return 'redirect';
  if (status === 401 || status === 403 || status === 429) return 'blocked';
  if (status === 404 || status === 410) return 'missing';
  return 'error';
}

async function followRedirects(domain, firstResult, firstAddresses) {
  let current = firstResult;
  let addresses = firstAddresses;
  const chain = [firstResult];
  let redirects = 0;

  for (let step = 0; step < MAX_REDIRECTS; step += 1) {
    if (!current.location) {
      return {
        category: 'external',
        status: current.status,
        statusText: 'Redirect with no target',
        redirectTo: null,
        finalUrl: current.url,
        redirects: 1,
        note: 'The server returned a redirect without a Location header.',
      };
    }
    const target = redirectTarget(current.location, current.url);
    if (!target) {
      return {
        category: 'external',
        status: current.status,
        statusText: 'Redirect',
        redirectTo: current.location,
        finalUrl: current.url,
        redirects: 1,
        note: 'The redirect target is not a safe HTTP address.',
      };
    }
    redirects += 1;

    if (!isSameSite(domain, target.hostname)) {
      return {
        category: 'external',
        status: current.status,
        statusText: 'Redirects away',
        redirectTo: target.href,
        finalUrl: target.href,
        redirects,
        note: `Leaves ${domain}.`,
      };
    }

    addresses = await resolveDomain(target.hostname);
    const next = await probeUrl(target.href, addresses, PROBE_TIMEOUT);
    chain.push(next);

    if (!next.status) {
      return {
        category: 'error',
        status: current.status,
        statusText: 'Redirect target failed',
        redirectTo: target.href,
        finalUrl: target.href,
        redirects,
        note: next.note || 'The redirect target did not answer.',
        latencyMs: next.ms || current.ms,
      };
    }

    if (next.status >= 300 && next.status < 400) {
      current = next;
      continue;
    }

    if (next.status >= 200 && next.status < 300) {
      return {
        category: 'canonical',
        status: next.status,
        statusText: 'Live after redirect',
        redirectTo: target.href,
        finalUrl: next.url,
        redirects,
        note: `Answers at ${target.hostname} after ${redirects} redirect${redirects === 1 ? '' : 's'}.`,
        latencyMs: next.ms,
      };
    }

    const kind = classifyStatus(next.status);
    return {
      category: kind === 'live' ? 'canonical' : kind,
      status: next.status,
      statusText: next.status === 404 ? 'Not found' : 'Answered',
      redirectTo: target.href,
      finalUrl: next.url,
      redirects,
      note: `Redirect target answered ${next.status}.`,
      latencyMs: next.ms,
    };
  }

  return {
    category: 'error',
    status: current.status,
    statusText: 'Redirect loop',
    redirectTo: current.location,
    finalUrl: current.url,
    redirects,
    note: 'More than four redirects.',
  };
}

async function probeSite(candidate, addresses) {
  const started = performance.now();
  const httpsResult = await probeUrl(`https://${candidate.ascii}/`, addresses, PROBE_TIMEOUT);

  if (httpsResult.status) {
    if (httpsResult.status >= 200 && httpsResult.status < 300) {
      return {
        ...candidate,
        category: 'direct',
        status: httpsResult.status,
        statusText: 'No redirect',
        redirectTo: null,
        finalUrl: httpsResult.url,
        https: true,
        redirects: 0,
        latencyMs: httpsResult.ms,
        note: 'Answered directly over HTTPS.',
      };
    }
    if (httpsResult.status >= 300 && httpsResult.status < 400) {
      const followed = await followRedirects(candidate.ascii, httpsResult, addresses);
      return {
        ...candidate,
        https: true,
        latencyMs: followed.latencyMs || httpsResult.ms,
        ...followed,
      };
    }
    const kind = classifyStatus(httpsResult.status);
    return {
      ...candidate,
      category: kind === 'live' ? 'direct' : kind,
      status: httpsResult.status,
      statusText: httpsResult.status === 404 ? 'Not found' : 'Answered',
      redirectTo: null,
      finalUrl: httpsResult.url,
      https: true,
      redirects: 0,
      latencyMs: httpsResult.ms,
      note: `HTTPS answered ${httpsResult.status}.`,
    };
  }

  const httpResult = await probeUrl(`http://${candidate.ascii}/`, addresses, FALLBACK_TIMEOUT);
  const totalMs = Math.round(performance.now() - started);
  if (httpResult.status && httpResult.status >= 200 && httpResult.status < 300) {
    return {
      ...candidate,
      category: 'insecure',
      status: httpResult.status,
      statusText: 'HTTP only',
      redirectTo: null,
      finalUrl: httpResult.url,
      https: false,
      redirects: 0,
      latencyMs: totalMs,
      note: 'Answers over HTTP, but HTTPS did not complete.',
    };
  }
  if (httpResult.status) {
    return {
      ...candidate,
      category: 'error',
      status: httpResult.status,
      statusText: 'HTTPS failed',
      redirectTo: httpResult.location || null,
      finalUrl: httpResult.url,
      https: false,
      redirects: 0,
      latencyMs: totalMs,
      note: `HTTPS failed; HTTP answered ${httpResult.status}.`,
    };
  }

  return {
    ...candidate,
    category: 'error',
    status: null,
    statusText: 'No answer',
    redirectTo: null,
    finalUrl: `https://${candidate.ascii}/`,
    https: false,
    redirects: 0,
    latencyMs: totalMs,
    note: httpsResult.note || httpResult.note || 'No HTTP response.',
  };
}

async function runPool(items, concurrency, worker) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
}

function summarise(results, startedAt, wildcards) {
  const counts = {
    found: results.length,
    direct: 0,
    canonical: 0,
    external: 0,
    insecure: 0,
    blocked: 0,
    missing: 0,
    error: 0,
    dns: 0,
    live: 0,
    answered: 0,
    redirects: 0,
  };
  for (const result of results) {
    if (Object.hasOwn(counts, result.category)) counts[result.category] += 1;
    if (result.status) counts.answered += 1;
    if (result.category === 'direct' || result.category === 'canonical') counts.live += 1;
    if (result.category === 'canonical' || result.category === 'external') counts.redirects += 1;
  }
  return {
    ...counts,
    wildcards: wildcards || 0,
    elapsedMs: Date.now() - startedAt,
  };
}

const CATEGORY_ORDER = {
  direct: 0,
  canonical: 1,
  external: 2,
  insecure: 3,
  blocked: 4,
  missing: 5,
  error: 6,
  dns: 7,
};

export async function createScan(term, suffixIndex) {
  const suffixes = suffixIndex.suffixes;
  const startedAt = Date.now();
  const job = {
    id: `${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    term,
    status: 'running',
    phase: 'dns',
    startedAt,
    completedAt: null,
    total: suffixes.length,
    checked: 0,
    found: 0,
    probeTotal: 0,
    probed: 0,
    wildcardTotal: 0,
    wildcardChecked: 0,
    wildcards: 0,
    marks: [],
    sample: [],
    results: [],
    summary: null,
    error: null,
    source: suffixIndex.meta.source,
    tlds: suffixIndex.meta.tlds,
  };

  job.promise = (async () => {
    const candidates = suffixes.map((suffix) => ({
      ascii: `${term}.${suffix.ascii}`,
      display: `${term}.${suffix.display}`,
      suffix: suffix.display,
      suffixAscii: suffix.ascii,
      suffixIndex: suffix.index,
    }));

    const resolved = [];
    await runPool(candidates, DNS_CONCURRENCY, async (candidate) => {
      const addresses = await resolveDomain(candidate.ascii);
      if (addresses.length) resolved.push({ ...candidate, addresses });
      job.checked += 1;
    });

    job.found = resolved.length;
    job.phase = 'wildcard';
    job.wildcardTotal = resolved.length;

    const sites = [];
    await runPool(resolved, WILDCARD_CONCURRENCY, async (site) => {
      if (await isWildcardSuffix(site.suffixAscii)) {
        job.wildcards += 1;
      } else {
        sites.push(site);
      }
      job.wildcardChecked += 1;
    });

    job.marks = sites.map((site) => site.suffixIndex);
    job.sample = sites.slice(0, 8).map((site) => site.display);
    job.found = sites.length;
    job.phase = 'probe';
    job.probeTotal = sites.length;
    job.checked = job.total;

    await runPool(sites, PROBE_CONCURRENCY, async (site) => {
      const result = await probeSite(site, site.addresses);
      delete result.addresses;
      job.results.push(result);
      job.probed += 1;
    });

    job.results.sort((a, b) => {
      const order = CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category];
      if (order !== 0) return order;
      return a.display.localeCompare(b.display);
    });
    job.summary = summarise(job.results, startedAt, job.wildcards);
    job.status = 'done';
    job.phase = 'done';
    job.completedAt = Date.now();
  })().catch((error) => {
    job.status = 'error';
    job.phase = 'error';
    job.error = error?.message || 'The scan stopped unexpectedly.';
    job.completedAt = Date.now();
  });

  return job;
}

export function publicJob(job, includeResults = true) {
  return {
    id: job.id,
    term: job.term,
    status: job.status,
    phase: job.phase,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    total: job.total,
    checked: job.checked,
    found: job.found,
    probeTotal: job.probeTotal,
    probed: job.probed,
    wildcardTotal: job.wildcardTotal,
    wildcardChecked: job.wildcardChecked,
    wildcards: job.wildcards,
    marks: job.marks,
    sample: job.sample,
    summary: job.summary,
    source: job.source,
    tlds: job.tlds,
    error: job.error,
    ...(includeResults && job.status === 'done' ? { results: job.results } : {}),
  };
}
