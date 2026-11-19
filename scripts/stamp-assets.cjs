const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const ROOT=path.resolve(__dirname,'..');
const ASSETS=['styles.css','js/core.js','js/charts.js','js/app.js'];
function stamp({check=false}={}){
  const file=path.join(ROOT,'index.html'),original=fs.readFileSync(file,'utf8');let html=original;
  for(const asset of ASSETS){
    const hash=createHash('sha256').update(fs.readFileSync(path.join(ROOT,asset))).digest('hex').slice(0,12);
    const pattern=new RegExp('(["\'])'+asset.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?:\\?v=[a-zA-Z0-9-]+)?\\1','g');
    if(!pattern.test(html))throw Error('Missing first-party asset reference: '+asset);
    html=html.replace(pattern,(_,quote)=>quote+asset+'?v='+hash+quote);
  }
  if(check&&html!==original)throw Error('Asset versions are stale. Run npm run build and commit index.html with the changed assets.');
  if(!check&&html!==original)fs.writeFileSync(file,html,'utf8');
  return html;
}
if(require.main===module)stamp({check:process.argv.includes('--check')});
module.exports={stamp};
