/* Cache one complete release so repeat visits can open during a network outage.
 * Data remains network-only: the app validates and dates its saved snapshots. */
'use strict';
const VERSION = "15aa424135d2e412";
const SHELL = ["index.html","styles.css?v=80490b762e9a","js/core.js?v=eb31593bc0b4","js/charts.js?v=236859d4d8f5","js/app.js?v=e9963b3eea1e"];
const INTEGRITY = {"index.html":"sha256-FapCQTXS5BIbzk8PTHfqTcZCutW2hW5i5EXpCd/A4Jk=","styles.css?v=80490b762e9a":"sha256-gEkLdi6alks0LLiuUvmuNxEVyzYXvysTgix0n8rZC4Y=","js/core.js?v=eb31593bc0b4":"sha256-6zFZO8C0QyM2bbiC3eWwYTJXpHfT6FD70WjzpAk7HyY=","js/charts.js?v=236859d4d8f5":"sha256-I2hZ1Nj1RFhu6bbbZfSzeYPEUxevm1Mzplvm6NfUjb4=","js/app.js?v=e9963b3eea1e":"sha256-6ZY7PuoecG1bjKTLkq5wOPqnZMQmsB697jych3TOdr4="};
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
