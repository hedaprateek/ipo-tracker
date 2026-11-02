const fs=require('fs'),path=require('path'),Core=require('../js/core');
let failed=false;const lines=['## Source freshness'];
for(const [key,file] of [['IPO bids','ipos.json'],['GMP','gmp.json']]){
  let data={};try{data=JSON.parse(fs.readFileSync(path.join(__dirname,'../data',file),'utf8'));}catch{}
  const status=Core.freshness(data.fetchedAt);lines.push(`- ${key}: ${status}; last success ${data.fetchedAt||'unknown'}`);
  if(status!=='current'){console.error(`::warning::${key} data is ${status}; partial data has been preserved`);failed=true;}
}
console.log(lines.join('\n'));if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,lines.join('\n')+'\n');
if(failed)process.exitCode=1;
