const {test}=require('node:test');
const assert=require('node:assert/strict');
const watch=require('../lib/ipo-watch');
const sources=require('../lib/sources');
const Core=require('../js/core');

const listing={status:1,data:[
  {id:1149,name:'Example Crop Protection',slug:'example-crop-protection-ipo-details',type:'Mainboard',
    issueStatus:'Open',priceBand:'₹259.00 - ₹272.00',lotSize:'55 shares',subscription:1.16,
    openDate:'18 Nov 2026',closeDate:'20 Nov 2026',allotmentDate:'2026-11-23T00:00:00',listingDate:'2026-11-26T00:00:00'},
  {id:1152,name:'Example Rentals',slug:'example-rentals-ipo-details',type:'NSE Emerge',
    issueStatus:'Upcoming',priceBand:'₹232.00 - ₹245.00',lotSize:'600 shares',subscription:0,
    openDate:'19 Nov 2026',closeDate:'23 Nov 2026'},
  {id:1254,name:'Example Food',type:'Mainboard',issueStatus:'Upcoming',priceBand:'TBA',lotSize:'0 shares',subscription:0,
    openDate:null,closeDate:null},
]};
const bids=[
  {categoryName:'Retail',subscriptionDate:'2026-11-17',subscriptionValue:'999',applied:999},
  {categoryName:'Total',subscriptionDate:'2026-11-17',subscriptionValue:'999'},
  {categoryName:'Retail',subscriptionDate:'2026-11-18',subscriptionValue:'1.19',applied:7231180,sharedOfferedValue:6059497},
  {categoryName:'sNII < ?10L',subscriptionDate:'2026-11-18',subscriptionValue:'0.88',applied:765215},
  {categoryName:'bNII > ?10L',subscriptionDate:'2026-11-18',subscriptionValue:'0.39',applied:676005},
  {categoryName:'Total',subscriptionDate:'2026-11-18',subscriptionValue:'1.16'},
];
const subscriptions={status:1,result:[{ipoSubscriptionJson:JSON.stringify([{ipoId:1149,subscriptionList:bids}])}]};
const now='2026-11-18T10:30:00Z';

test('IPO details parse current listing fields and keep unannounced terms missing',()=>{
  const rows=watch.parseListing(listing);
  assert.equal(rows.length,3);assert.equal(rows[0].start,'2026-11-18');
  assert.equal(rows[0].listingDate,'2026-11-26');assert.equal(rows[0].info.lotSize,55);
  assert.equal(rows[1].board,'SME');assert.equal(rows[1].subscription,null);
  assert.equal(rows[2].priceBand,null);assert.equal(rows[2].info.lotSize,null);
  assert.equal(rows[0].symbol,null);assert.equal(rows[0].source,'ipowatch');
  assert.equal(watch.date('31 Feb 2026'),null);assert.equal(watch.date('2026-13-18'),null);
  for(const data of [null,{status:0,data:listing.data},{status:1,data:[{},null,{...listing.data[0],type:'unknown'}]}])assert.deepEqual(watch.parseListing(data),[]);
});

test('subscription feed uses the latest reported day and never treats shares as applications',()=>{
  const rows=watch.parseSubscriptions(subscriptions),snapshot=watch.subscriptionSnapshot(rows[0].subscriptionList);
  assert.equal(snapshot.asOf,'2026-11-18');assert.equal(snapshot.total,1.16);
  assert.equal(snapshot.categories.find(row=>row.key==='retail').times,1.19);
  assert.equal(snapshot.categories.find(row=>row.key==='retail').bid,7231180);
  assert.ok(snapshot.categories.every(row=>row.applications===null));
  assert.deepEqual(snapshot.categories.map(row=>row.key),['bhni','shni','retail']);
  assert.deepEqual(watch.parseSubscriptions({status:1,result:[{ipoSubscriptionJson:'invalid'}]}),[]);
});

test('backup replaces active facts, preserves dated archives and removes obsolete upcoming rows',()=>{
  const stamp='2026-11-13T15:57:25Z';
  const previous=[
    {company:'Example Crop Protection Limited',board:'Mainboard',symbol:'EXAMPLE',start:'2026-11-18',end:'2026-11-20',
      subscription:999,categories:[{key:'retail',times:999}],info:{lotSize:10,registrar:'Registrar'}},
    {company:'Archived Works',board:'SME',start:'2026-10-20',end:'2026-10-23',listingDate:'2026-10-28',listing:{cmp:120,quoteAsOf:stamp}},
    {company:'Old Upcoming',board:'Mainboard',start:'2026-11-19',end:'2026-11-23'},
  ];
  const rows=watch.mergeIpos(watch.parseListing(listing),watch.parseSubscriptions(subscriptions),previous,{now,previousFetchedAt:stamp,primaryError:'NSE timeout'});
  assert.equal(rows.length,4);assert.equal(rows[0].subscription,1.16);assert.equal(rows[0].symbol,'EXAMPLE');
  assert.equal(rows[0].info.lotSize,55);assert.equal(rows[0].info.registrar,'Registrar');
  assert.equal(rows[0].sourceFetchedAt,now);assert.equal(rows[0].subscriptionAsOf,'2026-11-18');
  assert.equal(rows[0].primarySourceError,'NSE timeout');assert.equal(previous[0].subscription,999);
  const archive=rows.find(row=>row.archived);assert.equal(archive.sourceFetchedAt,stamp);assert.equal(archive.listing.quoteAsOf,stamp);
  assert.equal(rows.some(row=>row.company==='Old Upcoming'),false);
  assert.equal(Core.categories(rows[0])[0].amount,14960);
});

test('old category observations are not carried into current bidding figures',()=>{
  const old=[{ipoId:1149,subscriptionList:bids.filter(row=>row.subscriptionDate==='2026-11-17')}];
  const row=watch.mergeIpos(watch.parseListing(listing),old,[],{now})[0];
  assert.deepEqual(row.categories,[]);assert.equal(row.subscription,1.16);assert.equal(row.subscriptionAsOf,null);
});

test('blocked NSE falls back to public IPO details and rejects an empty backup',async t=>{
  let empty=false;
  t.mock.method(console,'warn',()=>{});
  t.mock.method(globalThis,'fetch',async url=>{
    if(url==='https://www.nseindia.com/')return {headers:{getSetCookie:()=>[]}};
    if(url.startsWith('https://www.nseindia.com/'))throw Error('NSE timeout');
    if(url.endsWith('GetIpoListing'))return {ok:true,json:async()=>empty?{status:1,data:[]}:listing};
    if(url.endsWith('GetIpoAubscription'))return {ok:true,json:async()=>subscriptions};
    throw Error('Unexpected request '+url);
  });
  const rows=await sources.getIposEnriched();
  assert.equal(rows[0].company,'Example Crop Protection');assert.equal(rows[0].source,'ipowatch');
  assert.equal(rows[0].primarySourceError,'NSE timeout');
  empty=true;
  await assert.rejects(watch.getIpos(),/no valid IPO details/);
});
