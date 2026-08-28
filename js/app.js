/* IPO Tracker — application logic. Classic script (no modules) so the page
   still opens from file:// as a degraded fallback. */
(function () {
'use strict';

// ------------------------------------------------------------------ state

const LS = {
  ids: 'ipotracker.ids',
  history: 'ipotracker.history',
  snapshot: 'ipotracker.snapshot',
  registrars: 'ipotracker.registrars',
  theme: 'ipotracker.theme',
  filters: 'ipotracker.filters',
  range: 'ipotracker.range',
  aiTarget: 'ipotracker.aitarget',
};

const state = {
  ipos: [],
  gmp: [],
  history: {},
  reports: {},
  mode: null,          // 'server' | 'static' | 'proxy'
  fetchedAt: null,
  autoTimer: null,
  compareOff: new Set(),
  gmpSort: { col: 'gmpPct', dir: -1 },
  filters: { q: '', board: 'all', status: 'all', sort: 'closing' },
  range: 'all',
};

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => [...(r || document).querySelectorAll(s)];

const load = (k, d) => {
  try { const v = JSON.parse(localStorage.getItem(k)); return v === null ? d : v; }
  catch { return d; }
};
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

// ----------------------------------------------------------------- helpers

const MONTHS = { jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',
                 jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12' };

function nameKey(name){
  return String(name || '').toLowerCase().replace(/&amp;/g,'&')
    .replace(/\b(limited|ltd|private|pvt|india|indian|the|company|co)\b/g,'')
    .replace(/[^a-z0-9]/g,'');
}

function todayISO(){
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function fmtDate(iso){
  if (!iso) return '—';
  const [y,m,d] = iso.split('-');
  const n = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${Number(d)} ${n[Number(m)-1]}`;
}

const daysBetween = (a,b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

function relativeTime(iso){
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(mins)) return 'recently';
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins/60);
  if (hrs < 24) return `${hrs} hr${hrs===1?'':'s'} ago`;
  const days = Math.round(hrs/24);
  return `${days} day${days===1?'':'s'} ago`;
}

function money(n){
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return '₹' + Number(n).toLocaleString('en-IN');
}

function esc(s){
  return String(s ?? '').replace(/[&<>"]/g, (c) =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

function toast(msg){
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 1900);
}

// ---------------------------------------------------------------- fetching

const PROXIES = [
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
  (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
];

async function viaProxy(url, asText){
  let lastErr;
  for (const make of PROXIES){
    try {
      const res = await fetch(make(url), { cache:'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const text = await res.text();
      if (/^error code:/i.test(text)) throw new Error('proxy rejected');
      return asText ? text : JSON.parse(text);
    } catch (err){ lastErr = err; }
  }
  throw lastErr || new Error('all proxies failed');
}

const json = (u) => fetch(u, { cache:'no-store' }).then((r) => {
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
});

async function detectMode(){
  if (state.mode) return state.mode;
  try {
    const res = await fetch('api/health', { cache:'no-store' });
    if (res.ok && (await res.json()).ok === true) return (state.mode = 'server');
  } catch {}
  try {
    const d = await json('data/gmp.json');
    if (Array.isArray(d.gmp)) return (state.mode = 'static');
  } catch {}
  return (state.mode = 'proxy');
}

function isoFromNse(s){
  const m = String(s||'').match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (!m) return null;
  const mm = MONTHS[m[2].toLowerCase()];
  return mm ? `${m[3]}-${mm}-${m[1].padStart(2,'0')}` : null;
}

async function fetchIposDirect(){
  const base = 'https://www.nseindia.com/api/';
  const [cur, up, past] = await Promise.all([
    viaProxy(base+'ipo-current-issue').catch(()=>[]),
    viaProxy(base+'all-upcoming-issues?category=ipo').catch(()=>[]),
    viaProxy(base+'public-past-issues').catch(()=>[]),
  ]);
  const arr = (x) => Array.isArray(x) ? x : [];
  const bySymbol = new Map();
  const put = (r) => {
    if (!r.symbol) return;
    const prev = bySymbol.get(r.symbol) || {};
    for (const [k,v] of Object.entries(r)) if (v || v === 0) prev[k] = v;
    bySymbol.set(r.symbol, prev);
  };
  for (const r of arr(cur)) put({ symbol:r.symbol, company:r.companyName, series:r.series,
    start:isoFromNse(r.issueStartDate), end:isoFromNse(r.issueEndDate),
    priceBand:r.issuePrice, issueSize:r.issueSize,
    subscription: r.noOfTime ? Number(r.noOfTime) : null });
  for (const r of arr(up)) put({ symbol:r.symbol, company:r.companyName, series:r.series,
    start:isoFromNse(r.issueStartDate), end:isoFromNse(r.issueEndDate),
    priceBand:r.issuePrice, issueSize:r.issueSize });
  for (const r of arr(past)) put({ symbol:r.symbol, company:r.company, series:r.securityType,
    start:isoFromNse(r.ipoStartDate), end:isoFromNse(r.ipoEndDate), priceBand:r.priceRange,
    listingDate:(r.listingDate && r.listingDate !== '-') ? isoFromNse(r.listingDate) : null });
  return [...bySymbol.values()].map((r) => ({
    ...r, board: String(r.series||'').toUpperCase() === 'SME' ? 'SME' : 'Mainboard',
  }));
}

function stripTags(s){
  return s.replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&')
    .replace(/&#8377;|&#x20b9;/g,'₹').replace(/\s+/g,' ').trim();
}
function parseMoney(s){
  const m = String(s||'').replace(/,/g,'').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

async function fetchGmpDirect(){
  const html = await viaProxy('https://ipowatch.in/ipo-grey-market-premium-latest-ipo-gmp/', true);
  const tables = html.match(/<table[\s\S]*?<\/table>/g) || [];
  const out = [];
  tables.slice(0,2).forEach((table, idx) => {
    const board = idx === 0 ? 'Mainboard' : 'SME';
    for (const row of (table.match(/<tr[\s\S]*?<\/tr>/g) || [])){
      const c = (row.match(/<t[dh][\s\S]*?<\/t[dh]>/g) || []).map(stripTags);
      if (c.length < 7 || /ipo\s*name/i.test(c[0])) continue;
      const gain = String(c[4]).match(/\(([-\d.]+)%\)/);
      out.push({ name:c[0], key:nameKey(c[0]), board, gmp:parseMoney(c[1]),
        trend: /🟢/.test(c[2]) ? 'up' : /🔴/.test(c[2]) ? 'down' : 'flat',
        price:parseMoney(c[3]), estListing:parseMoney(c[4]),
        estGainPct: gain ? Number(gain[1]) : null,
        dates:c[5], status:String(c[6]).toLowerCase(), updated:c[7] });
    }
  });
  return out;
}

function recordLocalHistory(rows){
  const h = state.history;
  const stamp = new Date().toISOString();
  const bucket = stamp.slice(0,13);
  for (const r of rows){
    if (!r.key || r.gmp === null) continue;
    const s = h[r.key] || (h[r.key] = { name:r.name, points:[] });
    s.name = r.name;
    const last = s.points[s.points.length-1];
    if (last && last.t.slice(0,13) === bucket){ last.gmp = r.gmp; continue; }
    s.points.push({ t: stamp, gmp: r.gmp });
    if (s.points.length > 400) s.points = s.points.slice(-400);
  }
  save(LS.history, h);
}

async function refresh(){
  const btn = $('#refresh');
  btn.disabled = true;
  btn.textContent = 'Refreshing…';

  const mode = await detectMode();
  let ipoJob, gmpJob;

  if (mode === 'server'){
    ipoJob = json('api/ipos').then((d) => d.ipos);
    gmpJob = json('api/gmp');
  } else if (mode === 'static'){
    ipoJob = json('data/ipos.json').then((d) => d.ipos);
    gmpJob = Promise.all([
      json('data/gmp.json'),
      json('data/gmp-history.json').catch(() => ({})),
    ]).then(([g, history]) => ({ gmp: g.gmp, history, fetchedAt: g.fetchedAt }));
  } else {
    ipoJob = fetchIposDirect();
    gmpJob = fetchGmpDirect().then((gmp) => ({ gmp }));
  }

  // Reports are optional everywhere — absence is not an error.
  const reportJob = json('data/reports.json').catch(() => null);

  const [ipoRes, gmpRes, repRes] = await Promise.allSettled([ipoJob, gmpJob, reportJob]);

  if (ipoRes.status === 'fulfilled' && ipoRes.value?.length){
    state.ipos = ipoRes.value;
    $('#src-ipo').innerHTML = `IPOs <b>${state.ipos.length}</b> from NSE`;
    $('#src-ipo').classList.remove('err');
  } else {
    $('#src-ipo').textContent = 'IPOs: fetch failed';
    $('#src-ipo').classList.add('err');
  }

  if (gmpRes.status === 'fulfilled' && gmpRes.value?.gmp?.length){
    state.gmp = gmpRes.value.gmp;
    if (gmpRes.value.history) state.history = { ...state.history, ...gmpRes.value.history };
    state.fetchedAt = gmpRes.value.fetchedAt || new Date().toISOString();
    recordLocalHistory(state.gmp);
    histKeyCache.clear();
    $('#src-gmp').innerHTML = `GMP <b>${state.gmp.length}</b> from IPO Watch`;
    $('#src-gmp').classList.remove('err');
  } else {
    $('#src-gmp').textContent = 'GMP: fetch failed';
    $('#src-gmp').classList.add('err');
  }

  state.reports = (repRes.status === 'fulfilled' && repRes.value?.reports) || {};
  const nReports = Object.keys(state.reports).length;
  $('#src-report').textContent = nReports
    ? `${nReports} AI report${nReports === 1 ? '' : 's'}`
    : 'AI reports: not configured';

  $('#mode').textContent = {
    server: 'live via local server',
    static: `published data · ${state.fetchedAt ? relativeTime(state.fetchedAt) : 'updated'}`,
    proxy:  'no data source — using public proxies',
  }[mode];

  if (state.ipos.length || state.gmp.length){
    save(LS.snapshot, { ipos: state.ipos, gmp: state.gmp, at: Date.now() });
  }

  showBanner(mode, ipoRes, gmpRes);
  render();

  btn.disabled = false;
  btn.textContent = 'Refresh';
}

function showBanner(mode, ipoRes, gmpRes){
  const failed = ipoRes.status !== 'fulfilled' || gmpRes.status !== 'fulfilled'
              || !state.ipos.length || !state.gmp.length;
  const el = $('#offline-banner');
  if (!failed){ el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = {
    server: `<b>Some data did not load.</b> The server is running but an upstream
      (NSE or IPO Watch) did not respond. Showing the last successful fetch —
      try Refresh again in a minute.`,
    static: `<b>Published data is incomplete.</b> The scheduled fetch could not reach
      one of the sources on its last run. It retries every 30 minutes.`,
    proxy:  `<b>No data source available.</b> NSE and IPO Watch send no CORS headers,
      so a page opened straight from disk has to route through public proxies that are
      usually rate-limited or down. Run <code>node server.js</code> in this folder and
      open <code>http://localhost:8787</code>, or use the published site.`,
  }[mode];
}

// ----------------------------------------------------------------- merging

function gmpFor(name){
  const key = nameKey(name);
  if (!key) return null;
  let best = null;
  for (const g of state.gmp){
    if (!g.key) continue;
    if (g.key === key) return g;
    if (key.startsWith(g.key) || g.key.startsWith(key)){
      if (!best || g.key.length > best.key.length) best = g;
    }
  }
  return best;
}

function classify(r){
  const t = todayISO();
  if (r.start && t < r.start) return 'upcoming';
  if (r.end && t > r.end) return 'closed';
  if (r.start && r.end) return 'open';
  return 'upcoming';
}

function parseGmpDates(s){
  const m = String(s||'').match(/(\d{1,2})\s*[-–]\s*(\d{1,2})\s+([A-Za-z]+)/);
  if (!m) return { start:null, end:null };
  const mon = MONTHS[m[3].slice(0,3).toLowerCase()];
  if (!mon) return { start:null, end:null };
  const now = new Date();
  let year = now.getFullYear();
  if (Number(mon) < now.getMonth() + 1 - 6) year += 1;
  const end = `${year}-${mon}-${m[2].padStart(2,'0')}`;
  const startDay = Number(m[1]);
  let startMon = Number(mon), startYear = year;
  if (startDay > Number(m[2])){
    startMon -= 1;
    if (startMon === 0){ startMon = 12; startYear -= 1; }
  }
  return {
    start: `${startYear}-${String(startMon).padStart(2,'0')}-${String(startDay).padStart(2,'0')}`,
    end,
  };
}

/** One unified row per IPO: NSE facts + GMP + any AI report. */
function allIpos(){
  const rows = state.ipos.map((ipo) => {
    const g = gmpFor(ipo.company);
    const key = nameKey(ipo.company);
    return {
      key,
      // GMP history is stored under the IPO Watch name, which is often shorter
      // than the NSE one ("ESDS Software" vs "ESDS Software Solution Limited").
      // Look history up by the row we actually matched, or nothing is found.
      histKey: g?.key || key,
      name: ipo.company, symbol: ipo.symbol,
      board: ipo.board || 'Mainboard',
      start: ipo.start, end: ipo.end, listingDate: ipo.listingDate,
      priceBand: ipo.priceBand, issueSize: ipo.issueSize,
      subscription: ipo.subscription ?? null,
      categories: ipo.categories || null,
      info: ipo.info || null,
      listing: ipo.listing || null,
      gmp: g?.gmp ?? null, trend: g?.trend ?? null,
      estGainPct: g?.estGainPct ?? null, price: g?.price ?? null,
      hasNse: true,
    };
  });

  const seen = new Set(rows.map((r) => r.key));
  for (const g of state.gmp){
    if (!g.key || seen.has(g.key)) continue;
    if (rows.some((r) => r.key.startsWith(g.key) || g.key.startsWith(r.key))) continue;
    const { start, end } = parseGmpDates(g.dates);
    rows.push({
      key:g.key, histKey:g.key, name:g.name, symbol:null, board:g.board, start, end,
      priceBand: g.price ? '₹'+g.price : null, issueSize:null,
      subscription:null, categories:null, info:null, listing:null,
      gmp:g.gmp, trend:g.trend, estGainPct:g.estGainPct, price:g.price,
      hasNse:false, statusHint:g.status,
    });
  }

  return rows.map((r) => ({
    ...r,
    status: (r.start || r.end) ? classify(r) : (r.statusHint || 'upcoming'),
    gmpPct: (r.gmp !== null && r.price) ? (r.gmp / r.price) * 100 : null,
    report: state.reports[r.key]?.report || null,
    reportMeta: state.reports[r.key] || null,
  }));
}

// ---------------------------------------------------------------- history

// ------------------------------------------------------------ time ranges

/**
 * One control drives every GMP chart. Ranges run from hours to months because
 * history accumulates on each refresh: a new install has only minutes of data
 * and needs the short end, while a long-running issue wants the wide view.
 */
const RANGES = [
  { key: '6h',  label: '6h',  ms: 6 * 3600e3 },
  { key: '24h', label: '24h', ms: 24 * 3600e3 },
  { key: '3d',  label: '3d',  ms: 3 * 86400e3 },
  { key: '7d',  label: '7d',  ms: 7 * 86400e3 },
  { key: '30d', label: '30d', ms: 30 * 86400e3 },
  { key: 'all', label: 'All', ms: Infinity },
];

const rangeMs = (key) => (RANGES.find((r) => r.key === key) || RANGES[5]).ms;

/** Trim a point series to the selected window. */
function inRange(points, key){
  const ms = rangeMs(key || state.range);
  if (!Number.isFinite(ms)) return points;
  const cutoff = Date.now() - ms;
  return points.filter((p) => p.t >= cutoff);
}

/** One range applies everywhere, so switching it in the modal holds on the tab. */
function setRange(key){
  if (!RANGES.some((r) => r.key === key)) return;
  state.range = key;
  save(LS.range, key);
}

/** Milliseconds between the oldest and newest reading across some series. */
function historySpan(pointLists){
  let lo = Infinity, hi = -Infinity;
  for (const pts of pointLists){
    for (const p of pts){
      if (p.t < lo) lo = p.t;
      if (p.t > hi) hi = p.t;
    }
  }
  return hi > lo ? hi - lo : 0;
}

function humanSpan(ms){
  const hrs = ms / 3600e3;
  if (hrs < 1) return `${Math.max(1, Math.round(ms / 60e3))} min`;
  if (hrs < 48) return `${Math.round(hrs)}h`;
  return `${Math.round(hrs / 24)} days`;
}

/**
 * Render the range control, disabling windows wider than the history actually
 * held. With eighteen hours recorded, 24h through 30d would all draw the exact
 * same line — offering them as live choices makes the control look broken.
 * "All" always stays available as the canonical everything option.
 */
function renderRange(host, span){
  if (!host) return;

  const usable = (r) => r.key === 'all' || !span || r.ms < span;

  // A disabled selection would strand the chart, so fall back to All.
  const current = RANGES.find((r) => r.key === state.range);
  if (current && !usable(current)) state.range = 'all';

  host.innerHTML = RANGES.map((r) => {
    const on = state.range === r.key;
    const off = !usable(r);
    return `<button class="chip small ${on ? 'on' : ''}" data-range="${r.key}"
      aria-pressed="${on}" ${off ? 'disabled' : ''}
      title="${off ? `Only ${humanSpan(span)} of history recorded so far` : `Last ${r.label}`}"
      >${r.label}</button>`;
  }).join('') + (span
    ? `<span class="range-note">${humanSpan(span)} recorded</span>`
    : '');
}

/**
 * History is written under the IPO Watch name. Once an issue closes it drops
 * off that list, so the row falls back to its NSE key and would lose its own
 * history. Match the stored key by prefix in that case, and cache the result.
 */
const histKeyCache = new Map();

function resolveHistKey(key){
  if (!key) return key;
  if (state.history[key]?.points?.length) return key;
  if (histKeyCache.has(key)) return histKeyCache.get(key);

  let best = null;
  for (const k of Object.keys(state.history)){
    if (!state.history[k]?.points?.length) continue;
    if (key.startsWith(k) || k.startsWith(key)){
      if (!best || k.length > best.length) best = k;
    }
  }
  const resolved = best || key;
  histKeyCache.set(key, resolved);
  return resolved;
}

function historyPoints(key){
  const pts = state.history[resolveHistKey(key)]?.points || [];
  return pts.map((p) => ({ t: Date.parse(p.t), v: p.gmp })).filter((p) => Number.isFinite(p.t));
}

function gmpChange(key){
  const pts = state.history[resolveHistKey(key)]?.points || [];
  if (pts.length < 2) return null;
  return pts[pts.length-1].gmp - pts[0].gmp;
}

function sparkline(key, w = 74, h = 22){
  const pts = historyPoints(resolveHistKey(key));
  if (pts.length < 2) return `<span style="font-size:11px;color:var(--faint)">collecting…</span>`;
  const vals = pts.map((p) => p.v);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const step = (w-2) / (vals.length-1);
  const d = vals.map((v,i) => `${(1+i*step).toFixed(1)},${(h-2-((v-min)/span)*(h-4)).toFixed(1)}`).join(' ');
  const delta = vals[vals.length-1] - vals[0];
  const col = delta > 0 ? 'var(--good)' : delta < 0 ? 'var(--critical)' : 'var(--warning)';
  const last = d.split(' ').pop().split(',');
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <polyline points="${d}" fill="none" stroke="${col}" stroke-width="1.6"
      stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="2" fill="${col}"/></svg>`;
}

// ---------------------------------------------------------------- filters

function applyFilters(rows){
  const f = state.filters;
  const q = f.q.toLowerCase();

  let out = rows.filter((r) => {
    if (f.board !== 'all' && r.board !== f.board) return false;
    if (f.status !== 'all' && r.status !== f.status) return false;
    if (q && !String(r.name).toLowerCase().includes(q)
          && !String(r.symbol||'').toLowerCase().includes(q)) return false;
    return true;
  });

  const nullsLast = (v) => (v === null || v === undefined) ? -Infinity : v;
  const sorters = {
    closing:   (a,b) => String(a.end||'9').localeCompare(String(b.end||'9')),
    gmp:       (a,b) => nullsLast(b.gmpPct) - nullsLast(a.gmpPct),
    subscribed:(a,b) => nullsLast(b.subscription) - nullsLast(a.subscription),
    name:      (a,b) => String(a.name).localeCompare(String(b.name)),
  };
  out.sort(sorters[f.sort] || sorters.closing);
  return out;
}

// -------------------------------------------------------------- rendering

function statusOrder(id){ return { open:0, upcoming:1, closed:2 }[id]; }

function renderIpos(){
  const t = todayISO();
  const rows = applyFilters(allIpos());

  const groups = [
    { id:'open',     label:'Open now',        rows: rows.filter((r)=>r.status==='open') },
    { id:'upcoming', label:'Upcoming',        rows: rows.filter((r)=>r.status==='upcoming') },
    { id:'closed',   label:'Recently closed', rows: rows.filter((r)=>
        r.status==='closed' && (!r.end || daysBetween(r.end,t) <= 45)) },
  ].filter((g) => state.filters.status === 'all' || state.filters.status === g.id)
   .sort((a,b) => statusOrder(a.id) - statusOrder(b.id));

  const total = groups.reduce((n,g) => n + g.rows.length, 0);
  $('#result-count').textContent = `${total} IPO${total===1?'':'s'}`;

  $('#ipo-groups').innerHTML = groups.map((g) => `
    <div class="group-title">${g.label} <span class="count">${g.rows.length}</span></div>
    ${g.rows.length
      ? `<div class="cards">${g.rows.map((r) => card(r, t)).join('')}</div>`
      : `<div class="empty">Nothing matches these filters.</div>`}
  `).join('') || `<div class="empty">Nothing matches these filters.</div>`;
}

function timingText(r, t){
  if (r.status === 'open' && r.end){
    const d = daysBetween(t, r.end);
    if (d <= 0) return '<span class="urgent">closes today</span>';
    if (d === 1) return '<span class="urgent">closes tomorrow</span>';
    return `closes in ${d} days`;
  }
  if (r.status === 'upcoming' && r.start){
    const d = daysBetween(t, r.start);
    return d <= 0 ? 'opens today' : d === 1 ? 'opens tomorrow' : `opens in ${d} days`;
  }
  return r.end ? `closed ${daysBetween(r.end, t)} days ago` : '';
}

function verdictChip(report){
  if (!report) return '';
  const v = report.verdict;
  const label = v === 'apply' ? 'Apply' : v === 'avoid' ? 'Avoid' : 'Neutral';
  return `<span class="verdict-chip verdict-${esc(v)}">${label}</span>`;
}

const signed = (n, digits = 1) =>
  `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`;

const moveClass = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat');

/**
 * The bottom line of a card. Once an issue has listed, its grey market premium
 * is history — what matters is where it opened and where it trades now, so
 * listed issues show that instead.
 */
function bottomLine(r){
  const L = r.listing;
  if (L && L.cmp !== null){
    const gain = L.cmpGainPct;
    return `<div class="gmpline">
      <span class="gmpval ${gain === null ? 'flat' : moveClass(gain)}">${money(L.cmp)}</span>
      <span class="gain">now${gain !== null ? ` · ${signed(gain)} vs issue` : ''}</span>
      ${L.listGainPct !== null
        ? `<span class="listpill ${moveClass(L.listGainPct)}"
             title="Closing price on listing day versus the issue price"
             >listed ${signed(L.listGainPct)}</span>`
        : ''}
    </div>`;
  }
  return `<div class="gmpline">
    <span class="gmpval ${moveClass(r.gmp ?? 0)}">${r.gmp === null ? '—' : money(r.gmp)}</span>
    <span class="gain">GMP${r.gmpPct !== null ? ` · ${signed(r.gmpPct)}` : ''}</span>
    ${sparkline(r.histKey)}
  </div>`;
}

function card(r, t){
  const L = r.listing;
  return `<article class="card ${r.status}" tabindex="0" data-open="${esc(r.key)}">
    <h3>${esc(r.name)} ${r.board === 'SME' ? '<span class="tag">SME</span>' : ''}</h3>
    <div class="sub">${r.symbol ? esc(r.symbol)+' · ' : ''}${timingText(r, t)}</div>
    <dl class="kv">
      <dt>Dates</dt><dd>${fmtDate(r.start)} – ${fmtDate(r.end)}</dd>
      <dt>Price band</dt><dd>${esc(r.priceBand || '—')}</dd>
      ${r.subscription != null ? `<dt>Subscribed</dt><dd><b>${r.subscription.toFixed(2)}×</b></dd>` : ''}
      ${r.listingDate ? `<dt>Listing</dt><dd>${fmtDate(r.listingDate)}</dd>` : ''}
      ${L && L.listPrice !== null ? `<dt>Listed at</dt><dd>${money(L.listPrice)}</dd>` : ''}
    </dl>
    ${bottomLine(r)}
    ${r.report ? `<div style="margin-top:9px">${verdictChip(r.report)}</div>` : ''}
  </article>`;
}

// ------------------------------------------------------------- today tab

function renderToday(){
  const t = todayISO();
  const rows = allIpos()
    .filter((r) => r.status === 'open')
    .sort((a, b) => {
      // Closing today comes first — that is the decision that expires.
      const ad = a.end ? daysBetween(t, a.end) : 99;
      const bd = b.end ? daysBetween(t, b.end) : 99;
      if (ad !== bd) return ad - bd;
      return (b.gmpPct ?? -1) - (a.gmpPct ?? -1);
    });

  const closingToday = rows.filter((r) => r.end === t).length;
  $('#today-title').textContent = `Today · ${fmtDate(t)}`;
  $('#today-sub').textContent = rows.length
    ? `${rows.length} IPO${rows.length === 1 ? '' : 's'} open for application` +
      (closingToday ? ` · ${closingToday} clos${closingToday === 1 ? 'es' : 'e'} today` : '')
    : 'No IPOs are open for application right now.';

  const target = load(LS.aiTarget, 'google');
  $('#today-actions').innerHTML = rows.length
    ? `<select id="ai-target" aria-label="Which AI to open">${
        AI_TARGETS.map((a) =>
          `<option value="${a.id}" ${a.id === target ? 'selected' : ''}>${a.label}</option>`).join('')
      }</select>
      <button class="primary" data-ai="all">Ask about all ${rows.length}</button>
      <button data-copy="all">Copy details</button>`
    : '';

  if (!rows.length){
    $('#today-list').innerHTML =
      `<div class="empty">Nothing is open today. The IPOs tab lists what is coming up.</div>`;
    return;
  }

  $('#today-list').innerHTML = rows.map((r) => todayCard(r, t)).join('');
}

function todayCard(r, t){
  const opts = categoryOptions(r);
  const rec = recommendCategory(r);
  const hasTimes = opts.some((o) => o.times !== null);
  // Fewest applications is the closest thing to best odds when NSE gives no
  // multiple — it ignores quota size, so it is a hint, not a calculation.
  // Retail, sHNI and bHNI only — the three an individual can choose between.
  const totalApps = opts.reduce((n, o) => n + (o.applications || 0), 0);
  const best = hasTimes
    ? opts.filter((o) => o.times !== null)
        .reduce((a, b) => (a === null || b.times < a.times ? b : a), null)
    : null;
  const days = r.end ? daysBetween(t, r.end) : null;

  const urgency = days === 0 ? 'closes today'
    : days === 1 ? 'closes tomorrow'
    : `closes in ${days} days`;

  return `<article class="today-card ${days === 0 ? 'urgent' : ''}" data-key="${esc(r.key)}">
    <div class="today-card-head">
      <div class="grow">
        <h3>${esc(r.name)} ${r.board === 'SME' ? '<span class="tag">SME</span>' : ''}</h3>
        <div class="sub">
          <span class="${days === 0 ? 'urgent' : ''}">${urgency}</span>
          · ${esc(r.priceBand || 'band not announced')}
          ${r.subscription != null ? ` · ${r.subscription.toFixed(2)}× overall` : ''}
          ${r.gmp !== null ? ` · GMP ${money(r.gmp)}${r.gmpPct !== null ? ` (${signed(r.gmpPct)})` : ''}` : ''}
        </div>
      </div>
      ${r.report ? verdictChip(r.report) : ''}
    </div>

    ${rec ? `<div class="verdict-line">
      <span class="pick">Apply under <b>${esc(rec.pick.label)}</b></span>
      <span class="why">${esc(rec.why)}</span>
    </div>` : `<div class="verdict-line">
      <span class="why">${esc(noRecReason(r, opts))}</span>
    </div>`}

    ${opts.length ? `<table class="cat-table">
      <thead><tr><th>Category</th><th>Minimum</th>
        <th>${hasTimes ? 'Subscribed' : 'Applications'}</th>
        <th>${hasTimes ? 'Odds of a lot' : 'Share of applicants'}</th></tr></thead>
      <tbody>${opts.map((o) => `
        <tr class="${best && o.key === best.key ? 'best' : ''}">
          <td>${esc(o.label)}</td>
          <td>${inr(o.amount)}<span class="lots"> · ${o.lots} lot${o.lots === 1 ? '' : 's'}</span></td>
          <td>${hasTimes
            ? (o.times === null ? '—' : o.times.toFixed(2) + '×')
            : (o.applications === null ? '—' : o.applications.toLocaleString('en-IN'))}</td>
          <td>${hasTimes
            ? (o.times === null ? '—'
               : o.times <= 1 ? 'full allotment likely'
               : `about 1 in ${o.times.toFixed(1)}`)
            : (o.applications === null || !totalApps ? '—'
               : `${((o.applications / totalApps) * 100).toFixed(1)}% of applicants`)}</td>
        </tr>`).join('')}</tbody>
    </table>` : ''}

    <div class="row today-row">
      <button data-ai="${esc(r.key)}">Ask AI about this IPO</button>
      <button data-copy="${esc(r.key)}">Copy details</button>
      <button data-open="${esc(r.key)}">Full detail</button>
    </div>
  </article>`;
}

/** Why no category could be recommended — the reasons are quite different. */
function noRecReason(r, opts){
  if (!opts.length){
    return r.info?.lotSize
      ? 'Price band not announced yet, so the per-category amounts cannot be worked out.'
      : 'Lot size not published yet, so the per-category amounts cannot be worked out.';
  }
  if (!r.categories?.length){
    return 'Category-wise bids are not published yet — they appear once bidding is under way.';
  }
  return 'NSE publishes no per-category subscription multiple for SME issues, so the ' +
         'odds cannot be calculated. The application counts below are the best guide.';
}

/** The rows a Today action applies to: one IPO, or every open one. */
function todayRows(which){
  const open = allIpos().filter((r) => r.status === 'open');
  return which === 'all' ? open : open.filter((r) => r.key === which);
}

// Browsers and servers start truncating URLs somewhere past 8KB. The brief
// carries every live figure, so on a busy day it can approach that — send the
// clipboard instead of a URL that would arrive cut in half.
const MAX_URL_PROMPT = 6000;

function openAiWith(rows){
  if (!rows.length) return;
  const prompt = aiPrompt(rows);
  const target = AI_TARGETS.find((x) => x.id === load(LS.aiTarget, 'google')) || AI_TARGETS[0];

  // Always copy: it is the reliable path, and the fallback if the site drops
  // the query parameter.
  const copied = navigator.clipboard?.writeText(prompt)
    .then(() => true).catch(() => false) ?? Promise.resolve(false);

  const tooLong = prompt.length > MAX_URL_PROMPT;
  window.open(tooLong ? target.blank : target.url(prompt), '_blank', 'noopener');

  copied.then((ok) => {
    if (tooLong){
      toast(ok
        ? `${rows.length} IPOs is too much for a URL — prompt copied, paste it into ${target.label}`
        : `Too long for a URL and the clipboard was blocked — use Copy details`);
    } else {
      toast(ok
        ? `Opened ${target.label} — prompt also copied, paste if it arrives empty`
        : `Opened ${target.label}`);
    }
  });
}

// --------------------------------------------------------------- GMP tab

function renderGmp(){
  const rows = applyFilters(allIpos())
    .filter((r) => r.gmp !== null)
    .map((r) => ({ ...r, change: gmpChange(r.histKey) }));

  renderCompareChart(rows);

  const { col, dir } = state.gmpSort;
  const sorted = [...rows].sort((a,b) => {
    const av = a[col], bv = b[col];
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    return (typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv))) * dir;
  });

  $$('#gmp-table th[data-sort]').forEach((th) => {
    th.setAttribute('aria-sort',
      th.dataset.sort === col ? (dir === 1 ? 'ascending' : 'descending') : 'none');
  });

  $('#gmp-table tbody').innerHTML = sorted.map((r) => {
    const cls = r.gmp > 0 ? 'up' : r.gmp < 0 ? 'down' : 'flat';
    const ch = r.change;
    return `<tr class="clickable" data-open="${esc(r.key)}">
      <td>${esc(r.name)}</td>
      <td><span class="tag">${r.board}</span></td>
      <td>${esc(r.status)}</td>
      <td class="num">${money(r.price)}</td>
      <td class="num ${cls}"><b>${money(r.gmp)}</b></td>
      <td class="num">${r.gmpPct !== null ? (r.gmpPct>0?'+':'')+r.gmpPct.toFixed(1)+'%' : '—'}</td>
      <td class="num">${r.subscription != null ? r.subscription.toFixed(2)+'×' : '—'}</td>
      <td class="num ${ch>0?'up':ch<0?'down':''}">${ch===null?'—':(ch>0?'+':'')+ch}</td>
      <td>${sparkline(r.histKey)}</td>
      <td>${verdictChip(r.report) || '—'}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="10" class="empty">No GMP data for these filters.</td></tr>`;
}

/** Multi-series GMP-over-time comparison for the most active issues. */
function renderCompareChart(rows){
  const wrap = $('#compare-chart');

  // Span is measured over the unfiltered history, so the control can say which
  // windows would show anything new.
  renderRange($('#compare-range'), historySpan(
    rows.filter((r) => r.status !== 'closed').map((r) => historyPoints(r.histKey))
  ));

  const candidates = rows
    .filter((r) => r.status !== 'closed' && inRange(historyPoints(r.histKey)).length >= 2)
    .sort((a,b) => (b.gmpPct ?? -1) - (a.gmpPct ?? -1))
    .slice(0, 6);

  if (!candidates.length){
    // Distinguish "nothing recorded yet" from "nothing inside this window",
    // since the fix for the second one is to widen the range.
    const anyHistory = rows.some((r) => historyPoints(r.histKey).length >= 2);
    wrap.innerHTML = anyHistory
      ? `<p class="chart-empty">No readings in the last ${
          RANGES.find((x) => x.key === state.range)?.label || 'window'
        } — pick a wider range.</p>`
      : `<p class="chart-empty">Not enough history yet to compare —
         each refresh adds a point. Come back after a few updates.</p>`;
    $('#compare-legend').innerHTML = '';
    return;
  }

  // Plotted as a percentage of issue price, not rupees. A ₹335 premium on a
  // ₹429 share and a ₹50 premium on an ₹82 share are comparable returns, but
  // on a rupee axis the cheap issue is squashed flat against the baseline.
  // Colour follows the entity (its key), so hiding one never repaints the rest.
  const series = candidates.map((r, i) => ({
    name: r.name,
    key: r.key,
    color: `var(--series-${(i % 6) + 1})`,
    points: r.price
      ? inRange(historyPoints(r.histKey))
          .map((p) => ({ t: p.t, v: Number(((p.v / r.price) * 100).toFixed(1)) }))
      : [],
  })).filter((s) => s.points.length >= 2);

  const shown = series.filter((s) => !state.compareOff.has(s.key));
  Charts.lineChart(wrap, shown, {
    height: 240, suffix: '%', ariaLabel: 'Grey market premium as a percentage of issue price, over time',
  });

  $('#compare-legend').innerHTML = series.map((s) => `
    <span class="legend-item ${state.compareOff.has(s.key) ? 'off' : ''}" data-legend="${esc(s.key)}">
      <span class="tip-swatch" style="background:${s.color}"></span>${esc(s.name)}
    </span>`).join('');
}

// ----------------------------------------------------------------- modal

const REGISTRARS = [
  { name:'MUFG Intime (Link Intime)', url:'https://in.mpms.mufg.com/Initial_Offer/public-issues.html' },
  { name:'KFin Technologies',          url:'https://kosmic.kfintech.com/ipostatus/' },
  { name:'Bigshare Services',          url:'https://ipo.bigshareonline.com/ipo_status.html' },
  { name:'Maashitla Securities',       url:'https://maashitla.com/allotment-status/public-issues' },
  { name:'Skyline Financial',          url:'https://www.skylinerta.com/ipo.php' },
  { name:'Cameo Corporate',            url:'https://ipo.cameoindia.com/' },
  { name:'Purva Sharegistry',          url:'https://www.purvashare.com/investor-service/ipo-query' },
  { name:'Integrated Registry',        url:'https://kprism.integratedregistry.in/ipo.aspx' },
  { name:'BSE (any issue)',            url:'https://www.bseindia.com/investors/appli_check.aspx' },
];

const CATEGORY_LABEL = { retail:'Retail', shni:'sHNI (₹2L–₹10L)', bhni:'bHNI (above ₹10L)', none:'—' };

/** Cap of the price band — the price an applicant actually bids at. */
function capPrice(r){
  if (r.price) return r.price;
  const nums = String(r.priceBand || '').replace(/,/g,'').match(/\d+(\.\d+)?/g);
  return nums && nums.length ? Math.max(...nums.map(Number)) : null;
}

function inr(n){
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  if (n >= 1e7) return `₹${(n/1e7).toFixed(2)} cr`;
  if (n >= 1e5) return `₹${(n/1e5).toFixed(2)} L`;
  return '₹' + Math.round(n).toLocaleString('en-IN');
}

/**
 * The concrete figures behind an apply decision: what one lot costs, what it
 * would gain at the current premium, and the odds of actually being allotted.
 * Everything here is derived from data already on the page — nothing new is
 * fetched, and rows with no basis are left out rather than shown as em-dashes.
 */
function renderFacts(host, r){
  if (!host) return;

  const cap = capPrice(r);
  const lot = r.info?.lotSize || null;
  const shares = r.issueSize ? Number(r.issueSize) : null;
  const retail = (r.categories || []).find((c) => c.key === 'retail');

  const facts = [];
  // `text: true` marks a prose value (a name, a list) so it does not wear the
  // large bold treatment the numbers use.
  const add = (label, value, note, text) => {
    if (value) facts.push({ label, value, note, text });
  };

  add('Total issue size',
    shares && cap ? inr(shares * cap) : null,
    shares ? `${shares.toLocaleString('en-IN')} shares` +
             (cap ? ` at the ₹${cap} cap price` : '') : '');

  add('Lot size', lot ? `${lot} shares` : null,
    r.info?.faceValue ? `face value ₹${r.info.faceValue}` : '');

  add('Minimum application', lot && cap ? inr(lot * cap) : null, 'one lot at the cap price');

  // Above ₹2L an application is no longer retail, so the lot count that keeps
  // you inside the retail cap is a real decision the applicant makes.
  if (lot && cap){
    const perLot = lot * cap;
    const maxRetail = r.info?.maxRetailAmount || 200000;
    const lots = Math.floor(maxRetail / perLot);
    if (lots >= 1){
      add('Retail limit', `${lots} lot${lots === 1 ? '' : 's'}`,
        `up to ${inr(lots * perLot)}, under the ${inr(maxRetail)} retail cap`);
    }
  }

  // Only meaningful before listing. Afterwards the realised figures below
  // replace it — a GMP-derived projection for a share that already trades is
  // just a stale guess sitting next to the real number.
  const hasListed = !!(r.listing && r.listing.cmp !== null);
  if (lot && !hasListed && r.gmp !== null && r.gmp !== undefined){
    add('Gain on one lot', inr(lot * r.gmp),
      'at the current premium, if it lists there — GMP is not a forecast');
  }

  // Once a category is oversubscribed allotment is a lottery, so the multiple
  // is directly the odds of a single application getting one lot.
  if (retail){
    add('Retail allotment odds',
      retail.times > 1 ? `about 1 in ${retail.times.toFixed(1)}` : 'likely full allotment',
      retail.times > 1
        ? `retail is ${retail.times.toFixed(2)}× subscribed`
        : `retail is only ${retail.times.toFixed(2)}× subscribed`);
  }

  // The listed price and current price are already the headline stats above,
  // so this panel adds only what they do not say: the move since listing day,
  // and what a single lot is now worth against what it cost.
  const L = r.listing;
  if (hasListed){
    if (L.sinceListingPct !== null){
      add('Since listing', signed(L.sinceListingPct),
        L.listPrice !== null ? `from ${money(L.listPrice)} on listing day` : '');
    }
    if (lot && cap && L.cmpGainPct !== null){
      add('One lot today', inr(lot * L.cmp),
        `${signed(L.cmpGainPct)} on the ${inr(lot * cap)} one lot cost`);
    }
  }

  add('Registrar', r.info?.registrar, 'handles allotment and refunds', true);
  add('Lead managers', r.info?.leadManagers, '', true);

  if (!facts.length){
    host.innerHTML = `<p class="chart-empty">NSE has not published the issue terms yet.</p>`;
    return;
  }

  host.innerHTML = facts.map((f) => `
    <div class="fact${f.text ? ' fact-prose' : ''}">
      <dt>${esc(f.label)}</dt>
      <dd>${esc(f.value)}</dd>
      ${f.note ? `<p class="fact-note">${esc(f.note)}</p>` : ''}
    </div>`).join('') + docLinks(r);
}

/** Direct links to the official documents, when NSE published them. */
function docLinks(r){
  const links = [
    ['Red herring prospectus', r.info?.rhpUrl],
    ['Basis of issue price', r.info?.ratiosUrl],
    ['Anchor allocation', r.info?.anchorUrl],
  ].filter(([, u]) => u);

  if (!links.length) return '';
  return `<div class="fact fact-links">
    <dt>Documents</dt>
    <dd>${links.map(([label, url]) =>
      `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(label)} ↗</a>`).join('')}</dd>
  </div>`;
}

// ----------------------------------------------------------- today's IPOs

const RETAIL_CAP = 200000;   // above this an application stops being retail
const SHNI_CAP  = 1000000;   // above this it is big-HNI

/**
 * What it costs to apply in each category, and the odds of being allotted.
 *
 * The category boundaries are rupee thresholds, but you bid in whole lots, so
 * the real minimum for sHNI is the first lot count that clears ₹2L — not ₹2L
 * itself. Odds are the category's own subscription multiple: once a category
 * is oversubscribed, allotment is a lottery, so 3x subscribed is about a one
 * in three chance of a single lot.
 */
function categoryOptions(r){
  const cap = capPrice(r);
  const lot = r.info?.lotSize;
  if (!cap || !lot) return [];

  const perLot = cap * lot;
  const sub = (k) => (r.categories || []).find((c) => c.key === k) || null;

  return [
    { key:'retail', label:'Retail',            lots: 1 },
    { key:'shni',   label:'sHNI (₹2L–₹10L)',   lots: Math.ceil(RETAIL_CAP / perLot) },
    { key:'bhni',   label:'bHNI (above ₹10L)', lots: Math.ceil(SHNI_CAP  / perLot) },
  ].map((o) => {
    const s = sub(o.key);
    return {
      ...o,
      amount: o.lots * perLot,
      times: s ? s.times : null,
      // SME issues publish no per-category multiple — only how many people
      // applied. See the shape note in lib/sources.js.
      applications: s ? s.applications : null,
    };
  });
}

/**
 * Which category to apply under, argued from the numbers rather than guessed.
 *
 * Retail is the default because it is the cheapest way in and the only one
 * most people will use. It is only worth naming a bigger category when its
 * odds are materially better — a marginal edge does not justify five times
 * the money at risk.
 */
function recommendCategory(r){
  const opts = categoryOptions(r).filter((o) => o.times !== null);
  if (!opts.length) return null;

  const retail = opts.find((o) => o.key === 'retail');
  const best = opts.reduce((a, b) => (b.times < a.times ? b : a));

  if (retail && retail.times <= 1){
    return {
      pick: retail,
      why: `Retail is only ${retail.times.toFixed(2)}× subscribed, so a single ` +
           `${inr(retail.amount)} application should be allotted in full.`,
    };
  }

  if (!retail) return { pick: best, why: `${best.label} has the lowest subscription at ${best.times.toFixed(2)}×.` };

  // Materially better means roughly half the crowding, not a rounding error.
  if (best.key !== 'retail' && best.times < retail.times * 0.6){
    return {
      pick: best,
      why: `${best.label} is ${best.times.toFixed(2)}× against retail's ${retail.times.toFixed(2)}×, ` +
           `so the odds are better — but it needs ${inr(best.amount)} versus ${inr(retail.amount)}.`,
      alt: retail,
    };
  }

  return {
    pick: retail,
    why: best.key === 'retail'
      ? `Retail has the lowest subscription at ${retail.times.toFixed(2)}×, and the smallest cheque at ${inr(retail.amount)}.`
      : `Retail at ${retail.times.toFixed(2)}× is not meaningfully worse than ${best.label} at ${best.times.toFixed(2)}×, ` +
        `and needs ${inr(retail.amount)} instead of ${inr(best.amount)}.`,
  };
}

/**
 * A self-contained question for an external AI. It carries the live figures,
 * because no chatbot has today's subscription numbers — without them the
 * answer would be generic.
 */
function aiPrompt(rows){
  const t = todayISO();
  const lines = [
    `I am a retail investor in India deciding which IPOs to apply for today (${fmtDate(t)}).`,
    `Here are the issues currently open, with live figures from NSE and IPO Watch.`,
    `Application categories: Retail up to ₹2,00,000, sHNI ₹2,00,000–₹10,00,000, bHNI above ₹10,00,000.`,
    '',
  ];

  for (const r of rows){
    lines.push(`## ${r.name}${r.board === 'SME' ? ' (SME)' : ''}`);
    lines.push(`- Closes: ${fmtDate(r.end)}${r.end === t ? ' (today)' : ''}`);
    lines.push(`- Price band: ${r.priceBand || 'not announced'}`);
    if (r.info?.lotSize){
      const cap = capPrice(r);
      lines.push(`- Lot size: ${r.info.lotSize} shares` +
        (cap ? ` = ₹${(r.info.lotSize * cap).toLocaleString('en-IN')} per lot at the ₹${cap} cap` : ''));
    }
    if (r.issueSize && capPrice(r)){
      lines.push(`- Total issue size: about ${inr(Number(r.issueSize) * capPrice(r))}`);
    }
    if (r.subscription != null) lines.push(`- Overall subscription: ${r.subscription.toFixed(2)}x`);
    if (r.categories?.length){
      lines.push('- Category-wise subscription:');
      for (const c of r.categories){
        lines.push(c.times !== null
          ? `    - ${c.label}: ${c.times.toFixed(2)}x subscribed`
          : `    - ${c.label}: ${(c.applications ?? 0).toLocaleString('en-IN')} applications` +
            ' (NSE publishes no multiple for SME issues)');
      }
    } else {
      lines.push('- Category-wise subscription: not published yet');
    }
    if (r.gmp !== null){
      lines.push(`- Grey market premium: ₹${r.gmp}` +
        (r.gmpPct !== null ? ` (${signed(r.gmpPct)} of issue price)` : '') +
        ' — unofficial, treat as sentiment only');
    } else {
      lines.push('- Grey market premium: none quoted');
    }
    lines.push('');
  }

  lines.push(
    'For each IPO tell me: should I apply or skip, and if I apply, which category gives',
    'the best allotment odds for the money. Note that a category with a LOWER subscription',
    'multiple has BETTER odds. Use only the figures above plus what you know about these',
    'companies; say clearly when something is your own judgement rather than these numbers.',
  );

  return lines.join('\n');
}

// `udm=50` is Google's AI Mode. Each target also has a bare URL, used when the
// brief is too long to travel in a query string.
const AI_TARGETS = [
  { id:'google', label:'Google AI Mode', blank: 'https://www.google.com/search?udm=50',
    url: (q) => `https://www.google.com/search?udm=50&q=${encodeURIComponent(q)}` },
  { id:'chatgpt', label:'ChatGPT', blank: 'https://chatgpt.com/',
    url: (q) => `https://chatgpt.com/?q=${encodeURIComponent(q)}` },
  { id:'claude', label:'Claude', blank: 'https://claude.ai/new',
    url: (q) => `https://claude.ai/new?q=${encodeURIComponent(q)}` },
];

/**
 * Headline figures. A listed issue swaps the two speculative numbers — GMP and
 * the gain it implies — for the two real ones: what it opened at and what it
 * trades at now.
 */
function modalStats(r){
  const L = r.listing;
  const band = `<div class="stat"><dt>Price band</dt>
    <dd style="font-size:15px">${esc(r.priceBand || '—')}</dd></div>`;
  const subs = `<div class="stat"><dt>Subscribed</dt><dd>${
    r.subscription != null ? r.subscription.toFixed(2) + '×' : '—'}</dd></div>`;

  if (L && L.cmp !== null){
    return band + `
      <div class="stat"><dt>Listed at</dt><dd>${
        L.listPrice === null ? '—' : money(L.listPrice)}${
        L.listGainPct !== null
          ? ` <span class="delta ${moveClass(L.listGainPct)}">${signed(L.listGainPct)}</span>`
          : ''}</dd></div>
      <div class="stat"><dt>Trading now</dt><dd>${money(L.cmp)}${
        L.cmpGainPct !== null
          ? ` <span class="delta ${moveClass(L.cmpGainPct)}">${signed(L.cmpGainPct)}</span>`
          : ''}</dd></div>` + subs;
  }

  return band + `
    <div class="stat"><dt>GMP</dt><dd class="${moveClass(r.gmp ?? 0)}">${
      r.gmp === null ? '—' : money(r.gmp)}</dd></div>
    <div class="stat"><dt>Implied gain</dt><dd>${
      r.gmpPct !== null ? signed(r.gmpPct) : '—'}</dd></div>` + subs;
}

function openModal(key){
  const r = allIpos().find((x) => x.key === key);
  if (!r) return;

  const t = todayISO();
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  back.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(r.name)}">
      <div class="modal-head">
        <div class="grow">
          <h2>${esc(r.name)} ${r.board === 'SME' ? '<span class="tag">SME</span>' : ''}</h2>
          <div class="sub">${r.symbol ? esc(r.symbol)+' · ' : ''}${timingText(r, t)} ·
            ${fmtDate(r.start)} – ${fmtDate(r.end)}</div>
        </div>
        <button class="icon" data-close aria-label="Close">✕</button>
      </div>
      <div class="modal-body">
        <div class="stat-row">${modalStats(r)}</div>

        <div id="modal-report"></div>

        <div class="chart-card">
          <h4>The numbers that decide it</h4>
          <p class="chart-note">What one application actually costs, and what it stands to make.</p>
          <dl class="facts" id="modal-facts"></dl>
        </div>

        <div class="chart-card">
          <h4>Subscription by category</h4>
          <p class="chart-note">A category with a lower multiple has better allotment odds.</p>
          <div id="modal-bars"></div>
        </div>

        <div class="chart-card">
          <div class="chart-head">
            <div class="grow">
              <h4>GMP over time</h4>
              <p class="chart-note">Recorded by this app on each refresh. Grey market premium is an
                unofficial indicator, not an exchange price.</p>
            </div>
            <div class="range" id="modal-range" role="group" aria-label="Time range"></div>
          </div>
          <div id="modal-line"></div>
        </div>

        <div class="chart-card">
          <h4>Check allotment</h4>
          <p class="chart-note">Every registrar gates lookup behind a CAPTCHA, so this copies your
            ID and opens the right site — you solve the CAPTCHA and paste.</p>
          <div class="row" id="modal-allot"></div>
        </div>

        <div class="row" style="margin:0">
          ${r.symbol ? `<a href="https://www.nseindia.com/market-data/issue-information?symbol=${
            encodeURIComponent(r.symbol)}&series=EQ&type=Active" target="_blank" rel="noopener">NSE issue page ↗</a>` : ''}
          <a href="https://www.google.com/search?q=${encodeURIComponent(r.name+' IPO RHP details')}"
             target="_blank" rel="noopener">Search RHP &amp; reviews ↗</a>
        </div>
      </div>
    </div>`;

  document.body.appendChild(back);
  document.body.style.overflow = 'hidden';

  renderReport($('#modal-report', back), r);

  const cats = (r.categories || []).filter((c) => c.key !== 'nii');
  Charts.barChart($('#modal-bars', back), cats.map((c) => ({
    label: c.label,
    value: Number(c.times.toFixed(2)),
    note: c.offered ? `${c.bid.toLocaleString('en-IN')} bid of ${c.offered.toLocaleString('en-IN')} offered` : '',
  })), {
    suffix: '×', reference: 1, referenceLabel: '1× fully subscribed',
    labelWidth: 150, ariaLabel: 'Subscription multiple by investor category',
    emptyText: r.status === 'upcoming'
      ? 'Bidding has not opened yet — category figures appear once it does.'
      : 'NSE has not published category-wise bids for this issue.',
  });

  renderFacts($('#modal-facts', back), r);

  const drawLine = () => {
    const full = historyPoints(r.histKey);
    renderRange($('#modal-range', back), historySpan([full]));
    const pts = inRange(full);
    const host = $('#modal-line', back);
    if (pts.length < 2){
      host.innerHTML = `<p class="chart-empty">${
        historyPoints(r.histKey).length >= 2
          ? 'No readings in this window — pick a wider range.'
          : 'No history recorded yet. Points are captured each time the data refreshes.'
      }</p>`;
      return;
    }
    Charts.lineChart(host, [{
      name: r.name, color: 'var(--series-1)', points: pts,
    }], { height: 200, prefix: '₹', area: true, ariaLabel: 'GMP over time' });
  };
  drawLine();
  back._drawLine = drawLine;

  renderModalAllot($('#modal-allot', back), r);

  const close = () => {
    back.remove();
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onKey);
    if (location.hash.startsWith('#ipo=')) history.replaceState(null, '', '#ipos');
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  back.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-range]');
    if (chip){
      setRange(chip.dataset.range);
      drawLine();
      return;
    }
    if (e.target === back || e.target.closest('[data-close]')) close();
  });
  document.addEventListener('keydown', onKey);
  $('[data-close]', back).focus();
}

function renderReport(host, r){
  if (!r.report){
    host.innerHTML = `<div class="report">
      <div class="report-head"><h4>Apply or avoid</h4></div>
      <p class="chart-note" style="margin:0">No report for this IPO yet. Reports are generated for
      open and near-term issues once a model API key is configured — Gemini has a free tier.
      See the README.</p>
    </div>`;
    return;
  }

  const rep = r.report;
  const meta = r.reportMeta;
  const li = (items) => (items || []).map((x) => `<li>${esc(x)}</li>`).join('');

  host.innerHTML = `<div class="report">
    <div class="report-head">
      <h4>Apply or avoid</h4>
      ${verdictChip(rep)}
      <span class="tag">${esc(rep.confidence)} confidence</span>
      <span class="tag">${esc(rep.riskLevel)} risk</span>
    </div>
    <p class="report-headline">${esc(rep.headline)}</p>
    <p class="report-rationale">${esc(rep.rationale)}</p>

    <div class="pro-con">
      <div><h5>In favour</h5><ul class="for">${li(rep.forPoints)}</ul></div>
      <div><h5>Against</h5><ul class="against">${li(rep.againstPoints)}</ul></div>
    </div>

    ${rep.categoryAdvice && rep.categoryAdvice.category !== 'none' ? `
      <div class="advice">Best category to apply in:
        <b>${esc(CATEGORY_LABEL[rep.categoryAdvice.category] || rep.categoryAdvice.category)}</b>
        — ${esc(rep.categoryAdvice.reason)}</div>` : ''}

    ${rep.watchFor?.length ? `
      <div class="advice"><b>Watch for:</b> ${rep.watchFor.map(esc).join(' · ')}</div>` : ''}

    <p class="disclaimer">Generated by ${esc(meta?.model || 'Claude')} on
      ${meta ? new Date(meta.generatedAt).toLocaleString('en-IN') : 'unknown date'} from the public
      figures shown on this page — subscription multiples and grey market premium. It has no access
      to the RHP, company financials or peer valuations. This is an automated reading of market
      signals for your own research, not investment advice, and grey market premium in particular
      is unofficial and easily manipulated. Verify before you commit money.</p>
  </div>`;
}

function renderModalAllot(host, r){
  const ids = load(LS.ids, []);
  const picked = load(LS.registrars, {});
  if (!ids.length){
    host.innerHTML = `<span class="empty" style="padding:0">Add a PAN in
      <b>My Applications</b> first.</span>`;
    return;
  }
  host.innerHTML = `
    <select data-reg="${esc(r.key)}">
      ${REGISTRARS.map((x,i) =>
        `<option value="${i}"${picked[r.key]===i?' selected':''}>${esc(x.name)}</option>`).join('')}
    </select>
    ${ids.map((id,ii) =>
      `<button data-check="${esc(r.key)}" data-id="${ii}">${esc(id.label || id.value)}</button>`).join('')}`;
}

// ------------------------------------------------------- applications tab

function getIds(){ return load(LS.ids, []); }
function setIds(v){ save(LS.ids, v); }

function renderIds(){
  const ids = getIds();
  $('#pan-list').innerHTML = ids.length
    ? ids.map((id,i) => `<span class="pill"><b>${esc(id.value)}</b>
        <small>${esc(id.label||'')}</small>
        <button data-del="${i}" title="Remove" aria-label="Remove ${esc(id.value)}">×</button></span>`).join('')
    : `<span class="empty">No PANs or DP IDs saved yet. They stay in this browser only.</span>`;
}

function renderAllot(){
  const t = todayISO();
  const closed = allIpos()
    .filter((r) => r.status === 'closed' && (!r.end || daysBetween(r.end,t) <= 45))
    .sort((a,b) => String(b.end||'').localeCompare(String(a.end||'')));

  $('#allot-count').textContent = closed.length;
  const ids = getIds();
  const picked = load(LS.registrars, {});

  $('#allot-table tbody').innerHTML = closed.map((r) => `
    <tr>
      <td>${esc(r.name)} ${r.board==='SME'?'<span class="tag">SME</span>':''}</td>
      <td>${fmtDate(r.end)}</td>
      <td><select data-reg="${esc(r.key)}">
        ${REGISTRARS.map((x,i)=>`<option value="${i}"${picked[r.key]===i?' selected':''}>${esc(x.name)}</option>`).join('')}
      </select></td>
      <td>${ids.length
        ? ids.map((id,ii)=>`<button data-check="${esc(r.key)}" data-id="${ii}">${esc(id.label||id.value)}</button>`).join(' ')
        : '<span class="empty" style="padding:0">Add a PAN above</span>'}</td>
    </tr>`).join('') || `<tr><td colspan="4" class="empty">No recently closed IPOs.</td></tr>`;
}

async function copyText(text){
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position='fixed'; ta.style.opacity='0';
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    return ok;
  }
}

// ---------------------------------------------------------------- wiring

function render(){
  renderToday();
  renderIpos();
  renderGmp();
  renderIds();
  renderAllot();
}

const TABS = ['today','ipos','gmp','allot'];
function showTab(name){
  if (!TABS.includes(name)) name = 'today';
  $$('.tabs button').forEach((x) => x.classList.toggle('on', x.dataset.tab === name));
  TABS.forEach((id) => { $('#tab-'+id).hidden = (id !== name); });
  // Today and My Applications answer a fixed question; the filter row would
  // only let you hide the very thing each is for.
  $('#filter-row').hidden = (name === 'allot' || name === 'today');
  // Charts size to their container, so re-draw once the tab is actually visible.
  if (name === 'gmp') renderGmp();
}

/** `#ipo=<key>` opens that IPO's detail, so a specific issue can be linked. */
function routeFromHash(){
  const hash = location.hash.slice(1);
  if (hash.startsWith('ipo=')){
    const key = decodeURIComponent(hash.slice(4));
    if (!$('.modal-backdrop')) openModal(key);
    return;
  }
  const open = $('.modal-backdrop');
  if (open) open.remove(), (document.body.style.overflow = '');
  showTab(hash);
}

$$('.tabs button').forEach((b) => b.addEventListener('click', () => {
  location.hash = b.dataset.tab;
}));
window.addEventListener('hashchange', routeFromHash);

function bindSeg(sel, key){
  $$(sel).forEach((b) => b.addEventListener('click', () => {
    state.filters[key] = b.dataset.value;
    $$(sel).forEach((x) => x.classList.toggle('on', x === b));
    save(LS.filters, state.filters);
    renderIpos();
    renderGmp();
  }));
}
bindSeg('[data-board]', 'board');
bindSeg('[data-status]', 'status');

$('#search').addEventListener('input', (e) => {
  state.filters.q = e.target.value.trim();
  save(LS.filters, state.filters);
  renderIpos();
  renderGmp();
});

$('#sort').addEventListener('change', (e) => {
  state.filters.sort = e.target.value;
  save(LS.filters, state.filters);
  renderIpos();
  renderGmp();
});

$('#reset-filters').addEventListener('click', () => {
  state.filters = { q:'', board:'all', status:'all', sort:'closing' };
  save(LS.filters, state.filters);
  syncFilterUI();
  renderIpos();
  renderGmp();
});

$$('#gmp-table th[data-sort]').forEach((th) => th.addEventListener('click', () => {
  const col = th.dataset.sort;
  state.gmpSort = { col, dir: state.gmpSort.col === col ? -state.gmpSort.dir : -1 };
  renderGmp();
}));

$('#refresh').addEventListener('click', refresh);

$('#auto').addEventListener('click', (e) => {
  if (state.autoTimer){
    clearInterval(state.autoTimer);
    state.autoTimer = null;
    e.target.textContent = 'Auto: off';
    e.target.classList.remove('on');
  } else {
    state.autoTimer = setInterval(refresh, 5*60*1000);
    e.target.textContent = 'Auto: 5 min';
    e.target.classList.add('on');
  }
});

$('#theme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  save(LS.theme, next);
  $('#theme').textContent = next === 'light' ? '☾' : '☀';
  renderGmp();
});

