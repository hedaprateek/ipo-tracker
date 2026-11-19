const {test}=require('node:test'),assert=require('node:assert/strict');
const Core=require('../js/core');
const fs=require('node:fs');

test('incompatible saved settings cannot stop startup; valid notes survive',()=>{
  for(const key of ['watch','compare','ids'])assert.deepEqual(Core.storedValue('ipotracker.'+key,{},[]),[]);
  const note={name:'Example',note:'Read the offer document',status:'Shortlist'};
  assert.deepEqual(Core.storedValue('ipotracker.decisions',{example:note,broken:null,old:'text'},{}),{example:note});
  assert.deepEqual(Core.storedValue('ipotracker.watch',[null,42,'example'],[]),['example']);
  assert.deepEqual(Core.storedValue('ipotracker.filters',{q:42,status:'open'},{}),{status:'open'});
  assert.equal(Core.storedValue('ipotracker.remember','false',false),false);
});

test('browser transport retries transient failures without AbortSignal.timeout',async()=>{
  let calls=0;
  const value=await Core.requestJson('/data/ipos.json',{sleep:async()=>{},fetchImpl:async(_url,options)=>{
    assert.ok(options.signal instanceof AbortSignal);
    return ++calls===1?{ok:false,status:503}:{ok:true,json:async()=>({ok:true})};
  }});
  assert.deepEqual(value,{ok:true});assert.equal(calls,2);
});

test('browser timeout covers a stuck response body and clears pending requests',async()=>{
  let calls=0,signal;
  await assert.rejects(Core.requestJson('/data/ipos.json',{timeout:15,attempts:1,fetchImpl:async(_url,options)=>{
    calls++;signal=options.signal;return {ok:true,json:()=>new Promise(()=>{})};
  }}),/timed out/);
  assert.equal(calls,1);assert.equal(signal.aborted,true);
});

test('browser malformed responses and permanent errors are not retried',async()=>{
  for(const malformed of [true,false]){
    let calls=0;
    await assert.rejects(Core.requestJson('/data/ipos.json',{sleep:async()=>{},fetchImpl:async()=>{
      calls++;return malformed?{ok:true,json:async()=>{throw SyntaxError('Invalid JSON')}}:{ok:false,status:404};
    }}));
    assert.equal(calls,1);
  }
});

function delivery(hostname='hedaprateek.github.io',state={gmp:[],sourceTimes:{}}){
  const source=fs.readFileSync(require.resolve('../js/app.js'),'utf8');
  const helpers=source.slice(source.indexOf('const json ='),source.indexOf('async function detectMode()'));
  return new Function('Core','location','state',helpers+'return {publishedSnapshot,acceptsSnapshot};')(Core,{hostname},state);
}
const quote=stamp=>({fetchedAt:stamp,gmp:[{name:'Example',key:'example',gmp:5}]});
test('published data falls back to its own repository after an outage or a delayed deployment',async t=>{
  const current=quote(new Date().toISOString()),old=quote('2020-01-01T00:00:00Z');let primary=null,calls=[];
  t.mock.method(globalThis,'fetch',async url=>{
    calls.push(url);const value=url.startsWith('https://raw.githubusercontent.com/')?current:primary;
    return value?{ok:true,json:async()=>value}:{ok:false,status:404};
  });
  assert.deepEqual(await delivery().publishedSnapshot('gmp'),current);
  assert.deepEqual(calls,['data/gmp.json','https://raw.githubusercontent.com/hedaprateek/ipo-tracker/main/data/gmp.json']);
  primary=old;calls=[];assert.deepEqual(await delivery().publishedSnapshot('gmp'),current);
  primary=current;calls=[];await delivery().publishedSnapshot('gmp');assert.deepEqual(calls,['data/gmp.json']);
  primary=null;calls=[];await assert.rejects(delivery('localhost').publishedSnapshot('gmp'),/404/);assert.deepEqual(calls,['data/gmp.json']);
});
test('older publications cannot replace saved records; malformed saved times can recover',()=>{
  const current=quote(new Date().toISOString()),old=quote('2020-01-01T00:00:00Z');
  const state={gmp:current.gmp,sourceTimes:{gmp:current.fetchedAt}},helpers=delivery(undefined,state);
  assert.equal(helpers.acceptsSnapshot('gmp',{status:'fulfilled',value:old}),false);
  assert.equal(helpers.acceptsSnapshot('gmp',{status:'fulfilled',value:current}),true);
  state.sourceTimes.gmp='broken';assert.equal(helpers.acceptsSnapshot('gmp',{status:'fulfilled',value:current}),true);
  assert.equal(Core.validSnapshot('gmp',quote('2099-01-01T00:00:00Z')),false);
});
