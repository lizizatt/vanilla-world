// Generates browser/CODEMAP.html: a city-map treemap (feature districts, file blocks sized by lines).
// Usage: node codemap.mjs   (run from browser/)
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const FEATURES = [
  ['Clouds & weather', /^(clouds|cloud-)/],
  ['Globe, space & planet', /^(space|globe-|planet-|tile-registry|height-bake|orient)/],
  ['Ocean & water', /^(ocean-|water-)/],
  ['Sky, light & particles', /^(sky|shadow|particles|plume|beam)/],
  ['Terrain & scene streaming', /^(scene-|terrain-|far-|craft-stream|asset-|glb|adt-synth|demo-source|world-store|scenery|coast|distant)/],
  ['Racing & tracks', /^(race|track-|vehicle|vehicles|flight|wreck|camera-collision|pod-render|driving|feel|cockpit|obstacle|airborne|pole-flight)/],
  ['Actors & NPCs', /^(actors|npc-|wander)/],
  ['Audio & music', /^(music|world-music|world-audio|sound|audio|master-volume)/],
  ['HUD, map & UI', /^(hud|map-panel|worldmap|loading|index|style|world-view|startup|viewport|pose|save)/],
  ['App core & delivery', /^(world[-.]|server|sw|build-dist|performance|admission|soak|daynight|scene-smoke|overworld)/],
];
const featureOf = n => (FEATURES.find(([, re]) => re.test(n)) || ['Other'])[0];
const kindOf = n => /\.test\.mjs$/.test(n) ? 'test'
  : /(-smoke|-shots|-probe|-audit|-check|-lab|-explore|-concepts?|-preview|soak|capture|fixture|audit-|ascent-|plume-audit)/.test(n) || /\.mjs$/.test(n) && n !== 'server.mjs' && n !== 'build-dist.mjs' ? 'script' : 'source';

const files = [];
const dir = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
for (const n of readdirSync(dir)) {
  const p = join(dir, n);
  if (!statSync(p).isFile() || !['.js', '.mjs', '.css', '.html'].includes(extname(n)) || n === 'CODEMAP.html') continue;
  const lines = readFileSync(p, 'utf8').split('\n').length;
  files.push({ name: n, lines, feature: featureOf(n), kind: kindOf(n) });
}
const rustDir = join(dir, '..', 'client', 'crates');
for (const crate of ['flats-racer-physics', 'flats-racer-web']) {
  const walk = d => readdirSync(d, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? (e.name === 'target' ? [] : walk(join(d, e.name))) : e.name.endsWith('.rs') ? [join(d, e.name)] : []);
  try {
    for (const p of walk(join(rustDir, crate))) {
      files.push({ name: `${crate}/${p.split(/[\\/]/).pop()}`, lines: readFileSync(p, 'utf8').split('\n').length, feature: 'Rust crates (wasm physics)', kind: 'rust' });
    }
  } catch { /* crate absent */ }
}