$('#pan-add').addEventListener('click', () => {
  const value = $('#pan-value').value.trim().toUpperCase();
  const label = $('#pan-label').value.trim();
  if (!value){ toast('Enter a PAN or DP ID'); return; }
  const ids = getIds();
  if (ids.some((x) => x.value === value)){ toast('Already saved'); return; }
  ids.push({ label, value });
  setIds(ids);
  $('#pan-value').value = '';
  $('#pan-label').value = '';
  renderIds();
  renderAllot();
});

$('#pan-value').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#pan-add').click();
});

document.addEventListener('change', (e) => {
  const sel = e.target.closest('select[data-reg]');
  if (!sel) return;
  const picked = load(LS.registrars, {});
  picked[sel.dataset.reg] = Number(sel.value);
  save(LS.registrars, picked);
});

// Range chips on the GMP tab. The modal handles its own, on its own subtree.
$('#compare-range').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-range]');
  if (!chip) return;
  setRange(chip.dataset.range);
  renderGmp();
});

// Today tab: ask an AI, or copy the same brief to paste anywhere.
$('#tab-today').addEventListener('click', async (e) => {
  const ai = e.target.closest('[data-ai]');
  if (ai){
    openAiWith(todayRows(ai.dataset.ai));
    return;
  }
  const copy = e.target.closest('[data-copy]');
  if (copy){
    const rows = todayRows(copy.dataset.copy);
    if (!rows.length) return;
    try {
      await navigator.clipboard.writeText(aiPrompt(rows));
      toast('Details copied — paste into any AI chat');
    } catch {
      toast('Could not copy — the browser blocked clipboard access');
    }
    return;
  }

  // The document-level opener skips buttons, so this one is handled here.
  const open = e.target.closest('button[data-open]');
  if (open) location.hash = 'ipo=' + encodeURIComponent(open.dataset.open);
});

