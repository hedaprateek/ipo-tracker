#!/usr/bin/env node
/**
 * Run the listed-market screen and write data/market.json.
 *
 * Separate from fetch-data.js and on a slower schedule: this reads a year of
 * daily closes for every index member, so it is fifty requests where the IPO
 * fetch is a handful. Daily closes change once a day, so running it more often
 * than that would be fifty requests to learn nothing.
 *
 *   node scripts/fetch-market.js [nifty50|nifty100]
 */

const { relaunchWithSystemCa, preferIpv4 } = require('../lib/net');
if (relaunchWithSystemCa(__filename)) return;
preferIpv4();

const fs = require('fs');
const path = require('path');
const market = require('../lib/market');

const DATA_DIR = path.join(__dirname, '..', 'data');
const index = process.argv[2] || 'nifty50';

(async () => {
  let screen;
  try {
    screen = await market.screenIndex(index);
  } catch (err) {
    console.error('screen failed:', err.message);
    process.exit(1);
  }

  // A screen built from a fraction of the universe is not the screen it claims
  // to be, so a thin run is left unwritten rather than published as complete.
  if (screen.counted < screen.of * 0.8) {
    console.error(`only ${screen.counted} of ${screen.of} priced — leaving the previous screen in place`);
    process.exit(1);
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(DATA_DIR, 'market.json'),
    JSON.stringify({ ok: true, fetchedAt: new Date().toISOString(), ...screen }),
    'utf8'
  );

  console.log(
    `market.json: ${screen.index}, ${screen.counted}/${screen.of} priced, ` +
    `${screen.rising.length} rising, ${screen.falling.length} falling`
  );
  for (const r of screen.rising) console.log(`  + ${r.symbol.padEnd(12)} 3m ${String(r.r3m).padStart(6)}%  ${r.fromHigh}% from high`);
  for (const r of screen.falling) console.log(`  - ${r.symbol.padEnd(12)} 3m ${String(r.r3m).padStart(6)}%  ${r.vsDma200}% vs 200dma`);
})();
