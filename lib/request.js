'use strict';

// One bounded retry for transport errors, rate limiting and server outages.
// Invalid JSON and permanent HTTP errors fail promptly so saved data can win.
async function read(url,{headers={},format='json',timeout=12000,attempts=2,
  fetchImpl=globalThis.fetch,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
  for(let attempt=0;attempt<attempts;attempt++){
    try{
      const response=await fetchImpl(url,{headers,signal:AbortSignal.timeout(timeout),cache:'no-store'});
      if(!response.ok){const error=Error(`HTTP ${response.status}`);error.status=response.status;throw error;}
      return await response[format]();
    }catch(error){
      const retryable=!(error instanceof SyntaxError)&&(!error.status||error.status===429||error.status>=500);
      if(!retryable||attempt===attempts-1)throw error;
      await sleep(350*(attempt+1));
    }
  }
}
module.exports={read};
