import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSuffixIndex, normalizeTerm } from './tlds.mjs';
import { createScan, publicJob } from './scanner.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');
const PORT = Number(process.env.PORT || 8788);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_JOBS = 40;
const MAX_ACTIVE = 4;
const JOB_TTL = 30 * 60 * 1000;

const jobs = new Map();
const active = new Set();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(response, status, payload, extraHeaders = {}) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  response.end(body);
}

function sendText(response, status, body, type = 'text/plain; charset=utf-8') {
  const payload = Buffer.from(body);
  response.writeHead(status, {
    'content-type': type,
    'content-length': payload.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(payload);
}

async function readBody(request, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function cleanupJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status !== 'running' && now - (job.completedAt || job.startedAt) > JOB_TTL) {
      jobs.delete(id);
      active.delete(id);
    }
  }
}

setInterval(cleanupJobs, 5 * 60 * 1000).unref();

async function serveStatic(request, response, pathname) {
  let requested;
  try {
    requested = pathname === '/' ? '/index.html' : pathname;
    requested = decodeURIComponent(requested);
  } catch {
    sendText(response, 400, 'Bad request');
    return;
  }
  if (requested.includes('\0')) {
    sendText(response, 400, 'Bad request');
    return;
  }
  const filePath = path.resolve(publicDir, `.${requested}`);
  if (!filePath.startsWith(`${publicDir}${path.sep}`) && filePath !== path.join(publicDir, 'index.html')) {
    sendText(response, 404, 'Not found');
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('Not a file');
    const body = await readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      'content-type': MIME[extension] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': extension === '.woff2' ? 'public, max-age=31536000, immutable' : 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'x-frame-options': 'SAMEORIGIN',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'",
    });
    response.end(body);
  } catch {
    sendText(response, 404, 'Not found');
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    if (request.method === 'GET' && pathname === '/api/health') {
      sendJson(response, 200, { ok: true, active: active.size, jobs: jobs.size });
      return;
    }

    if (request.method === 'GET' && pathname === '/api/meta') {
      const suffixIndex = await getSuffixIndex();
      sendJson(response, 200, {
        total: suffixIndex.meta.total,
        tlds: suffixIndex.meta.tlds,
        multiLevel: suffixIndex.meta.multiLevel,
        source: suffixIndex.meta.source,
        fetchedAt: suffixIndex.meta.fetchedAt,
        scanningLimits: { dnsConcurrency: 90, probeConcurrency: 42 },
      });
      return;
    }

    if (request.method === 'POST' && pathname === '/api/search') {
      let payload;
      try {
        payload = JSON.parse(await readBody(request));
      } catch {
        sendJson(response, 400, { error: 'Send a JSON body with a term.' });
        return;
      }
      const normalized = normalizeTerm(payload?.term);
      if (normalized.error) {
        sendJson(response, 422, { error: normalized.error });
        return;
      }
      if (active.size >= MAX_ACTIVE) {
        sendJson(response, 429, { error: 'Several scans are running. Try again in a moment.' });
        return;
      }
      const suffixIndex = await getSuffixIndex();
      const job = await createScan(normalized.term, suffixIndex);
      jobs.set(job.id, job);
      active.add(job.id);
      job.promise.finally(() => {
        active.delete(job.id);
        cleanupJobs();
      });
      sendJson(response, 202, {
        id: job.id,
        term: job.term,
        total: job.total,
        source: job.source,
        tlds: job.tlds,
      });
      return;
    }

    if (request.method === 'GET' && pathname.startsWith('/api/search/')) {
      const id = decodeURIComponent(pathname.slice('/api/search/'.length));
      const job = jobs.get(id);
      if (!job) {
        sendJson(response, 404, { error: 'That scan is not in memory. Run it again.' });
        return;
      }
      sendJson(response, 200, publicJob(job, true));
      return;
    }

    if (pathname.startsWith('/api/')) {
      sendJson(response, 404, { error: 'Unknown API route.' });
      return;
    }

    if (request.method === 'GET' || request.method === 'HEAD') {
      await serveStatic(request, response, pathname);
      return;
    }

    sendText(response, 405, 'Method not allowed');
  } catch (error) {
    console.error(new Date().toISOString(), error);
    if (!response.headersSent) {
      sendJson(response, 500, { error: 'The server could not complete that request.' });
    } else {
      response.destroy();
    }
  }
});

server.requestTimeout = 30_000;
server.headersTimeout = 12_000;
server.listen(PORT, HOST, () => {
  console.log(`Suffix Atlas on http://${HOST}:${PORT}`);
  getSuffixIndex()
    .then((suffixIndex) => {
      console.log(`Index ready: ${suffixIndex.meta.total} suffixes (${suffixIndex.meta.tlds} TLDs + ${suffixIndex.meta.multiLevel} multi-level), source ${suffixIndex.meta.source}`);
    })
    .catch((error) => {
      console.error('Index failed:', error);
    });
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
