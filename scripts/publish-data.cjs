const {spawnSync}=require('node:child_process');
const path=require('node:path');
const FILES={
  core:['data/ipos.json','data/gmp.json','data/gmp-history.json','data/source-health.json'],
  extras:['data/fundamentals.json','data/corporate.json','data/reports.json','data/gmp-history.json'],
  market:['data/market.json'],
};

function publish({cwd=path.resolve(__dirname,'..'),mode='core',attempts=3,beforePush=()=>{}}={}){
  if(!FILES[mode])throw Error('Unknown data publication mode');
  const git=(args,allowFailure=false)=>{
    const result=spawnSync('git',args,{cwd,encoding:'utf8',windowsHide:true,timeout:60000,
      env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_AUTHOR_NAME:'github-actions[bot]',GIT_COMMITTER_NAME:'github-actions[bot]',
        GIT_AUTHOR_EMAIL:'41898282+github-actions[bot]@users.noreply.github.com',GIT_COMMITTER_EMAIL:'41898282+github-actions[bot]@users.noreply.github.com'}});
    if(result.error)throw result.error;
    if(result.status!==0&&!allowFailure)throw Error(`git ${args[0]} failed: ${result.stderr||result.stdout}`);
    return result;
  };
  const staged=git(['diff','--cached','--name-only']).stdout.trim().split(/\r?\n/).filter(Boolean);
  if(staged.some(file=>!FILES[mode].includes(file)))throw Error('Unrelated staged changes; publication stopped');
  git(['add','--',...FILES[mode]]);
  if(git(['diff','--staged','--quiet'],true).status===0)return {changed:false};
  git(['commit','-m',`data: ${mode} refresh ${new Date().toISOString()}`]);
  for(let attempt=1;attempt<=attempts;attempt++){
    git(['pull','--rebase','origin','main']);
    beforePush(attempt);
    if(git(['push','origin','HEAD:main'],true).status===0)return {changed:true,attempts:attempt};
  }
  throw Error('Data push rejected after bounded retries; remote data was not overwritten');
}
if(require.main===module){try{console.log(JSON.stringify(publish({mode:process.argv[2]||'core'})));}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={publish};
