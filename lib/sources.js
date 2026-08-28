'use strict';

/**
 * The two upstreams, and the normalising that turns them into the shapes the
 * page renders. Shared by server.js (live proxy) and scripts/fetch-data.js
 * (the scheduled Action that commits JSON for GitHub Pages).
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0 Safari/537.36';

const NSE = 'https://www.nseindia.com';
const GMP_URL = 'https://ipowatch.in/ipo-grey-market-premium-latest-ipo-gmp/';

const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

// ---------------------------------------------------------------- utilities

function stripTags(s) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#8377;|&#x20b9;/g, '₹')
    .replace(/&quot;/g, '"')
    .replace(/&#8211;|&ndash;/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalised company key used to join NSE rows to GMP rows. */
function nameKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/\b(limited|ltd|private|pvt|india|indian|the|company|co)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** "27-Aug-2026" / "27-AUG-2026" -> "2026-08-27" */
function isoDate(s) {
  const m = String(s || '').match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (!m) return null;
  const mm = MONTHS[m[2].toLowerCase()];
  return mm ? `${m[3]}-${mm}-${m[1].padStart(2, '0')}` : null;
}

function parseMoney(s) {
  const m = String(s || '').replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function asArray(x) {
  if (Array.isArray(x)) return x;
  if (x && Array.isArray(x.data)) return x.data;
  return [];
}

// ---------------------------------------------------------------- NSE fetch

// NSE hands out cookies on the homepage and rejects API calls without them
// once it decides you look like a bot. Bootstrap lazily, refresh hourly.
let nseCookie = '';
let nseCookieAt = 0;

async function nseCookies() {
  if (nseCookie && Date.now() - nseCookieAt < 60 * 60 * 1000) return nseCookie;
  try {
    const res = await fetch(NSE + '/', {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
    });
    const raw = res.headers.getSetCookie
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter(Boolean);
    nseCookie = raw.map((c) => String(c).split(';')[0]).join('; ');
    nseCookieAt = Date.now();
  } catch {
    nseCookie = '';
  }
  return nseCookie;
}

async function nseJson(pathname) {
  const cookie = await nseCookies();
  const res = await fetch(NSE + pathname, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: NSE + '/market-data/all-upcoming-issues-ipo',
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
  if (!res.ok) throw new Error(`NSE ${pathname} -> ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`NSE ${pathname} returned non-JSON`);
  }
}

async function getIpos() {
  const [current, upcoming, past] = await Promise.all([
    nseJson('/api/ipo-current-issue').catch(() => []),
    nseJson('/api/all-upcoming-issues?category=ipo').catch(() => []),
    nseJson('/api/public-past-issues').catch(() => []),
  ]);

  const bySymbol = new Map();
  const put = (row) => {
    if (!row.symbol) return;
    const merged = bySymbol.get(row.symbol) || {};
    for (const [k, v] of Object.entries(row)) {
      if (v !== null && v !== undefined && v !== '') merged[k] = v;
    }
    bySymbol.set(row.symbol, merged);
  };

  for (const r of asArray(current)) {
    put({
      symbol: r.symbol,
      company: r.companyName,
      start: isoDate(r.issueStartDate),
      end: isoDate(r.issueEndDate),
      priceBand: r.issuePrice,
      issueSize: r.issueSize,
      series: r.series,
      subscription: r.noOfTime ? Number(r.noOfTime) : null,
      sharesOffered: r.noOfSharesOffered ? Number(r.noOfSharesOffered) : null,
      sharesBid: r.noOfsharesBid ? Number(r.noOfsharesBid) : null,
    });
  }

  for (const r of asArray(upcoming)) {
    put({
      symbol: r.symbol,
      company: r.companyName,
      start: isoDate(r.issueStartDate),
      end: isoDate(r.issueEndDate),
      priceBand: r.issuePrice,
      issueSize: r.issueSize,
      series: r.series,
    });
  }

  // The past-issues feed is a multi-year archive that also carries NCDs and
  // other debt series. Keep equity issues from the last few months only.
  const EQUITY = new Set(['EQ', 'SME', 'BE']);
  const cutoff = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);

  for (const r of asArray(past)) {
    if (!EQUITY.has(String(r.securityType || '').toUpperCase())) continue;
    const end = isoDate(r.ipoEndDate);
    if (end && end < cutoff) continue;
    put({
      symbol: r.symbol,
      company: r.company,
      start: isoDate(r.ipoStartDate),
      end,
      priceBand: r.priceRange,
      listingDate: r.listingDate && r.listingDate !== '-' ? isoDate(r.listingDate) : null,
      series: r.securityType,
    });
  }

  return [...bySymbol.values()].map((r) => ({
    ...r,
    source: 'nse',
    board: String(r.series || '').toUpperCase() === 'SME' ? 'SME' : 'Mainboard',
  }));
}

// ------------------------------------------------- per-category subscription

/**
 * NSE returns bid data as a flat list keyed by a printed serial number, mixing
 * headline categories (1, 2, 3, 4) with sub-rows (1(a), 2.1, 2.2(b)…). Only the
 * rows below carry a usable `noOfTime`; everything else is a breakdown.
 *
 * 2.1 and 2.2 are the two halves of NII that investors actually choose between,
 * so they are surfaced alongside the NII total rather than hidden under it.
 */
const CATEGORIES = [
  { sr: '1',   key: 'qib',      label: 'QIB' },
  { sr: '2',   key: 'nii',      label: 'NII (HNI)' },
  { sr: '2.1', key: 'bhni',     label: 'bHNI · above ₹10L' },
  { sr: '2.2', key: 'shni',     label: 'sHNI · ₹2L–₹10L' },
  { sr: '3',   key: 'retail',   label: 'Retail' },
  { sr: '4',   key: 'employee', label: 'Employee' },
];

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * `issueInfo.dataList` is a flat list of printed label/value pairs — the same
 * table NSE renders on the issue page. Pull out the handful that bear on an
 * apply-or-not decision. Values arrive quoted and comma-grouped, so they need
 * unwrapping rather than a straight read.
 */
function parseIssueInfo(dataList) {
  const get = (re) => {
    const row = asArray(dataList).find((d) => d.title && re.test(String(d.title)));
    if (!row) return null;
    const v = String(row.value ?? '').replace(/^"|"$/g, '').trim();
    return v || null;
  };

  const firstNum = (s) => {
    if (!s) return null;
    const m = s.replace(/,/g, '').match(/\d+(\.\d+)?/);
    return m ? Number(m[0]) : null;
  };

  // "<a href=... >SCSB List</a>" appears in some rows; take a bare URL only.
  const url = (s) => (s && /^https?:\/\/\S+$/.test(s) ? s : null);

  return {
    // Mainboard prints "Bid Lot"; SME prints "Lot Size" for the same thing.
    lotSize: firstNum(get(/^Bid Lot/i) || get(/^Lot Size/i) || get(/^Minimum Order Quantity/i)),
    // NSE's list feed omits the band for some SME issues, but the issue page
    // carries it, so keep it as a fallback for the caller.
    priceBand: get(/^Price Range/i) || get(/^Price Band/i) || get(/^Issue Price/i),
    faceValue: firstNum(get(/^Face Value/i)),
    issueType: get(/^Issue Type/i),
    registrar: get(/^Name of the Registrar/i),
    leadManagers: get(/^Book Running Lead Managers/i),
    maxRetailAmount: firstNum(get(/^Maximum Subscription Amount for Retail/i)),
    rhpUrl: url(get(/^Red Herring Prospectus/i)),
    ratiosUrl: url(get(/^Ratios \/ Basis of Issue Price/i)),
    anchorUrl: url(get(/^Anchor Allocation Report/i)),
  };
}

/** Category-wise subscription plus issue terms for one symbol. */
async function getIpoDetail(symbol, series = 'EQ') {
  const j = await nseJson(
    `/api/ipo-detail?symbol=${encodeURIComponent(symbol)}&series=${encodeURIComponent(series)}`
  );
  const info = parseIssueInfo(j.issueInfo?.dataList);
  const rows = asArray(j.bidDetails);
  // Terms are published before bidding opens, so a symbol with no bids yet is
  // still worth returning.
  if (!rows.length) return info.lotSize ? { categories: [], total: null, info } : null;

  const bySr = new Map(rows.map((r) => [String(r.srNo ?? '').trim(), r]));
  const categories = [];

  // Mainboard and SME return different shapes from the same endpoint. Mainboard
  // carries shares offered and a subscription multiple; SME carries only shares
  // bid and an application count — its `activeCat` block, which would hold the
  // multiples, comes back all zeros. The serial numbers match, so the same map
  // works for both; only the field names and what is knowable differ.
  for (const cat of CATEGORIES) {
    const r = bySr.get(cat.sr);
    if (!r) continue;

    const times = num(r.noOfTime);
    const bid = num(r.noOfsharesBid) ?? num(r.noOfshareBid);
    const applications = num(r.noofapplication);
    if (times === null && bid === null) continue;

    categories.push({
      key: cat.key,
      label: cat.label,
      offered: num(r.noOfSharesOffered),
      bid,
      applications,
      times,
    });
  }

  const totalRow = rows.find((r) => /^total$/i.test(String(r.category || '').trim()));
  return {
    categories,
    total: totalRow ? num(totalRow.noOfTime) : null,
    info,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * The full IPO list with category-wise bids attached.
 *
 * Category bids only exist while an issue is live and for a short window after
 * it closes, so only those symbols are asked for. Both the local server and the
 * scheduled fetch use this, so they cannot drift apart.
 */
async function getIposEnriched() {
  const ipos = await getIpos();
  const today = new Date().toISOString().slice(0, 10);
  const recent = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  // Issue terms — lot size, registrar, RHP — are published before bidding
  // opens, so upcoming issues are worth asking about even with no bids yet.
  const soon = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);

  const wanted = ipos.filter(
    (r) => r.symbol && r.start && r.start <= soon && (!r.end || r.end >= recent)
  );

  // Once an issue lists, GMP is irrelevant — the real figures are the price it
  // opened at and where it trades now. Only recently listed issues are asked
  // for; the NSE archive runs years back.
  const listedSince = new Date(Date.now() - 180 * 86400e3).toISOString().slice(0, 10);
  const listed = ipos.filter(
    (r) => r.symbol && r.listingDate && r.listingDate <= today && r.listingDate >= listedSince
  );

  const [details, prices] = await Promise.all([
    getIpoDetails(wanted),
    getListingData(listed.map((r) => ({
      symbol: r.symbol,
      listingDate: r.listingDate,
      issuePrice: capOfBand(r.priceBand),
    }))).catch(() => ({})),
  ]);

  for (const r of ipos) {
    const d = details[r.symbol];
    if (d) {
      if (d.categories.length) r.categories = d.categories;
      if (d.total !== null) r.subscription = d.total;
      if (d.info) r.info = d.info;
      if (!r.priceBand && d.info?.priceBand) r.priceBand = d.info.priceBand;
    }
    if (prices[r.symbol]) r.listing = prices[r.symbol];
  }

  return ipos;
}

/** Cap of a price band — what an allotted applicant actually paid. */
function capOfBand(band) {
  const nums = String(band || '').replace(/,/g, '').match(/\d+(\.\d+)?/g);
  return nums?.length ? Math.max(...nums.map(Number)) : null;
}

/** Fetch details for several symbols with a small concurrency cap. */
async function getIpoDetails(items, concurrency = 4) {
  const out = {};
  const queue = [...items];

  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length) {
        const item = queue.shift();
        try {
          let detail = await getIpoDetail(item.symbol, item.series || 'EQ').catch(() => null);
          // SME issues answer on their own series; EQ returns a thinner row.
          if ((!detail || !detail.categories.length) && item.series && item.series !== 'EQ') {
            detail = await getIpoDetail(item.symbol, item.series).catch(() => detail);
          }
          if (detail && (detail.categories.length || detail.info?.lotSize)) {
            out[item.symbol] = detail;
          }
        } catch {
          // One unavailable symbol must not sink the whole run.
        }
      }
    })
  );

  return out;
}

// ---------------------------------------------------------------- GMP fetch

/**
 * IPO Watch renders GMP as plain server-side <table>s: the first is Mainboard,
 * the second SME, and a third holds historical accuracy stats we ignore.
 */
async function getGmp() {
  const res = await fetch(GMP_URL, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
  if (!res.ok) throw new Error(`IPO Watch -> ${res.status}`);
  const html = await res.text();

  const tables = html.match(/<table[\s\S]*?<\/table>/g) || [];
  const out = [];

  tables.slice(0, 2).forEach((table, idx) => {
    const board = idx === 0 ? 'Mainboard' : 'SME';
    for (const row of table.match(/<tr[\s\S]*?<\/tr>/g) || []) {
      const cells = row.match(/<t[dh][\s\S]*?<\/t[dh]>/g) || [];
      const c = cells.map(stripTags);
      if (c.length < 7 || /ipo\s*name/i.test(c[0])) continue;
      const gain = String(c[4]).match(/\(([-\d.]+)%\)/);
      // The name cell links to that IPO's own page, which is where the
      // day-by-day GMP history lives. Some hrefs carry a doubled slash.
      const href = (cells[0].match(/href=["']([^"']+)["']/) || [])[1];
      out.push({
        name: c[0],
        key: nameKey(c[0]),
        board,
        gmp: parseMoney(c[1]),
        trend: /🟢/.test(c[2]) ? 'up' : /🔴/.test(c[2]) ? 'down' : 'flat',
        price: parseMoney(c[3]),
        estListing: parseMoney(c[4]),
        estGainPct: gain ? Number(gain[1]) : null,
        dates: c[5],
        status: String(c[6] || '').toLowerCase(),
        updated: c[7],
        page: href ? href.replace(/([^:])\/\/+/g, '$1/') : null,
      });
    }
  });

  return out;
}

// -------------------------------------------------- historical GMP backfill

const MONTH_NAMES = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8,
  sept: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * "28 August" plus a "09:07" clock reading into a UTC instant.
 *
 * IPO Watch prints no year and its clock is IST. A date more than a couple of
 * months ahead of today can only be last year's, which is the only case that
 * matters — histories run backwards from now, never forwards.
 */
function parseHistoryDate(dateText, timeText, now = new Date()) {
  const m = String(dateText || '').match(/(\d{1,2})\s+([A-Za-z]+)/);
  if (!m) return null;
  const month = MONTH_NAMES[m[2].toLowerCase()];
  if (month === undefined) return null;

  const t = String(timeText || '').match(/(\d{1,2}):(\d{2})/);
  const hh = t ? Number(t[1]) : 12;
  const mm = t ? Number(t[2]) : 0;

  // IST is UTC+5:30; build the instant directly rather than via local time.
  const at = (year) => Date.UTC(year, month, Number(m[1]), hh, mm) - 5.5 * 3600e3;

  let ms = at(now.getUTCFullYear());
  if (ms - now.getTime() > 60 * 86400e3) ms = at(now.getUTCFullYear() - 1);
  return new Date(ms).toISOString();
}

/** The day-by-day GMP page for an IPO, derived from its details page URL. */
function gmpHistoryUrl(pageUrl) {
  if (!pageUrl) return null;
  return pageUrl.replace(/\/+$/, '') + '-gmp-grey-market-premium/';
}

/**
 * Day-by-day GMP for one IPO, oldest first.
 *
 * IPO Watch keeps a "Date | IPO GMP | GMP Trend | Gain | Last Updated" table on
 * each IPO's GMP page — typically one to two weeks of it. That is history this
 * app cannot reconstruct itself, since it only sees the present on each run.
 */
async function getGmpHistoryFor(pageUrl) {
  const url = gmpHistoryUrl(pageUrl);
  if (!url) return [];

  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
  if (!res.ok) return [];
  const html = await res.text();

  const table = (html.match(/<table[\s\S]*?<\/table>/g) || [])
    .find((t) => /IPO\s*GMP/i.test(t) && /GMP\s*Trend/i.test(t));
  if (!table) return [];

  const points = [];
  for (const row of table.match(/<tr[\s\S]*?<\/tr>/g) || []) {
    const c = (row.match(/<t[dh][\s\S]*?<\/t[dh]>/g) || []).map(stripTags);
    if (c.length < 2 || /^date$/i.test(c[0])) continue;
    const gmp = parseMoney(c[1]);
    const t = parseHistoryDate(c[0], c[4]);
    if (gmp === null || !t) continue;
    points.push({ t, gmp });
  }

  points.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  return points;
}

/**
 * Backfill history for every IPO currently quoting a GMP.
 *
 * Points already recorded win: this app samples hourly, IPO Watch publishes
 * once a day, so a scraped day must not displace finer readings we captured
 * ourselves. Only days with nothing recorded are filled in.
 */
async function backfillHistory(history, gmpRows, concurrency = 4) {
  const queue = gmpRows.filter((r) => r.key && r.page);
  let added = 0, touched = 0;

  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length) {
        const row = queue.shift();
        let points;
        try {
          points = await getGmpHistoryFor(row.page);
        } catch {
          continue; // one unreachable page must not sink the backfill
        }
        if (!points.length) continue;

        const series = history[row.key] || (history[row.key] = { name: row.name, points: [] });
        const haveDays = new Set(series.points.map((p) => p.t.slice(0, 10)));

        const fresh = points.filter((p) => !haveDays.has(p.t.slice(0, 10)));
        if (!fresh.length) continue;

        series.points = [...series.points, ...fresh]
          .sort((a, b) => Date.parse(a.t) - Date.parse(b.t))
          .slice(-400);
        added += fresh.length;
        touched++;
      }
    })
  );

  return { added, touched };
}

// --------------------------------------------- listing & current price

const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/';

/**
 * Listing-day and latest price for an issue that has already listed.
 *
 * Once an IPO lists, grey market premium is meaningless — the real numbers are
 * what it opened at and what it trades at now. NSE's quote endpoint refuses
 * scripted access (403 even with its cookie handshake), so this uses Yahoo,
 * which serves NSE symbols as `SYMBOL.NS` and returns both in one response.
 *
 * `issuePrice` is the cap of the band, what an allotted applicant paid.
 */
async function getListingPrices(symbol, listingDate, issuePrice) {
  if (!symbol || !listingDate) return null;

  const from = Math.floor(Date.parse(listingDate) / 1000) - 86400;
  const url = `${YAHOO}${encodeURIComponent(symbol)}.NS` +
    `?period1=${from}&period2=9999999999&interval=1d`;

  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) return null;

  const body = await res.json();
  const result = body?.chart?.result?.[0];
  if (!result) return null;

  const closes = (result.indicators?.quote?.[0]?.close || []).filter((v) => v !== null);
  if (!closes.length) return null;

  // Yahoo returns full float precision (583.7999877929688); round to paise so
  // the stored JSON and the rendered figure agree.
  const r2 = (v) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);
  const listPrice = r2(closes[0]);
  const cmp = r2(result.meta?.regularMarketPrice ?? closes[closes.length - 1]);
  const pct = (v) => (issuePrice && v ? r2(((v - issuePrice) / issuePrice) * 100) : null);

  return {
    listPrice,
    cmp,
    issuePrice: issuePrice ?? null,
    listGainPct: pct(listPrice),
    cmpGainPct: pct(cmp),
    // Gain since listing is what says whether it held its opening pop.
    sinceListingPct: listPrice ? r2(((cmp - listPrice) / listPrice) * 100) : null,
    currency: result.meta?.currency || 'INR',
    asOf: new Date().toISOString(),
  };
}

/** Listing prices for many symbols, with a small concurrency cap. */
async function getListingData(items, concurrency = 4) {
  const out = {};
  const queue = [...items];

  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length) {
        const it = queue.shift();
        try {
          const d = await getListingPrices(it.symbol, it.listingDate, it.issuePrice);
          if (d) out[it.symbol] = d;
        } catch {
          // A missing or newly-listed symbol is normal, not an error.
        }
      }
    })
  );

  return out;
}

// ------------------------------------------------------------- GMP history

/**
 * Fold fresh GMP readings into a history object, one point per IPO per hour,
 * keeping the last 400 points each. Mutates and returns `history`.
 */
function recordHistory(history, gmpRows, nowIso) {
  const stamp = nowIso || new Date().toISOString();
  const bucket = stamp.slice(0, 13);

  for (const row of gmpRows) {
    if (!row.key || row.gmp === null || row.gmp === undefined) continue;
    const series = history[row.key] || (history[row.key] = { name: row.name, points: [] });
    series.name = row.name;
    const last = series.points[series.points.length - 1];
    if (last && last.t.slice(0, 13) === bucket) {
      last.gmp = row.gmp; // same hour, GMP moved: keep the latest value
      continue;
    }
    series.points.push({ t: stamp, gmp: row.gmp });
    if (series.points.length > 400) series.points = series.points.slice(-400);
  }
  return history;
}

/** Drop series with no reading in the last N days so the file stays small. */
function pruneHistory(history, days = 120) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  for (const [key, series] of Object.entries(history)) {
    const last = series.points[series.points.length - 1];
    if (!last || last.t < cutoff) delete history[key];
  }
  return history;
}

module.exports = {
  getIpos, getIposEnriched, getGmp, getIpoDetail, getIpoDetails, recordHistory, pruneHistory,
  getGmpHistoryFor, backfillHistory, gmpHistoryUrl, parseHistoryDate,
  getListingPrices, getListingData,
  nameKey, isoDate, stripTags, parseMoney, CATEGORIES, UA,
};