const html = `<!doctype html><meta charset=utf-8><title>Azeroth Racer code map</title>
<style>
body{margin:0;background:#0f1218;color:#dde;font:12px system-ui}
#hd{padding:10px 14px;display:flex;gap:18px;align-items:center;flex-wrap:wrap}
#hd b{font-size:15px}.sw{display:inline-block;width:10px;height:10px;margin-right:4px}
#map{position:relative;margin:0 14px 14px;height:calc(100vh - 80px)}
.d{position:absolute;box-sizing:border-box;border:2px solid #0f1218;background:#1a2030}
.d>.t{position:absolute;left:4px;top:2px;font-weight:600;color:#fff;font-size:12px;text-shadow:0 1px 2px #000;z-index:2;white-space:nowrap;pointer-events:none}
.f{position:absolute;box-sizing:border-box;border:1px solid #0f1218;overflow:hidden;font-size:10px;padding:2px;color:#000;cursor:default}
.f:hover{outline:2px solid #fff;z-index:3}
#tip{position:fixed;background:#000d;padding:6px 8px;border-radius:4px;pointer-events:none;display:none;z-index:9}
</style>
<div id=hd><b>Azeroth Racer code map</b><span id=sum></span>
<span><i class=sw style=background:#6fb3ff></i>source <i class=sw style=background:#8fd99a></i>test <i class=sw style=background:#e6c46a></i>script/smoke <i class=sw style=background:#e08a6a></i>rust</span>
<span>Block area = lines of code. Districts = features.</span></div>
<div id=map></div><div id=tip></div>
<script>
const FILES=${JSON.stringify(files)};
const COL={source:'#6fb3ff',test:'#8fd99a',script:'#e6c46a',rust:'#e08a6a'};
function squarify(items,x,y,w,h){const out=[];let list=items.slice().sort((a,b)=>b.v-a.v),tot=list.reduce((s,i)=>s+i.v,0);
 while(list.length){const sc=w*h/tot;let row=[],rv=0,best=1e9;const side=Math.min(w,h);
  const worst=(r,s)=>{const a=s*sc,m=Math.max(...r.map(i=>i.v*sc)),n=Math.min(...r.map(i=>i.v*sc));return Math.max(side*side*m/(a*a),a*a/(side*side*n))};
  while(list.length){const t=[...row,list[0]],s=rv+list[0].v,wv=worst(t,s);if(row.length&&wv>best)break;row=t;rv=s;best=wv;list.shift()}
  const rs=rv*sc/side;let o=0;
  for(const i of row){const l=i.v*sc/rs;out.push(w>=h?{i,x,y:y+o,w:rs,h:l}:{i,x:x+o,y,w:l,h:rs});o+=l}
  if(w>=h){x+=rs;w-=rs}else{y+=rs;h-=rs}tot-=rv}
 return out}
const map=document.getElementById('map'),tip=document.getElementById('tip');
const groups={};FILES.forEach(f=>(groups[f.feature]??=[]).push(f));
const total=FILES.reduce((s,f)=>s+f.lines,0),src=FILES.filter(f=>f.kind=='source').reduce((s,f)=>s+f.lines,0);
document.getElementById('sum').textContent=total.toLocaleString()+' lines in '+FILES.length+' files ('+src.toLocaleString()+' product source)';
function draw(){map.innerHTML='';const W=map.clientWidth,H=map.clientHeight;
 const ds=Object.entries(groups).map(([k,fs])=>({k,fs,v:fs.reduce((s,f)=>s+f.lines,0)}));
 for(const d of squarify(ds,0,0,W,H)){const el=document.createElement('div');el.className='d';
  Object.assign(el.style,{left:d.x+'px',top:d.y+'px',width:d.w+'px',height:d.h+'px'});
  el.innerHTML='<div class=t>'+d.i.k+' · '+d.i.v.toLocaleString()+'</div>';
  const ih=Math.max(0,d.h-18);
  for(const f of squarify(d.i.fs.map(f=>({...f,v:f.lines})),0,18,d.w-4,ih)){const b=document.createElement('div');b.className='f';
   Object.assign(b.style,{left:f.x+'px',top:f.y+'px',width:f.w+'px',height:f.h+'px',background:COL[f.i.kind]});
   if(f.w>42&&f.h>14)b.textContent=f.i.name.replace('.mjs','').replace('.js','')+' '+f.i.lines;
   b.onmousemove=e=>{tip.style.display='block';tip.style.left=e.clientX+12+'px';tip.style.top=e.clientY+12+'px';tip.textContent=f.i.name+' — '+f.i.lines+' lines ('+f.i.kind+')'};
   b.onmouseleave=()=>tip.style.display='none';el.appendChild(b)}
  map.appendChild(el)}}
draw();addEventListener('resize',draw);
</script>`;
writeFileSync(join(dir, 'CODEMAP.html'), html);
console.log(files.length, 'files');