$('#tab-today').addEventListener('change', (e) => {
  const sel = e.target.closest('#ai-target');
  if (sel) save(LS.aiTarget, sel.value);
});

document.addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  if (del){
    const ids = getIds();
    ids.splice(Number(del.dataset.del), 1);
    setIds(ids);
    renderIds();
    renderAllot();
    return;
  }

  const chk = e.target.closest('[data-check]');
  if (chk){
    e.stopPropagation();
    const id = getIds()[Number(chk.dataset.id)];
    const sel = document.querySelector(`select[data-reg="${CSS.escape(chk.dataset.check)}"]`);
    const reg = REGISTRARS[Number(sel ? sel.value : 0)];
    const ok = await copyText(id.value);
    toast(ok ? `${id.value} copied — paste it at ${reg.name}` : `Opening ${reg.name}`);
    window.open(reg.url, '_blank', 'noopener');
    return;
  }

  const legend = e.target.closest('[data-legend]');
  if (legend){
    const key = legend.dataset.legend;
    if (state.compareOff.has(key)) state.compareOff.delete(key);
    else state.compareOff.add(key);
    renderGmp();
    return;
  }

  const opener = e.target.closest('[data-open]');
  if (opener && !e.target.closest('select, button, a')){
    location.hash = 'ipo=' + encodeURIComponent(opener.dataset.open);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const card = e.target.closest('.card[data-open]');
  if (card) location.hash = 'ipo=' + encodeURIComponent(card.dataset.open);
});

function syncFilterUI(){
  const f = state.filters;
  $('#search').value = f.q;
  $('#sort').value = f.sort;
  $$('[data-board]').forEach((b) => b.classList.toggle('on', b.dataset.value === f.board));
  $$('[data-status]').forEach((b) => b.classList.toggle('on', b.dataset.value === f.status));
}

// ------------------------------------------------------------------- boot

const theme = load(LS.theme, 'dark');
document.documentElement.dataset.theme = theme;
$('#theme').textContent = theme === 'light' ? '☾' : '☀';

$('#today').textContent = new Date().toLocaleDateString('en-IN',
  { weekday:'short', day:'numeric', month:'short' });

state.history = load(LS.history, {});
state.filters = { ...state.filters, ...load(LS.filters, {}) };
state.range = load(LS.range, state.range);
syncFilterUI();

const snap = load(LS.snapshot, null);
if (snap){ state.ipos = snap.ipos || []; state.gmp = snap.gmp || []; }

showTab(location.hash.startsWith('#ipo=') ? 'ipos' : location.hash.slice(1));
render();
refresh().then(routeFromHash);

// Charts are sized from their container width, so re-draw on resize.
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (!$('#tab-gmp').hidden) renderGmp(); }, 200);
});

})();
