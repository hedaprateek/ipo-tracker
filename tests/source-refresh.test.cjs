const {test} = require('node:test');
const assert = require('node:assert/strict');
const sources = require('../lib/sources');
const fs = require('node:fs');
const vm = require('node:vm');

// Shape returned by IPO Watch's redesigned public feed (November 2026).
const feed = {status: 1, result: [
  {ipoName:'Example Crops', ipo_slug:'example-crops-ipo-details', ipoGmp:'₹13',
    trendIcon:'fa-arrow-up', priceBand:'₹259 - ₹272', estListing:'₹285 (4.78%)',
    IPODate:'18 Nov - 20 Nov', Type:'Mainboard', Status:'Upcoming', LastUpdated:'17 Nov, 14:51'},
  {ipoName:'Example Rentals', ipo_slug:'example-rentals-ipo-details', ipoGmp:'₹0',
    trendIcon:'fa-arrow-right', priceBand:'₹232 - ₹245', estListing:'₹245 (0.00%)',
    IPODate:'19 Nov - 23 Nov', Type:'NSE Emerge', Status:'Open', LastUpdated:'17 Nov, 14:52'},
  {ipoName:'Example Works', ipo_slug:'example-works-ipo-details', ipoGmp:'-₹5',
    trendIcon:'fa-arrow-down', priceBand:'₹100', estListing:'₹95 (-5.00%)',
    Type:'BSE SME', Status:'Closed'},
]};

test('redesigned GMP feed preserves board, band cap, zero/negative premiums and source metadata', () => {
  const rows = sources.parseGmpApi(feed);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r=>[r.board,r.price,r.gmp,r.trend,r.estGainPct]), [
    ['Mainboard',272,13,'up',4.78], ['SME',245,0,'flat',0], ['SME',100,-5,'down',-5],
  ]);
  assert.equal(rows[0].page, 'https://ipowatch.in/example-crops-ipo-details');
  assert.equal(rows[0].updated, '17 Nov, 14:51');
  assert.equal(rows[1].status, 'open');
  assert.equal(rows[1].dates, '19 Nov - 23 Nov');
});

test('GMP feed rejects failed, empty and malformed responses instead of inventing prices', () => {
  for (const payload of [null, {}, {status:0,result:feed.result}, {status:1,result:[]},
    {status:1,result:[null,{}, {...feed.result[0],ipoGmp:'TBA'}, {...feed.result[0],Type:'unknown'}]}]) {
    assert.deepEqual(sources.parseGmpApi(payload), []);
  }
  const row = sources.parseGmpApi({status:1,result:[{...feed.result[0],ipo_slug:'https://other.example/'}]})[0];
  assert.equal(row.page, null);
});

test('GMP fetch reads the public JSON endpoint without depending on rendered tables', async t => {
  const calls=[];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url);
    return {ok:true,json:async()=>feed};
  });
  assert.equal((await sources.getGmp()).length, 3);
  assert.deepEqual(calls, ['https://ipowatch.in/server/api/ipo/GetIpoGMPHistory']);
});

test('GMP fetch falls back to legacy tables and rejects an empty redesigned page', async t => {
  let legacy=true;
  t.mock.method(globalThis, 'fetch', async url => url.includes('/server/')
    ? {ok:false,status:503}
    : {ok:true,text:async()=>legacy
      ? '<h3>Mainboard</h3><table><tr><th>Company</th><th>GMP</th><th>Trend</th><th>Price</th><th>Gain</th><th>Date</th></tr><tr><td>Example</td><td>₹0</td><td>flat</td><td>₹100</td><td>₹100 (0%)</td><td>18 Nov</td></tr></table>'
      : '<div>Loading GMP data...</div>'});
  assert.equal((await sources.getGmp())[0].gmp, 0);
  legacy=false;
  await assert.rejects(sources.getGmp(), /JSON feed HTTP 503; no valid GMP table rows/);
});

test('parallel NSE feeds share cookie bootstrap and retry a transient API failure', async t => {
  let homepages=0, currentCalls=0;
  t.mock.method(globalThis, 'fetch', async url => {
    if (url==='https://www.nseindia.com/') {
      homepages++;
      return {headers:{getSetCookie:()=>['session=example; Path=/']}};
    }
    if (url.endsWith('/ipo-current-issue') && ++currentCalls===1) return {ok:false,status:503};
    const data=url.endsWith('/ipo-current-issue')
      ? [{symbol:'EXAMPLE',companyName:'Example',issueStartDate:'18-Nov-2026',issueEndDate:'20-Nov-2026',issuePrice:'259 - 272',series:'EQ'}] : [];
    return {ok:true,text:async()=>JSON.stringify(data)};
  });
  const rows=await sources.getIpos();
  assert.equal(rows.length,1);
  assert.equal(rows[0].symbol,'EXAMPLE');
  assert.equal(currentCalls,2);
  assert.equal(homepages,2); // One shared bootstrap, then one renewed session.
});

test('workflow health gate still fails after a failed refresh even if the saved snapshot is recent', () => {
  const script=fs.readFileSync(require.resolve('../scripts/check-health.js'),'utf8');
  for (const outcome of ['success','failure']) {
    const process={env:{IPO_FETCH_OUTCOME:outcome}};
    vm.runInNewContext(script, {
      process, __dirname:require('node:path').resolve(__dirname,'../scripts'),
      console:{log(){},error(){}},
      require(name) {
        if(name==='fs')return {readFileSync:()=>JSON.stringify({fetchedAt:new Date().toISOString()})};
        if(name==='../js/core')return require('../js/core');
        return require(name);
      },
    });
    assert.equal(process.exitCode, outcome==='failure'?1:undefined);
  }
});

test('health gate permits a partial publication with a warning and fails when both feeds are stale', () => {
  const script=fs.readFileSync(require.resolve('../scripts/check-health.js'),'utf8');
  for (const staleFeeds of [1,2]) {
    const process={env:{IPO_FETCH_OUTCOME:'success'}},warnings=[],summaries=[];
    let reads=0;
    vm.runInNewContext(script, {
      process, __dirname:require('node:path').resolve(__dirname,'../scripts'),
      console:{log(line){summaries.push(line)},error(line){warnings.push(line)}},
      require(name) {
        if(name==='fs')return {readFileSync:()=>JSON.stringify({fetchedAt:reads++<staleFeeds?'2020-01-01T00:00:00Z':new Date().toISOString()})};
        if(name==='../js/core')return require('../js/core');
        return require(name);
      },
    });
    assert.equal(warnings.length,staleFeeds);
    assert.ok(warnings.every(line=>line.startsWith('::warning::')));
    assert.equal(process.exitCode,staleFeeds===2?1:undefined);
    if(staleFeeds===1)assert.match(summaries.join('\n'),/Partial refresh/);
  }
});
