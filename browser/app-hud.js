import {mapIcons} from './worldmap.js';
import {memoryUsage,gpuBytesOf,RateMeter} from './memory-budget.js';
import {maelstromCentre} from './clouds.js';
import {hudModel,engineLevels,levelStage} from './hud-model.js';
import {createRealDial,createRealEngines} from './swe1r/hud.js';
import {FlightHud} from './flight-hud.js';
export function installHud(app) {
const {audio,gib,client}=app;
const $=id=>document.getElementById(id);
Object.assign(app,{layoutHud,syncDurability,ownHud,landmarks,syncHud,memoryLine});
app.flashMem={};app.boostMem={};app.meters=document.querySelector('.meters');const ownLast={};
app.realHud=undefined;app.flightHud=new FlightHud($('flight-hud'));
// Each bottom HUD group is ~1/6 of the viewport width (96-320 px), at the Racer ratios: engine pair 67x62, dial 71x59.
function layoutHud(){const w=Math.round(Math.min(320,Math.max(96,innerWidth/6)));document.documentElement.style.setProperty('--hud-w',w+'px');if(!app.realHud)return;const d=$('swe1r-hud'),e=$('swe1r-heat');d.width=w;d.height=Math.round(w*59/71);e.width=w;e.height=Math.round(w*62/67);for(const c of[d,e]){c.style.width=c.width+'px';c.style.height=c.height+'px';}app.dial=createRealDial(app.realHud,d);app.heatGauge=createRealEngines(app.realHud,e);}
addEventListener('resize',layoutHud);
layoutHud();
function syncDurability(){client.request('durability',{on:gib.durable,lethal:gib.on?gib.speed:400}).catch(()=>{});}
function ownHud(boost,hl=1,hr=1){const m=hudModel(boost),key=m.arc+'/'+hl+'/'+hr;if(ownLast.key===key)return;ownLast.key=key;$('heat-arc').style.strokeDasharray=`${m.arc} 100`;const d=$('heat-arc').closest('.speed-dial');d.dataset.stage=String(m.stage);d.dataset.hot=String(m.heat>=1);const g=app.meters.querySelector('.heat-twin');g.dataset.warn=String(m.warn);g.setAttribute('aria-label',`Engine heat ${Math.round(m.heat*100)}%`);const lv=engineLevels(m.heat,hl,hr);g.querySelectorAll('.engine').forEach((e,i)=>{e.dataset.stage=String(levelStage(lv[i]));e.dataset.hot=String(lv[i]>=1);});g.dataset.hot='false';g.setAttribute('aria-label',`Engine heat ${Math.round(m.heat*100)}%, health ${Math.round(hl*100)}% / ${Math.round(hr*100)}%`);}
if(new URLSearchParams(location.search).has('test'))window.ownHudTest=ownHud;
app.dial=undefined;app.heatGauge=undefined;app.hudOn=false;app.countdownSprites=undefined;
function landmarks(){const m=client.info?.manifest;return app.landmarkCache??=m?mapIcons(m,maelstromCentre(m)):[];}
function syncHud(){app.hudOn=$('swe1r-hud-on').checked;}
$('swe1r-hud-on').addEventListener('change',syncHud);
$('swe1r-sfx').addEventListener('change',()=>{audio.sampleOn=$('swe1r-sfx').checked;});
const MiB=v=>((v||0)/1048576).toFixed(0),evictionRate=new RateMeter();
function memoryLine(s,stats) {
  const heap=performance.memory?.usedJSHeapSize,m=memoryUsage(s),gpu=gpuBytesOf(stats),rate=evictionRate.sample(m.evictions,performance.now());
  const cache=m.budget?` · cache ${MiB(m.used)} + GPU ${MiB(gpu)} / ${MiB(m.budget)} MiB · ${m.tiles} tiles · ${rate.toFixed(1)} evict/s`:'';
  return cache+` · ${heap?`JS heap ${MiB(heap)} MiB · `:''}wasm ${MiB(s.horizon?.wasmPeakBytes)} MiB · GPU terrain ${MiB(stats.terrainGpuBytes)} / scene ${MiB(stats.sceneGpuMeshBytes)} / coast water ${MiB(stats.coastalWaterGpuBytes)} MiB`;
}
}
