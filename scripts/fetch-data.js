#!/usr/bin/env node
/**
 * Fetch both upstreams and write them into data/ as static JSON.
 *
 * GitHub Pages serves files, it cannot run server.js — so a scheduled Action
 * runs this and commits the result. The page then reads data/*.json from its
 * own origin, which needs no CORS and no proxy. Committing also means the GMP
 * history accumulates permanently in git rather than per-browser.
 *
 *   node scripts/fetch-data.js
 *
 * Exits non-zero only if BOTH upstreams fail, so one flaky source does not
 * break the schedule or clobber good data with an empty file.
 */

const { relaunchWithSystemCa, preferIpv4 } = require('../lib/net');
if (relaunchWithSystemCa(__filename)) return;
preferIpv4();

const fs = require('fs');
const path = require('path');
const sources = require('../lib/sources');

const DATA_DIR = path.join(__dirname, '..', 'data');
const now = new Date().toISOString();

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value), 'utf8');
}

(async () => {
  const [iposRes, gmpRes] = await Promise.allSettled([
    sources.getIposEnriched(),
    sources.getGmp(),
  ]);

  let ok = 0;

  if (iposRes.status === 'fulfilled' && iposRes.value.length) {
    // Categories, issue terms and listing prices are all attached by
    // getIposEnriched, so the server and this script cannot drift apart.
    const ipos = iposRes.value;
    const withCats = ipos.filter((r) => r.categories?.length).length;
    const withPrices = ipos.filter((r) => r.listing).length;

    writeJson('ipos.json', { ok: true, fetchedAt: now, ipos });
    console.log(
      `ipos.json: ${ipos.length} issues, ${withCats} with category bids, ` +
      `${withPrices} listed with prices`
    );
    ok++;
  } else {
    console.error('NSE failed:', iposRes.reason?.message || 'empty response');
  }

  if (gmpRes.status === 'fulfilled' && gmpRes.value.length) {
    writeJson('gmp.json', { ok: true, fetchedAt: now, gmp: gmpRes.value });

    let history = sources.recordHistory(readJson('gmp-history.json', {}), gmpRes.value, now);

    // IPO Watch keeps one to two weeks of day-by-day GMP per IPO. This app can
    // only ever observe the present, so without the backfill a fresh deploy
    // shows a few hours of trend and the wider ranges have nothing to draw.
    try {
      const { added, touched } = await sources.backfillHistory(history, gmpRes.value);
      if (added) console.log(`backfilled ${added} historical points across ${touched} IPOs`);
    } catch (err) {
      console.warn('backfill skipped:', err.message);
    }

    history = sources.pruneHistory(history);
    writeJson('gmp-history.json', history);

    const points = Object.values(history).reduce((n, s) => n + s.points.length, 0);
    console.log(`gmp.json: ${gmpRes.value.length} rows`);
    console.log(`gmp-history.json: ${Object.keys(history).length} series, ${points} points`);
    ok++;
  } else {
    console.error('IPO Watch failed:', gmpRes.reason?.message || 'empty response');
  }

  if (!ok) {
    console.error('both upstreams failed; leaving existing data untouched');
    process.exit(1);
  }
})();
