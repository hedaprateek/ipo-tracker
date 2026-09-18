#!/usr/bin/env node
/**
 * Load every view in a real browser and fail on any console error.
 *
 * This exists because of a specific bug. Opening any SME issue threw partway
 * through building the detail dialog, which left it on screen with half its
 * sections empty and no working close button — and nothing anywhere reported
 * it. It was found by opening all fifty-five issues by hand. A browser that
 * loads the page and shouts about exceptions would have caught it on the commit
 * that introduced it, which is the entire job of this script.
 *
 * So the routes below are not a sample. They are every tab, plus a detail
 * dialog for one mainboard and one SME issue, because mainboard and SME travel
 * down different code paths — NSE reports SME bidding in a different shape, and
 * that difference is what broke.
 *
 *   node scripts/smoke.js
 */

const { execFileSync, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8799;
const WAIT_SECONDS = 20;

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
};

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ];
  for (const c of candidates) {
    try {
      if (c.includes('/') && !fs.existsSync(c)) continue;
      execFileSync(c, ['--version'], { stdio: 'ignore' });
      return c;
    } catch { /* try the next one */ }
  }
  throw new Error('no Chrome found — set CHROME_PATH');
}

/** Pick real keys out of the committed data, so the routes track the data. */
function detailRoutes() {
  const file = path.join(ROOT, 'data', 'ipos.json');
  if (!fs.existsSync(file)) return [];

  const { ipos } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const key = (name) => String(name || '').toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/\b(limited|ltd|private|pvt|india|indian|the|company|co)\b/g, '')
    .replace(/[^a-z0-9]/g, '');

  const pick = (board) => {
    const hit = ipos.find((r) => r.company && r.categories?.length &&
      (String(r.series || '').toUpperCase() === 'SME' ? 'SME' : 'Mainboard') === board);
    return hit ? { name: `${board} detail (${hit.company.slice(0, 28)})`, hash: `#ipo=${key(hit.company)}` } : null;
  };

  return [pick('Mainboard'), pick('SME')].filter(Boolean);
}

const ROUTES = [
  { name: 'IPOs (landing)',   hash: '',        expect: 'id="ipo-groups"' },
  { name: 'Today',            hash: '#today',  expect: 'id="today-list"' },
  { name: 'GMP & trend',      hash: '#gmp',    expect: 'id="gmp-table"' },
  { name: 'My Applications',  hash: '#allot',  expect: 'id="allot-table"' },
  { name: 'Corporate offers', hash: '#corp',   expect: 'id="corp-table"' },
  { name: 'Stock screen',     hash: '#market', expect: 'id="market-groups"' },
  { name: 'Calendar',         hash: '#cal',    expect: 'id="cal-grid"' },
  { name: 'Privacy page',     path: '/privacy.html', expect: 'ipotracker.ids' },
  { name: 'Terms page',       path: '/terms.html',   expect: 'Not investment advice' },
  ...detailRoutes().map((r) => ({ ...r, expect: 'class="modal-backdrop"' })),
];

// Chrome is noisy on CI about things that are not this app's problem.
const IGNORE = /GPU|gpu_|dbus|bluetooth|Fontconfig|DevTools listening|Autofill|crx_installer|gcm|registration_request|TensorFlow|Permissions|voice_transcription|net::ERR_NAME_NOT_RESOLVED/i;
const FATAL = /Uncaught|TypeError|ReferenceError|SyntaxError|is not a function|Cannot read propert/i;

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

// SMOKE_ONLY=gmp,detail runs just the matching routes. Every launch is a cold
// browser, so narrowing the sweep is the difference between a ten-second check
// and a coffee break when chasing one view.
const only = (process.env.SMOKE_ONLY || '').toLowerCase().split(',').filter(Boolean);
const SELECTED = only.length
  ? ROUTES.filter((r) => only.some((o) => r.name.toLowerCase().includes(o)))
  : ROUTES;

server.listen(PORT, async () => {
  const chrome = findChrome();
  const profile = fs.mkdtempSync(path.join(require('os').tmpdir(), 'smoke-'));
  let failures = 0;

  for (const route of SELECTED) {
    const url = `http://localhost:${PORT}${route.path || '/'}${route.hash || ''}`;
    let dom = "";
    let stderr = '';

    // Both streams go to files, and nothing is piped.
    //
    // Chrome spawns helper processes that inherit whatever handles it was given.
    // A piped stdout therefore stays open after the browser itself has exited,
    // and the call waits forever for an EOF that never arrives — which is
    // exactly what happened here, on Windows and on Linux CI alike, while the
    // same flags redirected to a file by a shell returned every time.
    const domFile = path.join(profile, 'dom.html');
    const logFile = path.join(profile, 'chrome.log');
    const domFd = fs.openSync(domFile, 'w');
    const logFd = fs.openSync(logFile, 'w');

    // Run through the shell's own `timeout`, redirecting to files.
    //
    // Chrome writes the DOM and then does not reliably exit — it leaves helper
    // processes behind and the launcher never returns. Node's own timeout
    // option does not reap it either. The one form that has always worked is
    // the shell's timeout with plain file redirection, so that is what runs:
    // give it a few seconds, take whatever it wrote, kill it. Being killed is
    // the normal path here, not a failure.
    fs.closeSync(domFd);
    fs.closeSync(logFd);
    const q = (s) => `"${s}"`;
    const flags = [
      '--headless', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
      // A fresh profile each time; sharing one deadlocks each launch against
      // the previous instance's lock.
      `--user-data-dir=${profile}/${Math.random().toString(36).slice(2)}`,
      '--virtual-time-budget=6000', '--enable-logging=stderr', '--log-level=0',
      '--dump-dom',
    ].join(' ');

    try {
      execSync(`timeout ${WAIT_SECONDS} ${q(chrome)} ${flags} ${q(url)} > ${q(domFile)} 2> ${q(logFile)}`,
        { stdio: 'ignore', shell: '/bin/sh' });
    } catch {
      // timeout returns 124 when it kills Chrome, which is the expected case.
    }

    try { dom = fs.readFileSync(domFile, 'utf8'); } catch { /* nothing written */ }
    try { stderr = fs.readFileSync(logFile, 'utf8'); } catch { /* no log */ }

    const errors = stderr.split('\n')
      .filter((l) => FATAL.test(l) && !IGNORE.test(l))
      .slice(0, 3);

    const missing = route.expect && !dom.includes(route.expect);

    if (errors.length || missing || !dom) {
      failures++;
      console.error(`FAIL  ${route.name}  ${url}`);
      if (!dom) console.error('        page did not render at all');
      else if (missing) console.error(`        expected to find ${JSON.stringify(route.expect)} and did not`);
      errors.forEach((e) => console.error(`        ${e.trim().slice(0, 200)}`));
    } else {
      console.log(`ok    ${route.name}`);
    }
  }

  server.close();
  fs.rmSync(profile, { recursive: true, force: true });

  console.log(`\n${SELECTED.length - failures}/${SELECTED.length} views clean`);
  process.exit(failures ? 1 : 0);
});
