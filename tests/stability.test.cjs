const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const Core=require('../js/core'),{read}=require('../lib/request'),{writeJson}=require('../lib/storage');
const {createLiveCache}=require('../lib/live-cache');
const {checkPublished}=require('../scripts/check-published.cjs');
const {publish}=require('../scripts/publish-data.cjs');
const stamp=new Date().toISOString();
const ipos={fetchedAt:stamp,ipos:[{company:'Example',board:'Mainboard',categories:[]}]};
const gmp={fetchedAt:stamp,gmp:[{name:'Example',key:'example',gmp:0}]};

test('transient transport/server errors retry once; permanent and malformed responses fail promptly',async()=>{
  let calls=0;
  const result=await read('https://example.test',{sleep:async()=>{},fetchImpl:async()=>++calls===1?{ok:false,status:503}:{ok:true,json:async()=>({ok:true})}});
  assert.equal(result.ok,true);assert.equal(calls,2);
  for(const malformed of [false,true]){
    calls=0;
    await assert.rejects(read('https://example.test',{sleep:async()=>{},fetchImpl:async()=>{calls++;return malformed?{ok:true,json:async()=>{throw new SyntaxError('Bad JSON')}}:{ok:false,status:404};}}));
    assert.equal(calls,1);
  }
  calls=0;
  await assert.rejects(read('https://example.test',{sleep:async()=>{},fetchImpl:async()=>{calls++;throw Error('Network down')}}),/Network down/);
  assert.equal(calls,2);
});

test('schema validation rejects malformed data before it can replace a snapshot',()=>{
  assert.equal(Core.validSnapshot('ipos',ipos),true);assert.equal(Core.validSnapshot('gmp',gmp),true);
  for(const bad of [{...ipos,ipos:[null]},{...ipos,ipos:[{company:'Example',categories:{}}]},{...ipos,ipos:[]},{...ipos,fetchedAt:'bad'}])assert.equal(Core.validSnapshot('ipos',bad),false);
  assert.equal(Core.validSnapshot('gmp',{...gmp,gmp:[{name:'Example',key:'example',gmp:'0'}]}),false);
});

test('failed persistence does not promote an unpublished snapshot into memory',async()=>{
  const saved={gmp:[{name:'Example',key:'example',gmp:1}],fetchedAt:'2020-01-01T00:00:00Z'};let calls=0,fail=true;
  const get=createLiveCache({read:()=>saved,validate:Core.validSnapshot,write:()=>{if(fail)throw Error('Disk full')}});
  const produce=async()=>[{name:'Example',key:'example',gmp:++calls+1}];
  const first=await get('gmp',produce);assert.equal(first.fetchedAt,saved.fetchedAt);assert.equal(first.sourceError,'Disk full');
  fail=false;assert.equal((await get('gmp',produce)).gmp[0].gmp,3);assert.equal(calls,2);
});

function temporary(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ipo-stability-'));
  t.after(()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('ipo-stability-'));fs.rmSync(root,{recursive:true,force:true});});
  return root;
}
test('an interrupted atomic write retains the previous JSON and cleans its temporary file',t=>{
  const root=temporary(t),file=path.join(root,'snapshot.json');writeJson(file,{value:1});
  assert.throws(()=>writeJson(file,{value:2},{io:{...fs,renameSync(){throw Error('Rename failed')}}}),/Rename failed/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)),{value:1});assert.deepEqual(fs.readdirSync(root),['snapshot.json']);
  writeJson(file,{value:3});assert.deepEqual(JSON.parse(fs.readFileSync(file)),{value:3});
});

function fixtureLoad(overrides={}){
  const assets={'styles.css':'body{}','js/app.js':'let app=1;','js/core.js':'let core=1;','js/charts.js':'let charts=1;'};
  const refs=Object.entries(assets).map(([file,source])=>file+'?v='+require('node:crypto').createHash('sha256').update(source).digest('hex').slice(0,12)).join(' ');
  const files={'':'<div id="home-results"></div><div id="stunityCredit"></div>'+refs,...assets,'sw.js':'let worker=1;','data/ipos.json':ipos,'data/gmp.json':gmp,'data/source-health.json':{sources:{ipos:{provider:'ipowatch',status:'ok'},gmp:{provider:'ipowatch',status:'ok'}}},...overrides};
  return async file=>files[file];
}
test('public-site check validates actual assets, schema and critically stale sources',async()=>{
  const result=await checkPublished({load:fixtureLoad()});assert.equal(result.sources.ipos.records,1);
  await assert.rejects(checkPublished({load:fixtureLoad({'js/app.js':'<!doctype html>'})}),/Unexpected token/);
  await assert.rejects(checkPublished({load:fixtureLoad({'js/app.js':'let differentRelease=true;'})}),/version mismatch/);
  await assert.rejects(checkPublished({load:fixtureLoad({'data/ipos.json':{...ipos,ipos:[]}})}),/malformed or empty/);
  await assert.rejects(checkPublished({load:fixtureLoad({'data/gmp.json':{...gmp,fetchedAt:'2020-01-01T00:00:00Z'}})}),error=>error.refreshNeeded===true&&/critically stale/.test(error.message));
  const stale={...gmp,fetchedAt:new Date(Date.now()-3*3600000).toISOString()};
  const resultStale=await checkPublished({load:fixtureLoad({'data/gmp.json':stale})});
  assert.ok(resultStale.warnings.length);assert.equal(resultStale.refreshNeeded,true);assert.equal(result.refreshNeeded,false);
});

test('simultaneous data writers rebase and retry without losing either publication',t=>{
  const root=temporary(t),remote=path.join(root,'remote.git'),a=path.join(root,'a'),b=path.join(root,'b');
  const git=(cwd,...args)=>{const r=spawnSync('git',args,{cwd,encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  git(root,'init','--bare','--initial-branch=main',remote);git(root,'clone',remote,a);
  git(a,'config','user.name','Fixture');git(a,'config','user.email','fixture@example.test');
  fs.mkdirSync(path.join(a,'data'));
  for(const file of ['ipos','gmp','gmp-history','source-health','market','fundamentals','corporate','reports'])fs.writeFileSync(path.join(a,'data',file+'.json'),'{}');
  git(a,'add','.');git(a,'commit','-m','Fixture');git(a,'push','origin','main');git(root,'clone',remote,b);
  fs.writeFileSync(path.join(a,'data','ipos.json'),' {"newIpos":true}');fs.writeFileSync(path.join(b,'data','market.json'),' {"newMarket":true}');
  const result=publish({cwd:a,mode:'core',beforePush(attempt){if(attempt===1)publish({cwd:b,mode:'market'});}});
  assert.equal(result.attempts,2);
  assert.equal(JSON.parse(git(remote,'show','main:data/ipos.json')).newIpos,true);
  assert.equal(JSON.parse(git(remote,'show','main:data/market.json')).newMarket,true);
  assert.equal(publish({cwd:a,mode:'core'}).changed,false);
  fs.writeFileSync(path.join(a,'unrelated.txt'),'private work');git(a,'add','unrelated.txt');
  assert.throws(()=>publish({cwd:a,mode:'core'}),/Unrelated staged changes/);
});
