'use strict';

/**
 * The listed-market screen.
 *
 * Deliberately narrow. NSE refuses scripted access to per-stock quotes (403)
 * and Yahoo's fundamentals endpoints now demand a crumb (401), so price and
 * volume are the only things reachable for free across a whole universe.
 * Everything here is therefore computed from a year of daily closes: trend,
 * momentum, where a stock sits in its own range. There is no P/E, no market
 * cap and no earnings, and nothing below pretends otherwise.
 *
 * That makes this a screen, not a recommendation. It says which stocks meet
 * stated criteria today and shows the figures behind each one. It does not say
 * what to buy, at what price, or when to sell — those would have to be invented,
 * and an invented number sitting beside a real one is read as equally real.
 */

const { UA } = require('./sources');

const ARCHIVES = 'https://nsearchives.nseindia.com/content/indices/';
const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/';

/** The index whose members are screened. Membership is the quality filter. */
const INDICES = {
  nifty50:  { file: 'ind_nifty50list.csv',  label: 'NIFTY 50' },
  nifty100: { file: 'ind_nifty100list.csv', label: 'NIFTY 100' },
};

/** Split a CSV line, honouring quoted fields — company names contain commas. */
function splitCsv(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * Index members, straight from NSE's own published constituent list. The list
 * carries the industry too, which is the only sector data available anywhere in
 * this stack.
 */
async function getIndexConstituents(key = 'nifty50') {
  const idx = INDICES[key];
  if (!idx) throw new Error(`unknown index: ${key}`);

  const res = await fetch(ARCHIVES + idx.file, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`constituents -> ${res.status}`);

  const lines = (await res.text()).split('\n').filter((l) => l.trim());
  const head = splitCsv(lines[0]).map((h) => h.toLowerCase());
  const col = (name) => head.findIndex((h) => h.includes(name));
  const iName = col('company'), iInd = col('industry'), iSym = col('symbol');

  return lines.slice(1).map((l) => {
    const c = splitCsv(l);
    return { symbol: c[iSym], company: c[iName], industry: c[iInd] };
  }).filter((r) => r.symbol);
}

/** A year of daily closes for one NSE symbol. */
async function getDailySeries(symbol) {
  const url = `${YAHOO}${encodeURIComponent(symbol)}.NS?range=1y&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) return null;

  const result = (await res.json())?.chart?.result?.[0];
  if (!result) return null;

  const q = result.indicators?.quote?.[0] || {};
  const rows = (result.timestamp || []).map((t, i) => ({
    t: t * 1000, close: q.close?.[i] ?? null, volume: q.volume?.[i] ?? null,
  })).filter((r) => r.close !== null);

  if (rows.length < 60) return null;
  return { rows, meta: result.meta || {} };
}

const r1 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

/**
 * Trend and position, computed from the closes.
 *
 * Trading days rather than calendar days: ~21 to the month, which is what the
 * series actually contains. A gap in the data shortens the window rather than
 * silently reaching further back.
 */
function factorsFor(series) {
  const { rows, meta } = series;
  const closes = rows.map((r) => r.close);
  const last = closes[closes.length - 1];

  const backPct = (n) => {
    const prev = closes[closes.length - 1 - n];
    return prev ? ((last - prev) / prev) * 100 : null;
  };

  const mean = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);
  const dma = (n) => (closes.length >= n ? mean(closes.slice(-n)) : null);

  const hi = meta.fiftyTwoWeekHigh ?? Math.max(...closes);
  const lo = meta.fiftyTwoWeekLow ?? Math.min(...closes);
  const dma200 = dma(200);

  const vols = rows.map((r) => r.volume).filter((v) => v);
  const avgVol = vols.length >= 50 ? mean(vols.slice(-50)) : null;
  const lastVol = vols[vols.length - 1] ?? null;

  return {
    price: r2(last),
    fromHigh: r1(hi ? ((last - hi) / hi) * 100 : null),
    fromLow:  r1(lo ? ((last - lo) / lo) * 100 : null),
    r1m: r1(backPct(21)),
    r3m: r1(backPct(63)),
    r6m: r1(backPct(126)),
    vsDma200: r1(dma200 ? ((last - dma200) / dma200) * 100 : null),
    relVolume: r2(avgVol && lastVol ? lastVol / avgVol : null),
    asOf: rows[rows.length - 1].t,
  };
}

/**
 * The criteria, stated once and applied to everything.
 *
 * "Rising" wants a stock in an established uptrend that has not just spiked:
 * above its 200-day average, up over three months, and still within reach of
 * its own high. "Falling" is the mirror. Anything meeting neither is simply not
 * shown — a screen that returns everything has not screened.
 */
const CRITERIA = {
  rising: {
    label: 'Screening well',
    note: 'Above the 200-day average, up over three months, and within 15% of the 52-week high.',
    test: (f) => f.vsDma200 > 0 && f.r3m > 0 && f.fromHigh !== null && f.fromHigh > -15,
    rank: (a, b) => b.r3m - a.r3m,
  },
  falling: {
    label: 'Screening poorly',
    note: 'Below the 200-day average and down over three months.',
    test: (f) => f.vsDma200 < 0 && f.r3m < 0,
    rank: (a, b) => a.r3m - b.r3m,
  },
};

/** Fetch and score a universe, with a small concurrency cap. */
async function screenIndex(key = 'nifty50', concurrency = 4) {
  const members = await getIndexConstituents(key);
  const queue = [...members];
  const scored = [];

  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length) {
        const m = queue.shift();
        let series;
        try {
          series = await getDailySeries(m.symbol);
        } catch {
          continue; // one unreachable symbol must not sink the screen
        }
        if (!series) continue;
        scored.push({ ...m, ...factorsFor(series) });
      }
    })
  );

  const pick = (which, n = 5) => scored
    .filter((s) => s.r3m !== null && s.vsDma200 !== null)
    .filter(CRITERIA[which].test)
    .sort(CRITERIA[which].rank)
    .slice(0, n);

  return {
    index: INDICES[key].label,
    counted: scored.length,
    of: members.length,
    rising: pick('rising'),
    falling: pick('falling'),
    criteria: {
      rising: CRITERIA.rising.note,
      falling: CRITERIA.falling.note,
    },
  };
}

module.exports = { getIndexConstituents, getDailySeries, factorsFor, screenIndex, INDICES, CRITERIA };
