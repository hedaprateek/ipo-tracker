const test=require('node:test'),assert=require('node:assert/strict'),Core=require('../js/core'),sources=require('../lib/sources');
test('freshness distinguishes missing, old, future and current timestamps',()=>{
  const now=Date.parse('2026-10-22T10:00:00Z');
  assert.equal(Core.freshness('2026-10-22T09:00:00Z',now),'current');
  assert.equal(Core.freshness('2026-10-02T09:00:00Z',now),'stale');
  assert.equal(Core.freshness(null,now),'unknown');assert.equal(Core.freshness('2027-01-01',now),'unknown');
});
test('market calendar dates follow India across UTC midnight regardless of host locale',()=>{
  assert.equal(Core.marketDate(new Date('2026-10-22T19:00:00Z')),'2026-10-23');
  assert.equal(Core.marketDate(new Date('2026-10-22T18:00:00Z')),'2026-10-22');
});
test('identity removes source status suffixes and rejects ambiguous short prefixes',()=>{
  assert.equal(Core.nameKey('R.K.Fashion (U)'),Core.nameKey('R K Fashion'));
  const issues=[{company:'R.K. Fashion Accessories Limited',board:'SME'},{company:'Acme Energy Limited',board:'Mainboard'},{company:'Acme Energy Services Limited',board:'Mainboard'}];
  assert.equal(Core.matchIssue({name:'R.K.Fashion (U)',board:'SME'},issues),issues[0]);
  assert.equal(Core.matchIssue({name:'Acme Energy',board:'Mainboard'},issues),issues[1]);
  assert.equal(Core.matchIssue({name:'Acme',board:'Mainboard'},issues),null);
  assert.equal(Core.matchIssue({name:'R.K.Fashion',board:'Mainboard'},issues),null);
  assert.equal(Core.matchIssue({name:'Acme Energy Services',board:'Mainboard'},issues.concat({company:'Acme Energy Services India Limited',board:'Mainboard'})),null);
});
test('mainboard application amounts exceed strict thresholds in whole lots',()=>{
  const options=Core.categories({board:'Mainboard',priceBand:'Rs.100 to Rs.200',info:{lotSize:100}});
  assert.equal(options[0].amount,20000);assert.equal(options[1].amount,220000);assert.equal(options[2].amount,1020000);
  assert.equal(Core.categories({board:'Mainboard',priceBand:'200',info:{lotSize:1001}}).some(o=>o.key==='retail'),false);
});
test('SME uses its two-lot individual minimum and does not invent terms for small lots',()=>{
  const options=Core.categories({board:'SME',priceBand:'100',info:{lotSize:1200},categories:[{key:'retail',applications:5,times:null}]});
  assert.equal(options[0].key,'individual');assert.equal(options[0].lots,2);assert.equal(options[0].amount,240000);
  assert.equal(options[0].applications,5);assert.equal(options[0].times,null);
  assert.deepEqual(Core.categories({board:'SME',priceBand:'100',info:{lotSize:500}}),[]);
});
test('calendar escapes text and folds Unicode without corrupting it',()=>{
  const text=Core.calendar('Example',[{date:'2026-10-23',kind:'close',label:'मराठी, test; '+ 'समारोह '.repeat(40),key:'example'},{date:null,kind:'open'}],new Date('2026-10-22T00:00:00Z'));
  assert.ok(text.includes('DTEND;VALUE=DATE:20261024'));assert.ok(text.includes('\\,'));assert.ok(!text.includes('\ufffd'));
  assert.equal((text.match(/BEGIN:VEVENT/g)||[]).length,1);
  for(const line of text.split('\r\n'))assert.ok(Buffer.byteLength(line)<=75);
});
const fixture=(old=false)=>`<h3>Current SME IPO</h3><table><tr><th>Company</th><th>GMP</th><th>Trend</th><th>Price Band</th><th>Est Gain</th><th>Date</th></tr>
<tr><td><a href="/example-ipo-gmp-grey-market-premium/">Example Works</a><br><span>Open</span></td><td>₹0</td><td>🟡</td><td>₹120</td><td>₹120 (0.00%)</td><td>21-23 Oct</td>${old?'<td>open</td><td>12:00</td>':''}</tr></table>`;
test('GMP parser accepts six and eight columns, excludes headers and resolves source URLs',()=>{
  for(const old of [false,true]){const rows=sources.parseGmp(fixture(old));assert.equal(rows.length,1);assert.equal(rows[0].name,'Example Works');
    assert.equal(rows[0].gmp,0);assert.equal(rows[0].board,'SME');assert.equal(rows[0].status,'open');assert.equal(rows[0].page,'https://ipowatch.in/example-ipo/');}
  assert.deepEqual(sources.parseGmp('<table><tr><td>Blocked</td></tr></table>'),[]);
});
test('recorded history has explicit provenance and keeps existing archive points',()=>{
  const history={example:{name:'Example',points:[{t:'2026-10-02T10:00:00Z',gmp:5}]}};
  sources.recordHistory(history,[{key:'example',name:'Example',gmp:0}],'2026-10-22T10:00:00Z');
  assert.equal(history.example.points.length,2);assert.equal(history.example.points[1].source,'fetched');assert.equal(history.example.points[0].source,undefined);
});
test('research compares consecutive full years and keeps interim losses separate',()=>{
  const report=Core.research({priceBand:'100'},{about:'An engineering business.',financials:[{period:'2024',revenue:100,pat:10},{period:'2025',revenue:120,pat:12},{period:'June 2026',revenue:50,pat:-3}],kpis:{eps:5,debtEquity:1.2}});
  assert.equal(report.pe,20);assert.ok(report.facts.some(f=>f.title==='Revenue grew'&&f.detail.startsWith('20.0%')));
  assert.ok(report.facts.some(f=>f.title==='Interim loss reported'));assert.ok(report.questions.some(q=>q.includes('interim loss')));
  const gap=Core.research({}, {financials:[{period:'2023',revenue:100},{period:'2025',revenue:200}]});
  assert.ok(!gap.facts.some(f=>f.title==='Revenue grew'));
  assert.equal(Core.research({},{}).coverage,0);
  assert.ok(Core.research({}, {financials:[{period:'2025',revenue:100,pat:5,spentMore:true}]}).questions.some(q=>q.includes('exceptional items')));
});
test('legacy closing prices are never passed off as listing opens',()=>{
  const p=Core.performance({priceBand:'100',info:{lotSize:10},listing:{listPrice:120,cmp:110,issuePrice:100}});
  assert.equal(p.open,null);assert.equal(p.close,120);assert.equal(p.closingGain,20);assert.equal(p.totalReturn,10);
  assert.equal(p.cost,1000);assert.equal(p.value,1100);assert.equal(p.profit,100);
});
test('listing parser aligns exact listing date, preserves quote time, and distinguishes open/close',()=>{
  const stamps=['2026-10-19T09:00:00Z','2026-10-20T09:00:00Z','2026-10-21T09:00:00Z'].map(d=>Date.parse(d)/1000);
  const result={timestamp:stamps,meta:{regularMarketPrice:130,regularMarketTime:stamps[2],currency:'INR'},indicators:{quote:[{open:[99,110,125],close:[100,120,130]}]}};
  const quote=sources.parseListingData(result,'2026-10-20',100,'TEST');
  assert.equal(quote.listingOpen,110);assert.equal(quote.listingClose,120);assert.equal(quote.listGainPct,10);assert.equal(quote.listingCloseGainPct,20);
  assert.equal(quote.quoteAsOf,'2026-10-21T09:00:00.000Z');assert.equal(quote.history.length,3);
  assert.equal(sources.parseListingData(result,'2026-10-18',100,'TEST').listingOpen,null);
  const split=sources.parseListingData({...result,events:{splits:{event:{numerator:2,denominator:1}}}},'2026-10-20',100,'TEST');
  assert.equal(split.listGainPct,null);assert.equal(Core.performance({listing:split}).totalReturn,null);assert.equal(split.cmp,130);
});
test('company profiles accept manufacturing descriptions without accepting valuation boilerplate',()=>{
  assert.equal(sources.looksLikeDescription('Example Industries manufactures specialised components used in railway equipment and industrial automation, supplying customers across several regions.'),true);
  assert.equal(sources.looksLikeDescription('Check Example Industries IPO valuations detail like Earning Per Share, Price/Earning Ratio and Return on Net Worth details before applying.'),false);
});
