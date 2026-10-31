// TEMPORARY dust/spray tuning panel. One removable module: delete this file and its single `import './wind-tuning-panel.js'` in app-hooks.js.
// Everything it changes lives in WIND_TUNE (wind-config.js), which the wind code reads every frame, so edits apply live. Hidden until opened:
// Ctrl+Alt+W, or open the page with #windtune, or call window.windTuning.toggle() in the console. Values persist in localStorage.
import {WIND_TUNE,WIND_TUNE_DEFAULTS} from './wind-config.js';

const KEY='racer.windTune';
// [key, label, min, max, step]. Groups mirror the two effects.
export const TUNE_GROUPS=[
  ['Dust / snow',[
    ['speed','Speed multiplier (of 0.5 x wind)',0,4,.05],['layerSpeed','Stacked-layer speed (x main)',0,2,.05],
    ['layerCount','Stacked layer count',0,6,1],['layerAlpha','Stacked layer opacity (x main)',0,1,.01],
    ['layerTop','Layer band height (yd)',0,3,.01],['groundHeight','Main layer height (yd)',0,3,.01],
    ['sizeHeight','Band thickness (x)',.1,6,.05],['sizeLength','Streak length (x)',.1,6,.05],['diag','Streak diagonal (0 = edge-on)',0,2,.02],
    ['dustAlpha','Dust opacity',0,1,.01],['snowAlpha','Snow opacity',0,1,.01],['density','Density (x particles)',0,3,.05],
    ['farShare','Far-ring share of particles',0,1,.01],['distance','Visible distance (x)',.25,2,.05],
    ['slopeFlat0','Slope: fully visible below',0,1,.01],['slopeFlat1','Slope: hidden above',0,1,.01],
    ['sway','Vertical sway (yd)',0,1,.01],['clear','Ground clearance (yd)',0,1,.01],
    ['dustOn','Dust starts at wind strength',0,1,.01],['dustFull','Dust full at wind strength',0,1,.01],
    ['snowOn','Snow starts at wind strength',0,1,.01],['snowFull','Snow full at wind strength',0,1,.01],
    ['fadeNear','Fade out above ground from (yd)',0,200,1],['fadeFar','...fully gone at (yd)',1,400,1]]],
  ['Sea spray',[
    ['sprayCrest0','Crest threshold (low)',0,2,.01],['sprayCrest1','Crest threshold (full)',0,2,.01],
    ['sprayAlpha','Intensity (opacity)',0,1,.01],['spraySize','Size (x)',.1,6,.05],['sprayDensity','Density (x particles)',0,3,.05],
    ['sprayDistance','Visible distance (x)',.25,2,.05],['sprayFarShare','Far-ring share of particles',0,1,.01],
    ['sprayOn','Starts at wind strength',0,1,.01],['sprayFull','Full at wind strength',0,1,.01]]],
];
const FIELDS=TUNE_GROUPS.flatMap(([,list])=>list);

/** Applies a (possibly partial / untrusted) record onto `target`, ignoring unknown keys and non-finite values and clamping to each slider range. */
export function applyTune(record,target=WIND_TUNE) {
  for(const [key,,min,max] of FIELDS){const v=Number(record?.[key]);if(record&&record[key]!==null&&record[key]!==''&&Number.isFinite(v))target[key]=Math.min(max,Math.max(min,v));}
  return target;
}
export const resetTune=(target=WIND_TUNE)=>Object.assign(target,WIND_TUNE_DEFAULTS);
/** The snippet the user pastes back: the full set, so it can replace WIND_TUNE_DEFAULTS' numbers. */
export const tuneSnippet=(T=WIND_TUNE)=>JSON.stringify(Object.fromEntries(FIELDS.map(([k])=>[k,+T[k].toPrecision(6)])),null,2);

