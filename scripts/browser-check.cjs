const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..'),out=path.join(root,'.cache','browser-check');fs.mkdirSync(out,{recursive:true});
let stale=false,live=false,apiVersion=10,forceRequests=0,dataRequests=0,sourceFailed=false,outage=false,optionalFailed=false,invalidCore=false,assetFailed=false,chrome,socket;
const server=http.createServer((req,res)=>{
  const request=new URL(req.url,'http://localhost');let pathname=request.pathname;
  if(assetFailed&&pathname==='/js/app.js'){res.writeHead(503).end('Temporary asset outage');return;}
  if(pathname.startsWith('/data/')||['/api/ipos','/api/gmp'].includes(pathname))dataRequests++;
  if(live&&pathname==='/api/health'){res.setHeader('Content-Type','application/json');res.end('{"ok":true}');return;}
  if(live&&['/api/ipos','/api/gmp'].includes(pathname)){
    if(request.searchParams.has('refresh'))forceRequests++;
    pathname=pathname.replace('/api/','/data/')+'.json';
  }
  if(outage&&pathname.startsWith('/data/')){res.writeHead(503).end('Source temporarily unavailable');return;}
  if(optionalFailed&&/^\/data\/(reports|fundamentals|corporate|market|gmp-history)\.json$/.test(pathname)){res.writeHead(503).end('Optional source unavailable');return;}
  if(invalidCore&&['/data/ipos.json','/data/gmp.json'].includes(pathname)){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({fetchedAt:new Date().toISOString(),ipos:[null],gmp:[{name:'Bad',key:'bad',gmp:'not a number'}]}));return;}
  const file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
  if(!file.startsWith(root+path.sep)||pathname.startsWith('/api/')){res.writeHead(404).end();return;}
  fs.readFile(file,(error,bytes)=>{if(error){res.writeHead(404).end();return;}
    const stamp=new Date().toISOString(),today=require('../js/core').marketDate();
    if(pathname==='/data/ipos.json'){const data=JSON.parse(bytes);data.fetchedAt=stamp;data.provider='ipowatch';data.ipos.unshift({company:'Browser Check Example Limited',symbol:'BROWSERTEST',board:'Mainboard',start:today,end:today,priceBand:'100',info:{lotSize:100},subscription:2,source:'ipowatch',sourceFetchedAt:stamp,primarySourceError:'Fixture NSE unavailable',subscriptionAsOf:today,categories:[{key:'retail',label:'Retail',times:2},{key:'snii',label:'sHNI',times:3},{key:'bnii',label:'bHNI',times:4}]});bytes=Buffer.from(JSON.stringify(data));}
    if(pathname==='/data/gmp.json'){const data=JSON.parse(bytes);data.fetchedAt=stale?'2020-01-01T00:00:00Z':stamp;data.gmp.push({name:'Browser Check Example',key:'browsercheckexample',board:'Mainboard',gmp:apiVersion,price:100,status:'open'});if(sourceFailed)data.sourceError='Fixture upstream unavailable';bytes=Buffer.from(JSON.stringify(data));}
    if(pathname==='/data/source-health.json')bytes=Buffer.from(JSON.stringify({sources:{ipos:{status:'ok'},gmp:{status:'ok'}}}));
    res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png'})[path.extname(file)]||'text/plain');res.end(bytes);});
});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const watchdog=setTimeout(()=>{console.error('Browser check exceeded 90 seconds');socket?.close();chrome?.kill();server.close();server.closeAllConnections();process.exit(1);},90000);watchdog.unref();
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
  const profile=path.join(out,'profile-'+Date.now());
  const executable=process.env.CHROME_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'google-chrome');
  let chromeLog='',launchError;
  chrome=spawn(executable,['--headless=new','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:['ignore','ignore','pipe'],windowsHide:true});
  chrome.stderr.on('data',chunk=>{chromeLog=(chromeLog+chunk).slice(-4000);});
  chrome.on('error',error=>{launchError=error;});
  // A busy hosted runner can take longer than six seconds to start Chrome.
  // Keep this inside the existing 90-second watchdog and report launch errors.
  let pages;for(let i=0;i<200;i++){
    if(launchError)throw launchError;
    if(chrome.exitCode!==null)throw Error('Chrome exited before startup: '+chromeLog);
    try{const port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];pages=await(await fetch('http://127.0.0.1:'+port+'/json',{signal:AbortSignal.timeout(1000)})).json();if(pages.some(p=>p.type==='page'))break;}catch{}await sleep(100);
  }
  assert.ok(pages?.some(p=>p.type==='page'),'Chrome started within 20 seconds: '+chromeLog);socket=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
  await new Promise(r=>socket.addEventListener('open',r,{once:true}));let sequence=0;const pending=new Map(),errors=[];
  socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const task=pending.get(m.id);if(!task)return;clearTimeout(task.timer);pending.delete(m.id);m.error?task.reject(m.error):task.resolve(m.result);}
    else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);};
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('Browser command timed out: '+method));},12000);timer.unref();pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
  async function until(expression){for(let i=0;i<100;i++){if(errors.length)throw Error(errors.join('; '));if(await evaluate(expression))return;await sleep(100);}throw Error('Timed out: '+expression+'; JS errors: '+errors.join('; '));}
  await send('Page.enable');await send('Runtime.enable');await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await send('Page.navigate',{url:base});await until(`!!document.querySelector('#home-results .card')&&!document.querySelector('#refresh').disabled`);
  assert.equal(await evaluate(`document.querySelector('#tab-home').hidden`),false,'Home landing');
  assert.ok(await evaluate(`document.querySelector('#src-ipo').textContent.includes('IPO Watch IPOs')`),'The actual provider is accurately labelled');
  assert.ok(await evaluate(`document.querySelector('#offline-banner').hidden`),'Working data does not show a provider-outage warning');
  const rows=[];
  for(const tab of ['home','performance','ipos','today','ai','gmp','allot','more','corp','market','cal']){
    const visible=tab==='ipos'?'home':tab==='ai'?'today':tab;
    await evaluate(`location.hash=${JSON.stringify(tab)}`);await until(`!document.querySelector('#tab-'+${JSON.stringify(visible)}).hidden`);
    assert.ok(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),'No page overflow in '+tab);
    rows.push(tab);
  }
  await evaluate(`location.hash='today'`);await until(`!document.querySelector('#tab-today').hidden`);
  await evaluate(`Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copied=text;}}});window.open=(url)=>{window.__aiUrl=url;};document.querySelector('#today-actions [data-copy]').click();`);
  await until(`!!window.__copied`);
  assert.ok(await evaluate(`['Retail','sHNI','bHNI','Snapshot timestamps','Browser Check Example'].every(text=>window.__copied.includes(text))`),'Bulk AI brief contains category figures and source dates');
  await evaluate(`const select=document.querySelector('#ai-target');select.value='chatgpt';select.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#today-actions [data-ai]').click();`);
  assert.ok(await evaluate(`window.__aiUrl.startsWith('https://chatgpt.com/')`),'Ask AI uses selected destination');
  await evaluate(`window.__copied='';document.querySelector('#today-list [data-copy]').click()`);await until(`!!window.__copied`);
  assert.ok(await evaluate(`window.__copied.includes('Retail')`),'Individual IPO brief restored');
  for(const width of [320,390,1440]){
    await send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:width<600});
    assert.ok(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),'AI tools fit '+width);
  }
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  const aiShot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'ai-tools.png'),Buffer.from(aiShot.data,'base64'));
  const requestsBeforeReload=dataRequests;
  await send('Page.reload',{ignoreCache:true});await until(`!!document.querySelector('#today-list [data-copy]')&&!document.querySelector('#refresh').disabled`);
  assert.equal(dataRequests,requestsBeforeReload,'Same-day visit uses saved data without fetching');
  const requestsBeforeStale=dataRequests;
  await evaluate(`const saved=JSON.parse(localStorage.getItem('ipotracker.snapshot'));saved.sourceTimes.ipos='2020-01-01T00:00:00Z';localStorage.setItem('ipotracker.snapshot',JSON.stringify(saved));`);
  await send('Page.reload',{ignoreCache:true});
  await until(`document.querySelector('#refresh')?.disabled===false&&document.querySelector('[data-source="ipos"]')?.textContent.includes('current')`);
  assert.ok(dataRequests>requestsBeforeStale,'Stale same-day saved data is revalidated');
  assert.equal(await evaluate(`document.querySelector('#auto')`),null,'No automatic refresh control');
  await evaluate(`location.hash='home'`);await until(`!document.querySelector('#tab-home').hidden`);
  assert.equal(await evaluate(`document.querySelector('#home-watchlist').hidden`),true,'No duplicate watchlist feed');
  await evaluate(`document.querySelector('#home-results [data-research]').click()`);await until(`!!document.querySelector('#modal-research')`);
  assert.ok(await evaluate(`document.querySelector('.ipo-provenance').textContent.includes('IPO Watch')`),'Detail displays the actual IPO source');
  assert.ok(await evaluate(`document.querySelector('#modal-research').textContent.includes('What does the company do?')`));
  assert.equal(await evaluate(`document.querySelector('.advanced-research').open`),false,'Advanced figures stay folded');
  const researchShot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'research-brief.png'),Buffer.from(researchShot.data,'base64'));
  await evaluate(`document.querySelector('[data-decision="Shortlist"]').click();const note=document.querySelector('#research-note');note.value='Check cash flow before deciding';note.dispatchEvent(new Event('input',{bubbles:true}));`);
  assert.ok(await evaluate(`Object.values(JSON.parse(localStorage.getItem('ipotracker.decisions'))).some(d=>d.status==='Shortlist'&&d.note.includes('cash flow'))`),'Research decision and note persisted');
  if(await evaluate(`!!document.querySelector('#scenario-return')`)){
    await evaluate(`const slider=document.querySelector('#scenario-return');slider.value='-20';slider.dispatchEvent(new Event('input'));`);
    assert.ok(await evaluate(`document.querySelector('#scenario-result').textContent.includes('-')`),'Downside scenario');
  }
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});await until(`!document.querySelector('.modal-backdrop')`);
  await evaluate(`location.hash='performance'`);await until(`!document.querySelector('#tab-performance').hidden`);
  assert.ok(await evaluate(`document.querySelector('#performance-summary').textContent.includes('With a market quote')`));
  assert.ok(await evaluate(`document.querySelector('#performance-list').textContent.includes('Latest recorded')`));
  const performanceShot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'after-listing.png'),Buffer.from(performanceShot.data,'base64'));
  await evaluate(`location.hash='home'`);await until(`!document.querySelector('#tab-home').hidden`);
  await evaluate(`document.querySelector('#home-results [data-watch]').click()`);
  assert.ok(await evaluate(`JSON.parse(localStorage.getItem('ipotracker.watch')).length===1`),'Watchlist persisted');
  await evaluate(`document.querySelector('#home-results [data-compare]').click()`);await until(`!document.querySelector('#tab-home').hidden`);
  assert.ok(await evaluate(`document.querySelector('#home-comparison').textContent.includes('Minimum entry')`));
  await evaluate(`document.querySelector('#home-results [data-track]').click()`);await until(`!document.querySelector('#tab-allot').hidden`);
  await evaluate(`const select=document.querySelector('[data-application-stage]');select.value='Mandate approved';select.dispatchEvent(new Event('change',{bubbles:true}));`);
  assert.ok(await evaluate(`Object.values(JSON.parse(localStorage.getItem('ipotracker.applications')))[0].stage==='Mandate approved'`));
  await evaluate(`document.querySelector('#pan-value').value='ABCDE1234F';document.querySelector('#pan-label').value='Test';document.querySelector('#pan-add').click()`);
  assert.ok(await evaluate(`!document.querySelector('#pan-list').textContent.includes('ABCDE1234F')`),'ID masked');
  assert.equal(await evaluate(`localStorage.getItem('ipotracker.ids')`),null,'ID persistence opt-in');
  await evaluate(`document.querySelector('#remember-ids').checked=true;document.querySelector('#remember-ids').dispatchEvent(new Event('change'))`);
  assert.ok(await evaluate(`localStorage.getItem('ipotracker.ids').includes('ABCDE1234F')`));
  await evaluate(`window.confirm=()=>true;document.querySelector('#delete-ids').click()`);
  assert.equal(await evaluate(`localStorage.getItem('ipotracker.ids')`),null);
  await evaluate(`location.hash='home'`);await until(`!document.querySelector('#tab-home').hidden`);
  const downloads=path.join(out,'downloads-'+Date.now());fs.mkdirSync(downloads);await send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
  await evaluate(`document.querySelector('#home-results [data-calendar]').click()`);await until(`document.querySelector('#home-results [data-calendar]')!==null`);
  for(let i=0;i<100&&!fs.readdirSync(downloads).some(f=>f.endsWith('.ics'));i++)await sleep(100);
  assert.deepEqual(errors,[]);
  assert.ok(fs.readdirSync(downloads).some(f=>f.endsWith('.ics')),'Real calendar download; toast: '+await evaluate(`document.querySelector('#toast').textContent`));
  for(const width of [320,390,1440]){
    await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});
    assert.ok(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),'Home fits '+width);
    const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'home-'+width+'.png'),Buffer.from(shot.data,'base64'));
  }
  const savedBeforeOutage=await evaluate(`JSON.parse(localStorage.getItem('ipotracker.snapshot'))`);
  optionalFailed=true;await evaluate(`document.querySelector('#refresh').click()`);
  await until(`document.querySelector('#refresh')?.disabled===false`);
  const afterOptional=await evaluate(`JSON.parse(localStorage.getItem('ipotracker.snapshot'))`);
  for(const key of ['fundamentals','reports','history','corporate','market'])assert.deepEqual(afterOptional[key],savedBeforeOutage[key],'Optional failure preserves '+key);
  outage=true;await evaluate(`document.querySelector('#refresh').click()`);
  await until(`document.querySelector('#refresh')?.disabled===false&&document.querySelector('[data-source="ipos"]')?.textContent.includes('failed')`);
  const afterOutage=await evaluate(`JSON.parse(localStorage.getItem('ipotracker.snapshot'))`);
  assert.deepEqual(afterOutage.ipos,afterOptional.ipos,'Total outage preserves IPO records');
  assert.deepEqual(afterOutage.sourceTimes,afterOptional.sourceTimes,'Total outage never advances source timestamps');
  assert.ok(await evaluate(`!!document.querySelector('#home-results .card')`),'Saved cards remain usable during outage');
  outage=false;invalidCore=true;await evaluate(`document.querySelector('#refresh').click()`);
  await until(`document.querySelector('#refresh')?.disabled===false`);
  assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem('ipotracker.snapshot')).ipos`),afterOptional.ipos,'Malformed payload cannot replace saved data');
  invalidCore=false;optionalFailed=false;await evaluate(`document.querySelector('#refresh').click()`);
  await until(`document.querySelector('#refresh')?.disabled===false&&document.querySelector('[data-source="ipos"]')?.textContent.includes('current')`);
  const beforeOlder=await evaluate(`JSON.parse(localStorage.getItem('ipotracker.snapshot'))`);
  stale=true;await evaluate(`document.querySelector('#refresh').click()`);
  await until(`document.querySelector('#refresh')?.disabled===false&&document.querySelector('[data-source="gmp"]')?.textContent.includes('failed')`);
  assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem('ipotracker.snapshot')).sourceTimes.gmp`),beforeOlder.sourceTimes.gmp,'Older publication cannot overwrite a newer saved observation');
  await evaluate(`const older=JSON.parse(localStorage.getItem('ipotracker.snapshot'));older.sourceTimes.gmp='2020-01-01T00:00:00Z';localStorage.setItem('ipotracker.snapshot',JSON.stringify(older));localStorage.setItem('ipotracker.refreshDay',JSON.stringify('2000-01-01'));`);
  await send('Page.reload',{ignoreCache:true});await until(`document.querySelector('#refresh')?.disabled===false&&document.querySelector('#data-health')?.textContent.includes('stale')`);
  assert.ok(dataRequests>requestsBeforeReload,'First visit on a different day fetches new data');
  assert.ok(await evaluate(`document.querySelector('#offline-banner').textContent.includes('last reported')`),'One calm message explains dated figures');
  assert.equal(await evaluate(`document.querySelector('#offline-banner').hidden`),false);
  assert.ok(await evaluate(`!document.querySelector('#home-results').textContent.includes('implied gain')`),'Older GMP is not presented as a current implied gain');
  await evaluate(`location.hash='today';document.querySelector('[data-todayboard="Mainboard"]').click()`);
  await until(`!document.querySelector('#tab-today').hidden&&!!document.querySelector('#today-compare .quote-value')`);
  assert.ok(await evaluate(`document.querySelector('#today-compare').textContent.includes('₹10')&&document.querySelector('#today-compare').textContent.includes('Reported')`),'Dated GMP remains visible in the exact AI tools comparison view');
  assert.ok(await evaluate(`!document.querySelector('#statusbar').open&&!document.querySelector('#tab-today').textContent.includes('use Refresh')`),'Diagnostics stay collapsed and the view does not ask visitors to refresh');
  for(const width of [390,1440]){
    await send('Emulation.setDeviceMetricsOverride',{width,height:960,deviceScaleFactor:1,mobile:width<600});
    assert.ok(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),'Dated comparison fits '+width);
    const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'ai-tools-delayed-'+width+'.png'),Buffer.from(shot.data,'base64'));
  }
  await evaluate(`location.hash='home'`);
  assert.ok(await evaluate(`JSON.parse(localStorage.getItem('ipotracker.watch')).length===1`),'Watchlist survives reload');
  assert.ok(await evaluate(`Object.values(JSON.parse(localStorage.getItem('ipotracker.decisions'))).some(d=>d.note==='Check cash flow before deciding')`),'Research notebook survives reload');
  const ipo=JSON.parse(fs.readFileSync(path.join(root,'data/ipos.json'),'utf8')).ipos;
  for(const board of ['Mainboard','SME']){const row=ipo.find(r=>(r.board||(r.series==='SME'?'SME':'Mainboard'))===board&&r.info?.lotSize);if(!row)continue;
    const key=require('../js/core').nameKey(row.company);await evaluate(`location.hash='ipo='+${JSON.stringify(key)}`);await until(`!!document.querySelector('.modal-backdrop')`);
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});await until(`!document.querySelector('.modal-backdrop')`);}
  stale=false;live=true;await evaluate(`localStorage.removeItem('ipotracker.refreshDay')`);await send('Page.reload',{ignoreCache:true});
  await until(`document.querySelector('#refresh')?.disabled===false&&document.querySelector('[data-source="gmp"]')?.textContent.includes('current')`);
  await evaluate(`location.hash='ipo=browsercheckexample'`);await until(`!!document.querySelector('#modal-research')`);
  for(const width of [390,1440]){
    await send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:width<600});
    await evaluate(`document.querySelector('.advanced-research').open=true;document.querySelector('.modal-body').scrollTop=0`);
    const before=await evaluate(`({top:document.querySelector('.modal-head').getBoundingClientRect().top,page:scrollY})`);
    await send('Input.dispatchMouseEvent',{type:'mouseWheel',x:Math.min(width/2,600),y:500,deltaX:0,deltaY:550});
    await until(`document.querySelector('.modal-body').scrollTop>100`);
    assert.ok(await evaluate(`getComputedStyle(document.querySelector('.advanced-grid')).overflowY==='visible'`),'Advanced figures do not trap scrolling');
    assert.deepEqual(await evaluate(`({top:document.querySelector('.modal-head').getBoundingClientRect().top,page:scrollY})`),before,'Header stays visible and background stays still');
    assert.ok(await evaluate(`document.querySelector('.modal').getBoundingClientRect().bottom<=innerHeight+1`),'Dialog fits viewport');
  }
  await evaluate(`const range=document.querySelector('#scenario-return');range.value='-20';range.dispatchEvent(new Event('input'));const note=document.querySelector('#research-note');note.focus();note.setSelectionRange(4,9);document.querySelector('.modal-body').scrollTop=200;`);
  apiVersion=25;
  await evaluate(`document.querySelector('[data-detail-refresh]').click()`);
  await until(`!document.querySelector('#refresh').disabled&&document.querySelector('#modal-research').textContent.includes('₹25')`);
  assert.equal(forceRequests,4,'Daily load and manual detail refresh bypass both API caches');
  assert.equal(await evaluate(`document.querySelector('.modal-body').scrollTop`),200,'Refresh preserves reading position');
  assert.ok(await evaluate(`document.querySelector('.advanced-research').open`),'Refresh preserves expanded figures');
  assert.equal(await evaluate(`document.querySelector('#scenario-return').value`),'-20','Refresh preserves scenario');
  assert.ok(await evaluate(`document.activeElement.id==='research-note'&&document.activeElement.selectionStart===4&&document.activeElement.selectionEnd===9`),'Refresh preserves note focus and selection');
  sourceFailed=true;await evaluate(`document.querySelector('[data-detail-refresh]').click()`);
  await until(`!document.querySelector('#refresh').disabled&&document.querySelector('[data-source="gmp"]').textContent.includes('failed')`);
  assert.ok(await evaluate(`!document.querySelector('#offline-banner').hidden`),'Fallback source errors are visible');
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});await until(`!document.querySelector('.modal-backdrop')`);
  live=false;sourceFailed=false;
  await evaluate(`location.hash='home';localStorage.setItem('ipotracker.compare','{}');localStorage.setItem('ipotracker.ids','{}');localStorage.setItem('ipotracker.applications',JSON.stringify({broken:null}));const notes=JSON.parse(localStorage.getItem('ipotracker.decisions'));notes.broken=null;localStorage.setItem('ipotracker.decisions',JSON.stringify(notes));localStorage.removeItem('ipotracker.refreshDay');`);
  // Simulate Safari versions without the newer static timeout helper.
  const compatibility=await send('Page.addScriptToEvaluateOnNewDocument',{source:'AbortSignal.timeout=undefined;'});
  await send('Page.reload',{ignoreCache:true});
  await until(`document.querySelector('#refresh')?.disabled===false&&!!document.querySelector('#home-results .card')`);
  assert.ok(await evaluate(`document.querySelector('#startup-recovery').hidden`),'Corrupt settings and missing AbortSignal.timeout do not stop startup');
  const workerStatus=await evaluate(`navigator.serviceWorker.register('sw.js',{updateViaCache:'none'}).then(r=>({scope:r.scope,active:r.active?.state,waiting:r.waiting?.state,installing:r.installing?.state,secure:isSecureContext})).catch(e=>({error:e.message,secure:isSecureContext}))`);
  assert.ok(!workerStatus.error,'Offline worker registers: '+JSON.stringify(workerStatus));
  // A browser hard reload deliberately bypasses service workers. Start a
  // normal visit before testing the installed worker's offline navigation.
  await send('Page.reload');
  await until(`document.querySelector('#refresh')?.disabled===false&&!!document.querySelector('#home-results .card')`);
  try{await until(`!!navigator.serviceWorker.controller`);}catch(error){throw Error(error.message+'; worker '+JSON.stringify(workerStatus)+'; cache '+JSON.stringify(await evaluate(`caches.keys()`)));}
  await send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:-1,uploadThroughput:-1});
  await send('Page.reload');
  await until(`document.querySelector('#refresh')?.disabled===false&&!!document.querySelector('#home-results .card')`);
  assert.ok(await evaluate(`document.querySelector('#startup-recovery').hidden`),'A fully offline revisit opens the cached release and saved IPOs');
  assert.ok(await evaluate(`document.querySelector('#stunityCredit').textContent.includes('Prateek')`),'Offline release preserves studio credit');
  await send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
  await send('Page.removeScriptToEvaluateOnNewDocument',{identifier:compatibility.identifier});
  await evaluate(`navigator.serviceWorker.getRegistrations().then(list=>Promise.all(list.map(r=>r.unregister())))`);
  assetFailed=true;await send('Page.reload',{ignoreCache:true});
  await until(`document.querySelector('#startup-recovery')?.hidden===false`);
  assert.ok(await evaluate(`document.querySelector('#startup-retry').href.includes('reload=')`),'Missing app script shows a usable reload link');
  assetFailed=false;
  outage=true;await evaluate(`location.hash='home';localStorage.removeItem('ipotracker.snapshot');localStorage.removeItem('ipotracker.refreshDay')`);
  await send('Page.reload',{ignoreCache:true});
  await until(`document.querySelector('#refresh')?.disabled===false&&document.querySelector('#home-results')?.textContent.includes('temporarily unavailable')`);
  assert.ok(await evaluate(`Object.values(JSON.parse(localStorage.getItem('ipotracker.decisions'))).some(d=>d.note==='Check cash flow before deciding')`),'Cold-start outage preserves personal notes');
  assert.deepEqual(errors,[]);console.log('PASS: '+rows.length+' views, saved-data and malformed-response recovery, dated GMP visible in AI tools on mobile/desktop, quiet source status, older-publication protection, corrupt settings, older-browser support, offline page reload, missing-script recovery, optional and total outages, cold-start recovery, notes, watchlist, comparison, applications, masked IDs and calendar download.');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{clearTimeout(watchdog);socket?.close();chrome?.kill();server.close();server.closeAllConnections();});
