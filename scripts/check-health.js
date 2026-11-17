const fs=require('fs'),path=require('path'),Core=require('../js/core');
let failed=false,current=0;const lines=['## Source freshness'];
for(const [key,file] of [['IPO bids','ipos.json'],['GMP','gmp.json']]){
  let data={};try{data=JSON.parse(fs.readFileSync(path.join(__dirname,'../data',file),'utf8'));}catch{}
  const status=Core.freshness(data.fetchedAt);lines.push(`- ${key}: ${status}; last success ${data.fetchedAt||'unknown'}`);
  if(status==='current')current++;
  else console.error(`::warning::${key} data is ${status}; saved data and its original timestamp have been preserved`);
}
// Publishing a healthy feed alongside saved data is a partial refresh, not a
// deployment failure. The page reads source-health.json to flag the outage.
if(!current)failed=true;
else if(current<2)lines.push('- Partial refresh: one source is unavailable; its saved data remains flagged in the app.');
console.log(lines.join('\n'));if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,lines.join('\n')+'\n');
if(process.env.IPO_FETCH_OUTCOME==='failure'){
  console.error('::error::Source refresh failed; saved data and source health have been preserved');
  failed=true;
}
if(failed)process.exitCode=1;
