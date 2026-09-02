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

    // The scorecard grades GMP against what the stock actually did on listing,
    // which needs a premium recorded before the issue listed — a window this
    // app missed for everything that concluded before it existed. IPO Watch
    // keeps those pages up, so the record is reconstructed once per IPO and
    // then skipped on every later run.
    if (iposRes.status === 'fulfilled') {
      try {
        const listed = iposRes.value.filter((r) => r.listing && r.company);
        const { added, touched } = await sources.backfillListedHistory(history, listed);
        if (added) console.log(`recovered ${added} pre-listing points across ${touched} listed IPOs`);
      } catch (err) {
        console.warn('listed backfill skipped:', err.message);
      }
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

  // What the company reports, beside what the market feels. Only issues that
  // are still a decision are worth the requests, and an issue's figures do not
  // change once published, so anything already on file is left alone.
  if (iposRes.status === 'fulfilled') {
    const known = readJson('fundamentals.json', {});
    const gmpRows = gmpRes.status === 'fulfilled' ? gmpRes.value : [];
    const today = new Date().toISOString().slice(0, 10);
    const soon = new Date(Date.now() + 21 * 86400e3).toISOString().slice(0, 10);

    const wanted = iposRes.value
      .filter((r) => r.company && r.start && r.start <= soon && (!r.end || r.end >= today))
      .map((r) => ({
        key: sources.nameKey(r.company),
        company: r.company,
        page: gmpRows.find((g) => g.key === sources.nameKey(r.company))?.page || null,
      }))
      // Re-fetch anything captured before the extractor learned its current
      // set of fields, so a new field reaches the issues already on file.
      .filter((it) => it.key && known[it.key]?.v !== sources.FUNDAMENTALS_VERSION);

    if (wanted.length) {
      try {
        const found = await sources.getFundamentals(wanted);
        const merged = { ...known, ...found };
        writeJson('fundamentals.json', merged);
        console.log(`fundamentals.json: +${Object.keys(found).length} issues, ${Object.keys(merged).length} on file`);
      } catch (err) {
        console.warn('fundamentals skipped:', err.message);
      }
    } else {
      console.log(`fundamentals.json: nothing new, ${Object.keys(known).length} on file`);
    }
  }

  // The other offers a shareholder has to decide about. Only the ones with
  // terms get a quote — a dividend needs no price to compare against.
  try {
    const actions = await sources.getCorporateActions();
    const priced = actions.filter((a) => ['rights', 'buyback', 'bonus', 'split'].includes(a.type));
    const quotes = await sources.getQuotes(priced.map((a) => a.symbol)).catch(() => ({}));

    writeJson('corporate.json', { ok: true, fetchedAt: now, actions, quotes });
    const counts = actions.reduce((m, a) => ({ ...m, [a.type]: (m[a.type] || 0) + 1 }), {});
    console.log(`corporate.json: ${actions.length} actions ` +
      `(${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}), ` +
      `${Object.keys(quotes).length} quoted`);
  } catch (err) {
    console.warn('corporate actions skipped:', err.message);
  }

  if (!ok) {
    console.error('both upstreams failed; leaving existing data untouched');
    process.exit(1);
  }
})();