const CSS=`#wind-tuning-panel{position:fixed;top:8px;right:8px;z-index:99999;width:340px;max-height:92vh;overflow:auto;background:#101418ee;color:#dde;font:12px/1.3 system-ui,sans-serif;border:1px solid #f90;border-radius:6px;padding:8px}
#wind-tuning-panel[hidden]{display:none}
#wind-tuning-panel .wt-head{display:flex;gap:6px;align-items:center;margin-bottom:6px}#wind-tuning-panel .wt-head b{color:#f90;flex:1}#wind-tuning-panel button{font:inherit;cursor:pointer}
#wind-tuning-panel summary{cursor:pointer;color:#fc6}#wind-tuning-panel .wt-row{display:grid;grid-template-columns:1fr 110px 54px;gap:6px;align-items:center;margin:2px 0}#wind-tuning-panel input[type=number]{width:54px}`;
function install() {
  try{applyTune(JSON.parse(localStorage.getItem(KEY)));}catch{/* no stored values */}
  let root;const inputs={};
  const save=()=>{try{localStorage.setItem(KEY,JSON.stringify(WIND_TUNE));}catch{/* storage unavailable */}};
  const sync=()=>{for(const [k,,,,step] of FIELDS){inputs[k].range.value=WIND_TUNE[k];inputs[k].num.value=+WIND_TUNE[k].toFixed(step<.1?3:2);}};
  const build=()=>{
    root=document.createElement('div');root.id='wind-tuning-panel';root.hidden=true;
    // A constructed stylesheet: the page CSP (style-src 'self') blocks inline style attributes and <style> elements.
    const sheet=new CSSStyleSheet();sheet.replaceSync(CSS);document.adoptedStyleSheets=[...document.adoptedStyleSheets,sheet];
    const head=document.createElement('div');head.className='wt-head';
    const title=document.createElement('b');title.textContent='TEMPORARY - wind tuning';head.append(title);
    const btn=(label,fn)=>{const b=document.createElement('button');b.textContent=label;b.onclick=fn;head.append(b);return b;};
    const copy=btn('Copy values',async()=>{
      const text=tuneSnippet();
      try{await navigator.clipboard.writeText(text);}catch{const t=document.createElement('textarea');t.value=text;document.body.append(t);t.select();document.execCommand('copy');t.remove();}
      copy.textContent='Copied!';setTimeout(()=>{copy.textContent='Copy values';},1200);
    });
    btn('Reset',()=>{resetTune();save();sync();});btn('x',()=>{root.hidden=true;});
    root.append(head);
    for(const [name,list] of TUNE_GROUPS) {
      const d=document.createElement('details');d.open=true;const sum=document.createElement('summary');sum.textContent=name;d.append(sum);
      for(const [key,label,min,max,step] of list) {
        const row=document.createElement('label');row.className='wt-row';
        const span=document.createElement('span');span.textContent=label;
        const range=document.createElement('input');range.type='range';Object.assign(range,{min,max,step});
        const num=document.createElement('input');num.type='number';Object.assign(num,{min,max,step});
        const set=v=>{if(Number.isFinite(v)){WIND_TUNE[key]=Math.min(max,Math.max(min,v));save();sync();}};
        range.oninput=()=>set(Number(range.value));num.onchange=()=>set(Number(num.value));
        inputs[key]={range,num};row.append(span,range,num);d.append(row);
      }
      root.append(d);
    }
    document.body.append(root);sync();
  };
  const toggle=()=>{if(!root)build();root.hidden=!root.hidden;};
  window.windTuning={toggle,get values(){return {...WIND_TUNE};},snippet:tuneSnippet,reset:()=>{resetTune();save();if(root)sync();}};
  addEventListener('keydown',e=>{if(e.code==='KeyW'&&e.ctrlKey&&e.altKey&&!e.repeat){e.preventDefault();toggle();}},true);
  if(location.hash.includes('windtune'))toggle();
}
if(typeof document!=='undefined'&&typeof localStorage!=='undefined')install();
