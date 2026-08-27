#!/usr/bin/env node
/**
 * IPO Tracker - tiny zero-dependency local server.
 *
 * Why this exists: NSE and IPO Watch send no CORS headers, so a page opened
 * from file:// cannot read them. This serves index.html and proxies both
 * upstreams from the same origin, caching so the sources are not hammered, and
 * keeps a GMP history file on disk so the trend survives a cleared cache.
 *
 * The GitHub Pages deployment does not use this — see scripts/fetch-data.js.
 *
 *   node server.js          -> http://localhost:8787
 *   node server.js 9000     -> http://localhost:9000
 */

const { relaunchWithSystemCa, preferIpv4 } = require('./lib/net');
if (relaunchWithSystemCa(__filename)) return;
preferIpv4();

const http = require('http');
const fs = require('fs');
const path = require('path');
const sources = require('./lib/sources');

const PORT = Number(process.argv[2]) || 8787;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'gmp-history.json');

// ---------------------------------------------------------------- caching

const cache = new Map();

async function cached(key, ttlMs, producer) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await producer();
  cache.set(key, { at: Date.now(), value });
  return value;
}

function readHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeHistory(history) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history), 'utf8');
  } catch (err) {
    console.warn('could not persist GMP history:', err.message);
  }
}

// ---------------------------------------------------------------- HTTP glue

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, version: 2 });
    }

    if (url.pathname === '/api/ipos') {
      const ipos = await cached('ipos', 60_000, sources.getIposEnriched);
      return sendJson(res, 200, { ok: true, fetchedAt: new Date().toISOString(), ipos });
    }

    if (url.pathname === '/api/gmp') {
      const gmp = await cached('gmp', 5 * 60_000, sources.getGmp);
      const history = sources.recordHistory(readHistory(), gmp);
      writeHistory(history);
      return sendJson(res, 200, {
        ok: true, fetchedAt: new Date().toISOString(), gmp, history,
      });
    }

    if (url.pathname === '/api/history') {
      return sendJson(res, 200, { ok: true, history: readHistory() });
    }

    if (url.pathname.startsWith('/api/')) {
      return sendJson(res, 404, { ok: false, error: 'unknown endpoint' });
    }

    return serveStatic(res, url.pathname);
  } catch (err) {
    console.error(url.pathname, '->', err.message);
    return sendJson(res, 502, { ok: false, error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`\n  IPO Tracker running at  http://localhost:${PORT}\n`);
  console.log('  Data: NSE (issue calendar + subscription), IPO Watch (GMP).');
  console.log(`  GMP history: ${HISTORY_FILE}`);
  console.log('  Ctrl+C to stop.\n');
});
