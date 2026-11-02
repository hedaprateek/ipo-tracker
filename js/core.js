(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.IpoCore=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  function nameKey(value){return String(value||'').toLowerCase().replace(/&amp;/g,'&')
    .replace(/\s*\([oucl]\)\s*$/i,'').replace(/\b(open|closed|upcoming|listed)\s*$/i,'')
    .replace(/\b(limited|ltd|private|pvt|india|indian|the|company|co)\b/g,'').replace(/[^a-z0-9]/g,'');}
  function matchIssue(quote,issues){
    const key=nameKey(quote.name||quote.company),board=quote.board;
    if(!key)return null;
    const available=issues.filter(r=>!board||!r.board||board===r.board);
    const exact=available.filter(r=>nameKey(r.company||r.name)===key);
    if(exact.length)return exact.length===1?exact[0]:null;
    const candidates=available.filter(r=>{const other=nameKey(r.company||r.name);
      return Math.min(other.length,key.length)>=8&&(other.startsWith(key)||key.startsWith(other));});
    return candidates.length===1?candidates[0]:null;
  }
  function freshness(stamp,now=Date.now(),maxAge=2*3600000){
    const age=now-Date.parse(stamp);return !Number.isFinite(age)||age< -300000?'unknown':age>maxAge?'stale':'current';
  }
  function marketDate(value=new Date()){
    const parts=new Intl.DateTimeFormat('en',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(value);
    const get=key=>parts.find(p=>p.type===key).value;return get('year')+'-'+get('month')+'-'+get('day');
  }
  function categories(row){
    const prices=String(row.priceBand||row.info?.priceBand||row.price||'').replace(/,/g,'').match(/\d+(?:\.\d+)?/g);
    const cap=prices?Number(prices[prices.length-1]):0,lot=Number(row.info?.lotSize),perLot=cap*lot;
    if(!(Number.isFinite(cap)&&cap>0&&Number.isSafeInteger(lot)&&lot>0))return [];
    const sme=row.board==='SME';
    if(sme&&perLot*2<=200000)return [];
    const definitions=sme?[
      {key:'individual',label:'Individual · minimum 2 lots',lots:2},
      {key:'shni',label:'NII · above minimum to ₹10L',lots:Math.max(3,Math.floor(200000/perLot)+1)},
      {key:'bhni',label:'bHNI (above ₹10L)',lots:Math.max(3,Math.floor(1000000/perLot)+1)}
    ]:[{key:'retail',label:'Retail',lots:1},{key:'shni',label:'sHNI (above ₹2L–₹10L)',lots:Math.floor(200000/perLot)+1},
      {key:'bhni',label:'bHNI (above ₹10L)',lots:Math.floor(1000000/perLot)+1}];
    return definitions.filter(o=>o.key!=='retail'||perLot<=200000).filter(o=>o.key!=='shni'||o.lots*perLot<=1000000).map(o=>{
      const sub=(row.categories||[]).find(c=>c.key===o.key||(sme&&o.key==='individual'&&c.key==='retail'));
      return {...o,amount:o.lots*perLot,times:sub?.times??null,applications:sub?.applications??null};
    });
  }
  function calendar(title,events,now=new Date()){
    const escape=v=>String(v||'').replace(/\\/g,'\\\\').replace(/\r?\n/g,'\\n').replace(/,/g,'\\,').replace(/;/g,'\\;');
    const date=v=>String(v).replace(/-/g,'');
    const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Stunity Tech//IPO Tracker//EN','CALSCALE:GREGORIAN'];
    events.filter(e=>/^\d{4}-\d{2}-\d{2}$/.test(e.date)).forEach(e=>{
      const next=new Date(e.date+'T00:00:00Z');next.setUTCDate(next.getUTCDate()+1);
      lines.push('BEGIN:VEVENT','UID:'+escape((e.key||nameKey(title))+'-'+e.kind+'-'+e.date)+'@ipo-tracker',
        'DTSTAMP:'+now.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,''),
        'DTSTART;VALUE=DATE:'+date(e.date),'DTEND;VALUE=DATE:'+date(next.toISOString().slice(0,10)),
        'SUMMARY:'+escape(e.label||title),'DESCRIPTION:Expected dates may change. Verify with the issuer or registrar.','END:VEVENT');
    });lines.push('END:VCALENDAR');
    // Fold by UTF-8 bytes, preserving whole code points and CRLF continuations.
    return lines.map(line=>{let parts=[],part='',size=0;for(const c of line){const n=new TextEncoder().encode(c).length;
      if(size+n>75){parts.push(part);part=' ';size=1;}part+=c;size+=n;}parts.push(part);return parts.join('\r\n');}).join('\r\n')+'\r\n';
  }
  function performance(row){
    const q=row.listing||{},number=v=>typeof v==='number'&&Number.isFinite(v)&&v>0?v:null;
    const prices=String(row.priceBand||'').replace(/,/g,'').match(/\d+(?:\.\d+)?/g);
    const issue=number(q.issuePrice)||(prices?number(Number(prices[prices.length-1])):null),latest=number(q.cmp);
    const open=q.quoteSchema===2?number(q.listingOpen):null;
    const close=number(q.listingClose)||(q.quoteSchema!==2?number(q.listPrice):null);
    const blocked=!!q.hasCorporateActions,percent=value=>!blocked&&issue&&value?((value-issue)/issue)*100:null;
    const entry=categories(row)[0],shares=entry&&row.info?.lotSize?entry.lots*row.info.lotSize:null;
    return {issue,latest,open,close,openingGain:percent(open),closingGain:percent(close),totalReturn:percent(latest),
      retained:!blocked&&open&&latest?(latest/open-1)*100:null,
      shares,cost:!blocked&&shares&&issue?shares*issue:null,value:!blocked&&shares&&latest?shares*latest:null,
      profit:!blocked&&shares&&issue&&latest?shares*(latest-issue):null,blocked,asOf:q.quoteAsOf||q.asOf||null,
      quoteStatus:freshness(q.quoteAsOf||q.asOf,Date.now(),48*3600000)};
  }
  function research(row,fund={}){
    const annual=(fund.financials||[]).filter(p=>/^(?:FY\s*)?20\d{2}$/i.test(String(p.period))).slice().sort((a,b)=>String(a.period).localeCompare(String(b.period)));
    const last=annual.at(-1),previous=annual.at(-2),kpi=fund.kpis||{},facts=[],questions=[];
    const valid=v=>typeof v==='number'&&Number.isFinite(v);
    if(last&&valid(last.pat)){
      facts.push({kind:last.pat>=0?'positive':'caution',title:last.pat>=0?'Reported profit':'Reported loss',detail:'₹'+last.pat+' crore PAT · '+last.period});
      if(last.pat<0)questions.push('What would need to change for the business to become profitable?');
      if(last.spentMore&&last.pat>=0)questions.push('Reported expenses exceed revenue while PAT is positive. Check other income, exceptional items and the original statement before interpreting profit quality.');
    }else questions.push('Check full-year profit figures in the offer documents.');
    const recent=(fund.financials||[]).at(-1);
    if(recent&&recent!==last&&valid(recent.pat)){
      facts.push({kind:recent.pat<0?'caution':'neutral',title:recent.pat<0?'Interim loss reported':'Interim profit reported',detail:'₹'+recent.pat+' crore PAT · '+recent.period+' · not a full-year comparison'});
      if(recent.pat<0)questions.push('What explains the latest interim loss? Check whether it is seasonal or driven by one-off items.');
    }
    const consecutive=last&&previous&&Number(String(last.period).match(/\d{4}/)?.[0])-Number(String(previous.period).match(/\d{4}/)?.[0])===1;
    if(consecutive&&valid(last.revenue)&&valid(previous.revenue)&&previous.revenue>0){
      const growth=(last.revenue/previous.revenue-1)*100;
      facts.push({kind:growth>=0?'positive':'caution',title:growth>=0?'Revenue grew':'Revenue declined',detail:growth.toFixed(1)+'% · '+previous.period+' → '+last.period});
      if(growth<0)questions.push('What explains the revenue decline, and is it temporary?');
    }else questions.push('Comparable consecutive full-year revenue figures are missing; do not compare an interim period with a full year.');
    if(valid(kpi.debtEquity))facts.push({kind:kpi.debtEquity>1?'caution':'neutral',title:'Debt / equity',detail:kpi.debtEquity.toFixed(2)+'× · a leverage measure, not a credit rating'});
    else questions.push('Check debt, cash generation and repayment commitments.');
    const prices=String(row.priceBand||row.price||'').replace(/,/g,'').match(/\d+(?:\.\d+)?/g),cap=prices?Number(prices.at(-1)):null;
    const pe=valid(kpi.pe)&&kpi.pe>0?kpi.pe:cap&&valid(kpi.eps)&&kpi.eps>0?cap/kpi.eps:null;
    if(pe)facts.push({kind:'neutral',title:valid(kpi.pe)&&kpi.pe>0?'Reported P/E':'Cap price ÷ reported EPS',detail:pe.toFixed(1)+'× · check earnings period and dilution; not a forward P/E'});
    else questions.push('A reliable positive earnings multiple is unavailable; inspect the valuation basis.');
    const uses=(fund.objects||[]).filter(o=>o.purpose&&o.purpose.trim()!=='-');
    const groups=[!!fund.about,!!last,Object.keys(kpi).some(key=>valid(kpi[key])),uses.length>0];
    questions.push('Read business risks, customer concentration, fresh issue versus offer-for-sale and use of proceeds.');
    return {about:fund.about||null,facts,questions,uses,coverage:groups.filter(Boolean).length,pe,period:last?.period||null};
  }
  return {nameKey,matchIssue,freshness,marketDate,categories,calendar,performance,research};
});
