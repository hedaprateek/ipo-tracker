const {test}=require('node:test'),assert=require('node:assert/strict');
const stamp=new Date().toISOString();
const feed={status:1,result:[{ipoName:'Example',ipoGmp:'₹17',Type:'Mainboard',priceBand:'₹100',Status:'Open',LastUpdated:'20 Nov, 07:49'}]};
const saved={fetchedAt:'2020-01-01T00:00:00Z',gmp:[{name:'Example',key:'example',gmp:5}]};
const load=()=>import('../worker/live.mjs');

test('on-demand edge feed coalesces requests and reuses its short cache',async()=>{
  const {createDataService}=await load();let calls=0,tick=Date.now();
  const service=createDataService({seeds:{},now:()=>tick,fetchImpl:async()=>{calls++;return {ok:true,json:async()=>feed};}});
  const [a,b]=await Promise.all([service.snapshot('gmp'),service.snapshot('gmp')]);
  assert.equal(a.gmp[0].gmp,17);assert.equal(a.fetchedAt,b.fetchedAt);assert.equal(calls,1);
  await service.snapshot('gmp');assert.equal(calls,1);
  tick+=121000;await service.snapshot('gmp');assert.equal(calls,2);
});
test('edge source outages retain saved values and observation dates',async()=>{
  const {createDataService}=await load();
  const service=createDataService({seeds:{gmp:saved},fetchImpl:async()=>({ok:false,status:503})});
  const value=await service.snapshot('gmp');assert.equal(value.gmp[0].gmp,5);assert.equal(value.fetchedAt,saved.fetchedAt);assert.equal(value.delivery,'saved');assert.ok(value.sourceError);
});
test('malformed edge responses cannot replace the previous good snapshot',async()=>{
  const {createDataService}=await load();let bad=false;
  const service=createDataService({seeds:{gmp:saved},fetchImpl:async()=>({ok:true,json:async()=>bad?{status:1,result:[]}:feed})});
  const current=await service.snapshot('gmp');bad=true;
  const failed=await service.snapshot('gmp',{force:true});assert.equal(failed.gmp[0].gmp,17);assert.equal(failed.fetchedAt,current.fetchedAt);
});
test('edge API permits the published app and rejects arbitrary routes and writes',async()=>{
  const {createDataService}=await load();
  const service=createDataService({seeds:{gmp:{...saved,fetchedAt:stamp}}});
  const allowed=await service.fetch(new Request('https://data.example/api/gmp',{headers:{Origin:'https://hedaprateek.github.io'}}));
  assert.equal(allowed.status,200);assert.equal(allowed.headers.get('Access-Control-Allow-Origin'),'https://hedaprateek.github.io');
  assert.equal((await service.fetch(new Request('https://data.example/api/gmp',{headers:{Origin:'https://other.example'}}))).status,403);
  assert.equal((await service.fetch(new Request('https://data.example/api/gmp',{method:'POST',body:'private note'}))).status,405);
  assert.equal((await service.fetch(new Request('https://data.example/proxy?url=https://other.example'))).status,404);
});
