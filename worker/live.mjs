import Core from '../js/core.js';
import Sources from '../lib/sources.js';
import Watch from '../lib/ipo-watch.js';
import seedIpos from '../data/ipos.json' with {type:'json'};
import seedGmp from '../data/gmp.json' with {type:'json'};

const UPSTREAM='https://ipowatch.in/server/api/ipo/';
const ALLOWED_ORIGIN='https://hedaprateek.github.io';
const TTL=120000;

// This is a fixed-purpose public data service, never a URL relay. No visitor
// credentials or personal entries are accepted, stored or forwarded.
export function createDataService({cache,fetchImpl=globalThis.fetch,now=Date.now,seeds={ipos:seedIpos,gmp:seedGmp}}={}){
  const memory=new Map(),pending=new Map();
  const load=endpoint=>Core.requestJson(UPSTREAM+endpoint,{fetchImpl,timeout:5500,attempts:1});
  const cacheKey=key=>new Request('https://hedaprateek.github.io/ipo-tracker/__live_cache__/'+key);
  async function snapshot(key,{force=false}={}){
    if(pending.has(key))return pending.get(key);
    const task=(async()=>{
      let previous=memory.get(key);
      if(!previous&&cache)try{previous=await (await cache.match(cacheKey(key)))?.json();}catch{}
      if(!Core.validSnapshot(key,previous))previous=seeds[key];
      if(!force&&Core.validSnapshot(key,previous)&&!previous.sourceError&&now()-Date.parse(previous.fetchedAt)<TTL)return {...previous,delivery:'cache'};
      try{
        let rows,componentError=null;
        const stamp=new Date(now()).toISOString();
        if(key==='gmp')rows=Sources.parseGmpApi(await load('GetIpoGMPHistory'));
        else{
          const [listing,bids]=await Promise.all([load('GetIpoListing'),load('GetIpoAubscription').catch(error=>{componentError=error.message;return null;})]);
          const issues=Watch.parseListing(listing);
          if(!issues.length||issues.length!==listing.data.length)throw Error('Invalid IPO listing');
          rows=Watch.mergeIpos(issues,Watch.parseSubscriptions(bids),previous?.ipos||[],{now:stamp,previousFetchedAt:previous?.fetchedAt,subscriptionError:componentError});
        }
        const value={ok:true,fetchedAt:stamp,provider:'ipowatch',delivery:'live',[key]:rows};
        if(!Core.validSnapshot(key,value))throw Error('Invalid '+key+' feed');
        memory.set(key,value);
        if(cache)try{await cache.put(cacheKey(key),new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json','Cache-Control':'public, max-age=604800'}}));}catch{}
        return value;
      }catch(error){
        if(!Core.validSnapshot(key,previous))throw error;
        return {...previous,delivery:'saved',sourceError:'Latest source check could not complete'};
      }
    })();
    pending.set(key,task);
    try{return await task;}finally{pending.delete(key);}
  }
  return {
    snapshot,
    async fetch(request){
      const url=new URL(request.url),origin=request.headers.get('Origin');
      const cors={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Vary':'Origin'};
      if(origin===ALLOWED_ORIGIN||origin===url.origin)cors['Access-Control-Allow-Origin']=origin;
      if(origin&&origin!==ALLOWED_ORIGIN&&origin!==url.origin)return new Response('{"error":"Origin not allowed"}',{status:403,headers:cors});
      if(request.method!=='GET')return new Response('{"error":"GET only"}',{status:405,headers:{...cors,Allow:'GET'}});
      if(url.pathname==='/api/health')return Response.json({ok:true,service:'IPO Tracker data',credit:'Stunity Tech — by Prateek'},{headers:cors});
      const key={'/api/ipos':'ipos','/api/gmp':'gmp'}[url.pathname];
      if(!key)return new Response('{"error":"Not found"}',{status:404,headers:cors});
      try{return Response.json(await snapshot(key),{headers:cors});}
      catch{return new Response('{"error":"Source temporarily unavailable"}',{status:503,headers:cors});}
    },
  };
}
let service;
const getService=()=>service||(service=createDataService({cache:globalThis.caches?.default}));
export default {
  fetch(request){return getService().fetch(request);},
  scheduled(_event,_env,ctx){ctx.waitUntil(Promise.allSettled(['ipos','gmp'].map(key=>getService().snapshot(key,{force:true}))));},
};
