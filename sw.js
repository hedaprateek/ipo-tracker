/* Cache one complete release so repeat visits can open during a network outage.
 * Data remains network-only: the app validates and dates its saved snapshots. */
'use strict';
const VERSION = "01ddbfc4d854e88e";
const SHELL = ["index.html","styles.css?v=aa731672a9a0","js/core.js?v=f52a16ba9c48","js/charts.js?v=236859d4d8f5","js/app.js?v=48bb8fed9584"];
const INTEGRITY = {"index.html":"sha256-Ad2/xNhU6I7azhG/94/Ay5Ber7Ihh+E0izABnHmv+j8=","styles.css?v=aa731672a9a0":"sha256-qnMWcqmgP+lORU/P4FTMmw/dbKYL0uQ4Y4fl7rYNctc=","js/core.js?v=f52a16ba9c48":"sha256-9SoWupxITpnp8JgPdkJn6XmIFx9MESi5k+xRJK/0Z0I=","js/charts.js?v=236859d4d8f5":"sha256-I2hZ1Nj1RFhu6bbbZfSzeYPEUxevm1Mzplvm6NfUjb4=","js/app.js?v=48bb8fed9584":"sha256-SLuP7ZWErKl7TbEEWg8pVHw2Me9g7oovdVckLVo4BqM="};
const ROOT = new URL('./',self.location.href);
const PREFIX = 'ipo-shell:'+ROOT.pathname+':';
const CACHE = PREFIX+VERSION;
self.addEventListener('install',event=>{
  // Do not replace a worker used by an open tab: keep each release together.
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL.map(file=>new Request(new URL(file,ROOT),{cache:'reload',integrity:INTEGRITY[file]})))));
});
self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    for(const key of await caches.keys())if(key.startsWith(PREFIX)&&key!==CACHE)await caches.delete(key);
    await self.clients.claim();
  })());
});
async function navigation(request){
  const controller=new AbortController();let timer;
  try{
    const response=await Promise.race([
      fetch(request,{signal:controller.signal}),
      new Promise((_,reject)=>{timer=setTimeout(()=>{reject(Error('Navigation timed out'));controller.abort();},5000);}),
    ]);
    if(response.ok)return response;
    throw Error('Navigation unavailable');
  }catch(error){
    const cached=await caches.match(new URL('index.html',ROOT).href,{cacheName:CACHE});
    if(cached)return cached;
    throw error;
  }finally{clearTimeout(timer);}
}
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||url.origin!==ROOT.origin)return;
  if(event.request.mode==='navigate'&&[ROOT.pathname,ROOT.pathname+'index.html'].includes(url.pathname)){
    event.respondWith(navigation(event.request));return;
  }
  // Exact versioned asset matches only. Never serve a different script version,
  // intercept another app on this origin, or cache JSON and personal information.
  if(SHELL.slice(1).some(file=>new URL(file,ROOT).href===url.href)){
    event.respondWith(caches.match(event.request,{cacheName:CACHE}).then(hit=>hit||fetch(event.request)));
  }
});
