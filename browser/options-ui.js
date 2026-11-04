// Options page: tab strip, search, per-tab reset and persistence for the controls that had no storage of their own.
export const OPTION_TABS=[['graphics','Graphics'],['sound','Sound'],['gameplay','Gameplay'],['handling','Handling']];
export const PERSISTED_IDS=['clouds','particles','horizon','scenery','distant','sound','music-volume','camera-distance'];
export const OPTIONS_KEY='racer.options.v1';

export function matchesQuery(text,query){
  const words=String(query||'').toLowerCase().split(/\s+/).filter(Boolean);
  const hay=String(text||'').toLowerCase();
  return words.every(w=>hay.includes(w));
}

const fire=(el,type)=>el.dispatchEvent(new Event(type,{bubbles:true}));
const isCheck=el=>el.type==='checkbox';
const readValue=el=>isCheck(el)?el.checked:el.value;
const writeValue=(el,v)=>{if(isCheck(el))el.checked=Boolean(v);else el.value=String(v);};
const eventFor=el=>el.tagName==='SELECT'||isCheck(el)?'change':'input';

export function loadStored(storage){
  try{const v=JSON.parse(storage.getItem(OPTIONS_KEY));return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}catch{return {};}
}

export function installOptions(root,{storage=globalThis.localStorage,windToggle=()=>globalThis.windTuning?.toggle()}={}){
  const doc=root.ownerDocument;
  const sections=[...root.querySelectorAll('[data-opt-tab]')];
  const defaults=new Map();
  for(const section of sections)for(const el of section.querySelectorAll('input,select'))if(el.id)defaults.set(el.id,readValue(el));
  let tab='graphics';
  const bar=doc.createElement('div');bar.className='opt-tabs';bar.setAttribute('role','tablist');
  const search=doc.createElement('input');search.type='search';search.id='opt-search';search.placeholder='Search options';search.setAttribute('aria-label','Search options');
  const reset=doc.createElement('button');reset.type='button';reset.id='opt-reset';reset.textContent='Reset tab to defaults';
  const empty=doc.createElement('p');empty.id='opt-empty';empty.hidden=true;empty.textContent='No options match.';
  const buttons=new Map();
  for(const [id,label] of OPTION_TABS){
    const b=doc.createElement('button');b.type='button';b.role='tab';b.textContent=label;b.dataset.optTab=id;
    b.addEventListener('click',()=>{search.value='';select(id);});
    bar.append(b);buttons.set(id,b);
  }
  root.prepend(bar,search,empty);
  root.append(reset);

  const save=()=>{
    const out={};for(const id of PERSISTED_IDS){const el=doc.getElementById(id);if(el)out[id]=readValue(el);}
    try{storage.setItem(OPTIONS_KEY,JSON.stringify(out));}catch{/* storage unavailable: not persisted */}
  };
  function refresh(){
    const q=search.value.trim();
    let any=false;
    for(const s of sections){
      let show;
      if(q){
        const rows=[...s.querySelectorAll('label,button,summary,legend')];
        const hit=rows.some(r=>matchesQuery(r.textContent,q));
        show=hit;
        for(const r of s.querySelectorAll('label')){r.hidden=r.dataset.hiddenBase==='1'||!matchesQuery(r.textContent,q)&&!matchesQuery(s.dataset.optTab,q);}
      }else{
        show=s.dataset.optTab===tab;
        for(const r of s.querySelectorAll('label'))r.hidden=r.dataset.hiddenBase==='1';
      }
      s.hidden=!show;any||=show;
    }
    for(const [id,b] of buttons){b.setAttribute('aria-selected',String(!q&&id===tab));b.classList.toggle('on',!q&&id===tab);}
    reset.hidden=Boolean(q);empty.hidden=any;
  }
  function select(id){tab=id;refresh();const d=doc.getElementById('tuning-panel');if(id==='handling'&&d)d.open=true;}
  // Labels hidden by game state (e.g. SWE1R rows) must stay hidden when a search clears.
  for(const l of root.querySelectorAll('label[hidden]'))l.dataset.hiddenBase='1';
  search.addEventListener('input',refresh);
  reset.addEventListener('click',()=>{
    if(tab==='handling'){doc.getElementById('tuning-defaults')?.click();return;}
    for(const s of sections)if(s.dataset.optTab===tab)for(const el of s.querySelectorAll('input,select')){
      if(!defaults.has(el.id)||readValue(el)===defaults.get(el.id))continue;
      writeValue(el,defaults.get(el.id));fire(el,eventFor(el));
    }
  });
  doc.getElementById('wind-tuning-open')?.addEventListener('click',()=>windToggle());

  const stored=loadStored(storage);
  for(const id of PERSISTED_IDS){
    const el=doc.getElementById(id);if(!el)continue;
    if(id in stored)writeValue(el,stored[id]);
    el.addEventListener(eventFor(el),save);
    if(id in stored)fire(el,eventFor(el));
  }
  select(tab);
  return {select,refresh,search,get tab(){return tab;}};
}
