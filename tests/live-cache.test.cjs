const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createLiveCache}=require('../lib/live-cache');

test('cache reads retain source time; expired and manual refreshes fetch again',async()=>{
  let time=Date.parse('2026-10-23T07:00:00Z'),calls=0,writes=0;
  const get=createLiveCache({now:()=>time,read:()=>null,write:()=>writes++});
  const produce=async()=>[{value:++calls}];
  const first=await get('gmp',produce);time+=30000;
  assert.deepEqual(await get('gmp',produce),first);assert.equal(calls,1);
  const forced=await get('gmp',produce,{force:true});assert.notEqual(forced.fetchedAt,first.fetchedAt);
  time+=60001;await get('gmp',produce);assert.equal(calls,3);assert.equal(writes,3);
});
test('simultaneous refreshes share one upstream request',async()=>{
  let release,calls=0;
  const get=createLiveCache({read:()=>null,write:()=>{}});
  const produce=()=>{calls++;return new Promise(resolve=>release=resolve);};
  const a=get('ipos',produce),b=get('ipos',produce,{force:true});
  release([{symbol:'EXAMPLE'}]);assert.deepEqual(await a,await b);assert.equal(calls,1);
});
test('failed or empty sources preserve last good data and timestamp without writing history',async()=>{
  const saved={gmp:[{gmp:10}],fetchedAt:'2026-01-01T00:00:00Z'};let writes=0;
  const get=createLiveCache({read:()=>saved,write:()=>writes++});
  const failed=await get('gmp',async()=>{throw Error('Source unavailable');});
  assert.equal(failed.sourceError,'Source unavailable');assert.equal(failed.fetchedAt,saved.fetchedAt);
  assert.deepEqual(failed.gmp,saved.gmp);assert.equal(writes,0);
  const empty=await get('gmp',async()=>[]);assert.match(empty.sourceError,/no records/);assert.equal(writes,0);
});
