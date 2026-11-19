'use strict';
const fs=require('node:fs'),path=require('node:path');

function writeJson(file,value,{io=fs}={}){
  const text=JSON.stringify(value); // Validate serialization before touching disk.
  const temporary=file+'.'+process.pid+'.tmp';
  io.mkdirSync(path.dirname(file),{recursive:true});
  try{
    io.writeFileSync(temporary,text,'utf8');
    io.renameSync(temporary,file);
  }finally{
    try{io.unlinkSync(temporary);}catch{}
  }
}
module.exports={writeJson};
