'use strict';

const Core = require('../js/core');
const API = 'https://ipowatch.in/server/api/ipo/';
const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

function number(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function date(value) {
  const text = String(value || '').trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:T|$)/);
  const words = text.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
  if (!iso && !words) return null;
  const y = Number(iso ? iso[1] : words[3]);
  const m = iso ? Number(iso[2]) : MONTHS.indexOf(words[2].toLowerCase()) + 1;
  const d = Number(iso ? iso[3] : words[1]);
  if (!m || m > 12 || d < 1 || d > 31) return null;
  const result = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  return new Date(result+'T00:00:00Z').toISOString().slice(0,10) === result ? result : null;
}

function board(value) {
  if (/^(mainboard|mainline)$/i.test(String(value).trim())) return 'Mainboard';
  if (/^(sme|nse emerge|nse sme|bse sme)$/i.test(String(value).trim())) return 'SME';
  return null;
}

function parseListing(payload) {
  if (payload?.status !== 1 || !Array.isArray(payload.data)) return [];
  return payload.data.flatMap(row => {
    if (!row || !Number.isSafeInteger(row.id) || row.id <= 0 || !board(row.type)) return [];
    const company = String(row.name || '').trim();
    if (!Core.nameKey(company) || !/[a-z]/i.test(company)) return [];
    const lot = String(row.lotSize || '').replace(/,/g,'').match(/^\s*(\d+)\s*(shares)?\s*$/i);
    const lotSize = lot ? Number(lot[1]) : null;
    const status = String(row.issueStatus || '').toLowerCase();
    const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(row.slug || '') ? row.slug : null;
    return [{
      providerId: row.id, company, symbol: null, board: board(row.type),
      series: board(row.type) === 'SME' ? 'SME' : 'EQ',
      start: date(row.openDate), end: date(row.closeDate), listingDate: date(row.listingDate),
      allotmentDate: date(row.allotmentDate), statusHint: status,
      priceBand: /\d/.test(row.priceBand || '') ? String(row.priceBand) : null,
      // The listing feed supplies a labelled crore amount, not a share count.
      issueSize: null,
      subscription: status === 'upcoming' ? null : number(row.subscription),
      categories: [],
      info: {lotSize: Number.isSafeInteger(lotSize) && lotSize > 0 ? lotSize : null},
      source: 'ipowatch', sourceUrl: slug ? `https://ipowatch.in/${slug}` : null,
    }];
  });
}

function parseSubscriptions(payload) {
  if (payload?.status !== 1 || !Array.isArray(payload.result)) return [];
  return payload.result.flatMap(entry => {
    try {
      const rows = typeof entry?.ipoSubscriptionJson === 'string'
        ? JSON.parse(entry.ipoSubscriptionJson) : entry?.ipoSubscriptionJson;
      return Array.isArray(rows) ? rows.filter(row=>row && Number.isSafeInteger(row.ipoId)) : [];
    } catch { return []; }
  });
}

function subscriptionSnapshot(rows) {
  if (!Array.isArray(rows)) return null;
  const latest = rows.map(row=>date(row?.subscriptionDate)).filter(Boolean).sort().at(-1);
  if (!latest) return null;
  const todayRows = rows.filter(row=>date(row?.subscriptionDate) === latest);
  const keys = [
    [/^qib\b/i,'qib','QIB'], [/^nii\b/i,'nii','NII (HNI)'],
    [/^bnii\b/i,'bhni','bHNI'], [/^snii\b/i,'shni','sHNI'],
    [/^retail\b/i,'retail','Retail'], [/^employees?\b/i,'employee','Employee'],
  ];
  const categories = keys.flatMap(([pattern,key,label]) => {
    const row = todayRows.find(row=>pattern.test(String(row.categoryName || '')));
    if (!row || number(row.subscriptionValue) === null) return [];
    return [{key,label,times:number(row.subscriptionValue),offered:number(row.sharedOfferedValue),
      bid:number(row.applied),applications:null}]; // applied is shares, not applications.
  });
  const total = todayRows.find(row=>/^total$/i.test(String(row.categoryName || '')));
  return {categories, total:number(total?.subscriptionValue), asOf:latest};
}

function mergeIpos(listing, subscriptions, previous, {now=new Date().toISOString(),previousFetchedAt=null,primaryError=null}={}) {
  const today = Core.marketDate(new Date(now));
  const current = listing.map(row => {
    const match = Core.matchIssue({name:row.company,board:row.board},previous);
    const old = match && (!row.start || match.start === row.start) ? match : null;
    const bids = subscriptions.find(sub=>sub.ipoId === row.providerId);
    const snapshot = subscriptionSnapshot(bids?.subscriptionList);
    const active = !row.end || row.end >= today;
    const usable = snapshot && (!active || snapshot.asOf === today);
    return {...row,
      symbol: old?.symbol || null,
      info:{...old?.info,...Object.fromEntries(Object.entries(row.info).filter(([,v])=>v !== null))},
      listing:old?.listingDate === row.listingDate ? old?.listing || null : null,
      categories:usable ? snapshot.categories : [],
      subscription:usable ? snapshot.total ?? row.subscription : row.subscription,
      subscriptionAsOf:usable ? snapshot.asOf : null,
      sourceFetchedAt:now, primarySourceError:primaryError, archived:false,
    };
  });
  // Keep the historical record without relabelling old observations as fresh.
  const archives = previous.filter(row=>row.end && row.end < today &&
    !Core.matchIssue({name:row.company,board:row.board},current)).map(row=>({...row,archived:true,
      sourceFetchedAt:row.sourceFetchedAt || previousFetchedAt,
      subscriptionAsOf:row.subscriptionAsOf || row.end}));
  return [...current,...archives];
}

async function json(path) {
  const response = await fetch(API+path,{headers:{Accept:'application/json','User-Agent':'IPO-Tracker/1.0'},signal:AbortSignal.timeout(20000)});
  if (!response.ok) throw Error(`IPO Watch ${path}: HTTP ${response.status}`);
  return response.json();
}

async function getIpos(previous=[],options={}) {
  const [listing,subscriptions] = await Promise.all([
    json('GetIpoListing'), json('GetIpoAubscription').catch(()=>null),
  ]);
  const rows = parseListing(listing);
  if (!rows.length) throw Error('IPO Watch: no valid IPO details; saved data retained');
  return mergeIpos(rows,parseSubscriptions(subscriptions),previous,options);
}

module.exports = {getIpos,parseListing,parseSubscriptions,subscriptionSnapshot,mergeIpos,date};
