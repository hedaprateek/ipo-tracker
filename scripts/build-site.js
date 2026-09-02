#!/usr/bin/env node
/**
 * Assemble the static site into dist/.
 *
 * GitHub Pages serves the repository root, which works because it publishes a
 * branch rather than uploading a directory. Cloudflare uploads whatever it is
 * pointed at, so pointing it at the root means uploading node_modules — where
 * wrangler's own workerd binary is 146 MB, six times the 25 MB per-asset limit.
 *
 * The site is four things. Everything else in the repo — the fetch scripts, the
 * local server, lib/ — runs on a machine, not in a browser, and has no business
 * being published.
 *
 *   node scripts/build-site.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist');

// Files the browser actually asks for: index.html references styles.css and
// js/*, and the page fetches data/*.json when no local server is answering.
const INCLUDE = ['index.html', 'styles.css', 'js', 'data'];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let files = 0;
let bytes = 0;

for (const entry of INCLUDE) {
  const from = path.join(ROOT, entry);
  if (!fs.existsSync(from)) {
    console.error(`missing: ${entry}`);
    process.exit(1);
  }
  fs.cpSync(from, path.join(OUT, entry), { recursive: true });
}

// Walk the result rather than the source, so the count is of what will ship.
const walk = (dir) => {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else { files++; bytes += st.size; }
  }
};
walk(OUT);

// The limit that broke the deploy, checked here where the message can be read
// rather than after an upload has already started.
const LIMIT = 25 * 1024 * 1024;
const oversized = [];
const check = (dir) => {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) check(p);
    else if (st.size > LIMIT) oversized.push(`${path.relative(OUT, p)} (${(st.size / 1048576).toFixed(1)} MB)`);
  }
};
check(OUT);

if (oversized.length) {
  console.error('assets over the 25 MB limit:\n  ' + oversized.join('\n  '));
  process.exit(1);
}

console.log(`dist/: ${files} files, ${(bytes / 1024).toFixed(0)} KB`);
