const Core=require('../js/core');
const {read}=require('../lib/request');
const {Script}=require('node:vm');
const {createHash}=require('node:crypto');

async function checkPublished({base='https://hedaprateek.github.io/ipo-tracker/',now=Date.now(),load}={}){
  const origin=new URL(base);
  if(!['https:','http:'].includes(origin.protocol))throw Error('Expected an HTTP website URL');
  const get=load||((file,format='json')=>{
    const url=new URL(file,origin);url.searchParams.set('healthcheck',String(now));
    return read(url.href,{format,timeout:8000});
  });
  const live=key=>(load?get('live/'+key):read(Core.DATA_API+'/api/'+key,{timeout:10000})).catch(()=>null);
  const liveJobs=Promise.all([live('ipos'),live('gmp')]);
  const [html,css,app,core,charts,worker,ipos,gmp,health]=await Promise.all([
    get('','text'),get('styles.css','text'),get('js/app.js','text'),get('js/core.js','text'),get('js/charts.js','text'),
    get('sw.js','text'),
    get('data/ipos.json'),get('data/gmp.json'),get('data/source-health.json'),
  ]);
  if(!/id=["']home-results["']/.test(html)||!html.includes('stunityCredit'))throw Error('Published HTML is not the IPO Tracker');
  if(!css.trim()||/<html|<!doctype/i.test(css))throw Error('Stylesheet is unavailable');
  for(const [file,source] of [['app.js',app],['core.js',core],['charts.js',charts],['sw.js',worker]]){
    if(!source.trim())throw Error('Empty published script: '+file);
    new Script(source,{filename:file}); // Compile without executing remote code.
  }
  for(const [file,source] of [['styles.css',css],['js/app.js',app],['js/core.js',core],['js/charts.js',charts]]){
    const reference=html.match(new RegExp(file.replace(/\./g,'\\.')+'\\?v=([a-f0-9]+)'));
    if(!reference||reference[1]!==createHash('sha256').update(source).digest('hex').slice(0,12))throw Error('Published asset version mismatch: '+file);
  }
  const warnings=[],sources={};
  const [liveIpos,liveGmp]=await liveJobs;
  let backupNeedsRefresh=false;
  if(!Core.isRecord(health?.sources)||['ipos','gmp'].some(key=>!['ok','failed'].includes(health.sources[key]?.status)))throw Error('Published source-health report is malformed');
  for(const [key,backup,fresh] of [['ipos',ipos,liveIpos],['gmp',gmp,liveGmp]]){
    if(!Core.validSnapshot(key,backup))throw Error(`Published ${key} snapshot is malformed or empty`);
    if(Core.freshness(backup.fetchedAt,now)!=='current')backupNeedsRefresh=true;
    const data=Core.validSnapshot(key,fresh)&&Date.parse(fresh.fetchedAt)>=Date.parse(backup.fetchedAt)?fresh:backup;
    const status=Core.freshness(data.fetchedAt,now),age=now-Date.parse(data.fetchedAt);
    if(status==='unknown'||age>6*3600000){
      const error=Error(`Published ${key} data is critically stale: ${data.fetchedAt}`);error.refreshNeeded=true;throw error;
    }
    const source=health?.sources?.[key];
    sources[key]={status,updated:data.fetchedAt,provider:data.provider||source?.provider||'unknown',records:data[key].length,delivery:data===fresh?'on-demand':'published backup'};
    if(status!=='current')warnings.push(`${key} data is stale; saved figures remain available`);
    if(data.sourceError||data===backup&&source?.status==='failed')warnings.push(`${key} refresh failed; saved figures remain available`);
    if(data===backup&&source?.componentError)warnings.push(`${key} category feed: ${source.componentError}`);
  }
  return {url:base,sources,warnings,refreshNeeded:backupNeedsRefresh||Object.values(sources).some(source=>source.status!=='current')};
}

if(require.main===module){
  (async()=>{
    let last;
    for(let attempt=0;attempt<4;attempt++){
      try{
        const result=await checkPublished({base:process.env.IPO_SITE_URL||undefined});
        if(process.env.GITHUB_OUTPUT)require('node:fs').appendFileSync(process.env.GITHUB_OUTPUT,'refresh_needed='+result.refreshNeeded+'\n');
        console.log(JSON.stringify(result,null,2));
        for(const warning of result.warnings)console.warn('::warning::'+String(warning).replace(/[\r\n]/g,' '));
        if(process.env.GITHUB_STEP_SUMMARY)require('node:fs').appendFileSync(process.env.GITHUB_STEP_SUMMARY,
          '## Public website check\n'+JSON.stringify(result,null,2)+'\n');
        return;
      }catch(error){last=error;if(attempt<3)await new Promise(resolve=>setTimeout(resolve,2000));}
    }
    if(process.env.GITHUB_OUTPUT)require('node:fs').appendFileSync(process.env.GITHUB_OUTPUT,'refresh_needed='+!!last.refreshNeeded+'\n');
    console.error(last.message);process.exitCode=1;
  })();
}
module.exports={checkPublished};
