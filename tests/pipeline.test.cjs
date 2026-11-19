const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const Core=require('../js/core');

async function run(mode,{badIpos=false,badGmp=false}={}){
  const stamp=new Date().toISOString(),today=Core.marketDate();
  const ipos=[{company:'Example',start:today,end:today,info:{},categories:[]}],gmp=[{name:'Example',key:'example',gmp:0}];
  const files={'ipos.json':{fetchedAt:stamp,ipos},'gmp.json':{fetchedAt:stamp,gmp},'gmp-history.json':{},'fundamentals.json':{example:{v:1}},'source-health.json':{sources:{}}},writes=[],calls=[];
  const sources={
    getIposEnriched:async()=>badIpos?[null]:ipos,getGmp:async()=>badGmp?[]:gmp,
    recordHistory(history){calls.push('observe');return history},pruneHistory:history=>history,
    backfillHistory:async()=>{calls.push('backfill');return {added:0}},backfillListedHistory:async()=>({added:0}),
    nameKey:Core.nameKey,FUNDAMENTALS_VERSION:1,getFundamentals:async()=>{calls.push('fundamentals');return{}},
    getCorporateActions:async()=>{calls.push('corporate');return[]},getQuotes:async()=>({}),
  };
  const process={argv:['node','fetch-data.js',mode]},console={log(){},warn(){},error(){}};
  const requireStub=name=>name==='fs'?{readFileSync:file=>JSON.stringify(files[path.basename(file)])}
    :name==='../lib/net'?{relaunchWithSystemCa:()=>false,preferIpv4(){}}
    :name==='../lib/sources'?sources:name==='../js/core'?Core
    :name==='../lib/storage'?{writeJson(file,value){files[path.basename(file)]=value;writes.push(path.basename(file));}}:require(name);
  const code=fs.readFileSync(require.resolve('../scripts/fetch-data.js'),'utf8').replace(/^#!.*\r?\n/,'').replace('(async () => {','return (async () => {');
  await new Function('require','__dirname','__filename','process','console',code)(requireStub,path.resolve(__dirname,'../scripts'),require.resolve('../scripts/fetch-data.js'),process,console);
  return {files,writes,calls,process};
}
test('essential publication is independent of optional enrichments',async()=>{
  const result=await run('--core-only');assert.ok(result.writes.includes('ipos.json'));assert.ok(result.writes.includes('gmp.json'));
  assert.deepEqual(result.calls,['observe']);assert.equal(result.writes.includes('corporate.json'),false);
});
test('enrichment does not re-fetch, re-stamp or invent source observations',async()=>{
  const result=await run('--enrich-only');assert.ok(result.calls.includes('backfill'));assert.ok(result.calls.includes('corporate'));
  for(const file of ['ipos.json','gmp.json','source-health.json'])assert.equal(result.writes.includes(file),false);
  assert.equal(result.calls.includes('observe'),false);
});
test('invalid and failed core sources leave last-good records intact',async()=>{
  const partial=await run('--core-only',{badIpos:true});assert.equal(partial.writes.includes('ipos.json'),false);assert.equal(partial.files['source-health.json'].sources.ipos.status,'failed');
  const total=await run('--core-only',{badIpos:true,badGmp:true});assert.equal(total.process.exitCode,1);assert.deepEqual([...new Set(total.writes)],['source-health.json']);
});
