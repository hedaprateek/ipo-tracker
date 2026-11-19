const Core=require('../js/core');
const {read}=require('../lib/request');
const {Script}=require('node:vm');

async function checkPublished({base='https://hedaprateek.github.io/ipo-tracker/',now=Date.now(),load}={}){
  const origin=new URL(base);
  if(!['https:','http:'].includes(origin.protocol))throw Error('Expected an HTTP website URL');
  const get=load||((file,format='json')=>{
    const url=new URL(file,origin);url.searchParams.set('healthcheck',String(now));
    return read(url.href,{format,timeout:8000});
  });
  const [html,css,app,core,charts,ipos,gmp,health]=await Promise.all([
    get('','text'),get('styles.css','text'),get('js/app.js','text'),get('js/core.js','text'),get('js/charts.js','text'),
    get('data/ipos.json'),get('data/gmp.json'),get('data/source-health.json'),
  ]);
  if(!/id=["']home-results["']/.test(html)||!html.includes('stunityCredit'))throw Error('Published HTML is not the IPO Tracker');
  if(!css.trim()||/<html|<!doctype/i.test(css))throw Error('Stylesheet is unavailable');
  for(const [file,source] of [['app.js',app],['core.js',core],['charts.js',charts]]){
    if(!source.trim())throw Error('Empty published script: '+file);
    new Script(source,{filename:file}); // Compile without executing remote code.
  }
  const warnings=[],sources={};
  if(!Core.isRecord(health?.sources)||['ipos','gmp'].some(key=>!['ok','failed'].includes(health.sources[key]?.status)))throw Error('Published source-health report is malformed');
  for(const [key,data] of [['ipos',ipos],['gmp',gmp]]){
    if(!Core.validSnapshot(key,data))throw Error(`Published ${key} snapshot is malformed or empty`);
    const status=Core.freshness(data.fetchedAt,now),age=now-Date.parse(data.fetchedAt);
    if(status==='unknown'||age>6*3600000)throw Error(`Published ${key} data is critically stale: ${data.fetchedAt}`);
    const source=health?.sources?.[key];
    sources[key]={status,updated:data.fetchedAt,provider:data.provider||source?.provider||'unknown',records:data[key].length};
    if(status!=='current')warnings.push(`${key} data is stale; saved figures remain available`);
    if(source?.status==='failed')warnings.push(`${key} refresh failed; saved figures remain available`);
    if(source?.componentError)warnings.push(`${key} category feed: ${source.componentError}`);
  }
  return {url:base,sources,warnings};
}

if(require.main===module){
  (async()=>{
    let last;
    for(let attempt=0;attempt<4;attempt++){
      try{
        const result=await checkPublished({base:process.env.IPO_SITE_URL||undefined});
        console.log(JSON.stringify(result,null,2));
        for(const warning of result.warnings)console.warn('::warning::'+String(warning).replace(/[\r\n]/g,' '));
        if(process.env.GITHUB_STEP_SUMMARY)require('node:fs').appendFileSync(process.env.GITHUB_STEP_SUMMARY,
          '## Public website check\n'+JSON.stringify(result,null,2)+'\n');
        return;
      }catch(error){last=error;if(attempt<3)await new Promise(resolve=>setTimeout(resolve,2000));}
    }
    console.error(last.message);process.exitCode=1;
  })();
}
module.exports={checkPublished};
