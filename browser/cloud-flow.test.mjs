import test from 'node:test';
import assert from 'node:assert/strict';
import {FLOW,beltWind,bandCoverage,flowPhase,wind,flowWGSL,vortex,vortexSpeed,flowShift} from './cloud-flow.js';
const rng=s=>()=>(s=(s*1664525+1013904223)>>>0)/4294967296;
const deg=Math.PI/180,N=3000;

test('wind: finite and bounded everywhere including the poles',()=>{
  const r=rng(1),vmax=FLOW.zonal*FLOW.westerlyBoost+FLOW.meridional+1e-9;
  for(let i=0;i<N;i++){
    const lat=(r()*2-1)*Math.PI/2,[e,n]=wind(lat,r()*6.3);
    assert.ok(Number.isFinite(e)&&Number.isFinite(n));
    assert.ok(Math.hypot(e,n)<=vmax*1.5);
  }
  for(const lat of [-Math.PI/2,Math.PI/2]){const [e,n]=beltWind(lat);assert.ok(Math.abs(e)<1e-9&&Math.abs(n)<1e-9,'calm at the poles');}
});

test('belt signs: trades easterly, westerlies eastward, polar easterlies, in both hemispheres',()=>{
  const r=rng(2);
  const mean=(lo,hi,sign)=>{let s=0;for(let i=0;i<N;i++)s+=beltWind(sign*(lo+r()*(hi-lo))*deg)[0];return s/N;};
  for(const sign of [1,-1]) {
    assert.ok(mean(5,25,sign)<-3,'trades are easterly');
    assert.ok(mean(35,55,sign)>3,'westerlies are eastward');
    assert.ok(mean(65,78,sign)<-3,'polar easterlies');
  }
});

test('Coriolis symmetry: zonal wind mirrors across the equator, meridional flips sign',()=>{
  const r=rng(3);
  for(let i=0;i<N;i++){
    const lat=r()*Math.PI/2,a=beltWind(lat),b=beltWind(-lat);
    assert.ok(Math.abs(a[0]-b[0])<1e-9);assert.ok(Math.abs(a[1]+b[1])<1e-9);
  }
  // Surface meridional flow: toward the equator in trades, poleward in the Ferrel cell (northern hemisphere).
  assert.ok(beltWind(15*deg)[1]<0&&beltWind(45*deg)[1]>0&&beltWind(75*deg)[1]<0);
});

test('bands: ITCZ wet, subtropics dry, storm track wet, symmetric, bounded',()=>{
  assert.ok(bandCoverage(0)>.1);assert.ok(bandCoverage(28*deg)<-.15);assert.ok(bandCoverage(50*deg)>.1);
  const r=rng(4);
  for(let i=0;i<N;i++){const lat=(r()*2-1)*Math.PI/2,b=bandCoverage(lat);assert.ok(Math.abs(b)<=.3);assert.ok(Math.abs(b-bandCoverage(-lat))<1e-12);}
});

test('flow phases: offsets stay in the cycle, weights in [0,1], blend is continuous across the wrap',()=>{
  const r=rng(5);
  for(let i=0;i<N;i++){
    const t=r()*1e6,p=flowPhase(t);
    assert.ok(p.tauA>=0&&p.tauA<FLOW.period&&p.tauB>=0&&p.tauB<FLOW.period&&p.wA>=0&&p.wA<=1);
    const q=flowPhase(t+1e-3);
    // The weighted offset never jumps: when a phase resets its weight is zero.
    const wrapA=q.tauA<p.tauA,wrapB=q.tauB<p.tauB;
    if(wrapA)assert.ok(p.wA<1e-6&&q.wA<1e-6,'phase A resets only while it is invisible');
    if(wrapB)assert.ok(1-p.wA<1e-6&&1-q.wA<1e-6,'phase B resets only while it is invisible');
  }
});

test('WGSL twin carries the same constants',()=>{
  const w=flowWGSL();
  for(const v of [FLOW.zonal,FLOW.meridional,FLOW.westerlyBoost,FLOW.bands.clearAt])assert.ok(w.includes(String(Number.isInteger(v)?v.toFixed(1):v)));
});

import {density as density} from './cloud-march.js';
import {PLANET_RADIUS as R,WORLD_CENTRE} from './space.js';
import {cloudShader,cloudShaderHigh} from './clouds.js';

test('pole isotropy: noise gradients along east and north stay balanced at every latitude',()=>{
  const r=rng(7),step=120,centre=[WORLD_CENTRE[0]+1234.5,WORLD_CENTRE[1]+777.7];
  for(const latDeg of [0,45,80,85]) {
    let ge=0,gn=0;
    for(let i=0;i<2*N;i++){
      const lat=(latDeg-3+r()*6)*deg,cl=Math.cos(lat),lon=(r()*2-1)*Math.PI,x=WORLD_CENTRE[0]+R*lon,z=WORLD_CENTRE[1]-R*lat,y=1577+(r()-.5)*400,t=0;
      const d0=density([x,y,z],t,false,centre,.7)[0];
      ge+=Math.abs(density([x+step/cl,y,z],t,false,centre,.7)[0]-d0);
      gn+=Math.abs(density([x,y,z-step],t,false,centre,.7)[0]-d0);
    }
    const ratio=ge/gn;
    assert.ok(ratio>.8&&ratio<1.25,`lat ${latDeg}: east/north gradient ${ratio.toFixed(2)}`);
  }
});

test('shaders sample noise on the sphere',()=>{
  for(const s of [cloudShader,cloudShaderHigh])assert.ok(s.includes('sphereAt(pos.xz)')&&s.includes('fn vnoise3')&&s.includes('fn beltWind'));
});

test('vortex: pinned, counter-clockwise on the map, spirals inward, peaks at the core and decays to nothing',()=>{
  assert.deepEqual(vortex(0,0),[0,0]);
  const V=FLOW.vortex,r=rng(31);
  for(let i=0;i<2000;i++) {
    const a=r()*2*Math.PI,rad=200+r()*60000,dx=rad*Math.cos(a),dz=-rad*Math.sin(a),[we,wn]=vortex(dx,dz);
    const e=dx/rad,n=-dz/rad;
    assert.ok(we*-n+wn*e>0,'counter-clockwise (north is -z)');
    assert.ok(we*e+wn*n<0,'inward');
    assert.ok(Math.hypot(we,wn)<=V.speed+1e-9);
  }
  assert.ok(vortexSpeed(V.core)>=vortexSpeed(V.core*.5)&&vortexSpeed(V.core)>vortexSpeed(V.core*3));
  for(let k=1;k<30;k++)assert.ok(vortexSpeed(V.core*(1+k*.1))>vortexSpeed(V.core*(1+(k+1)*.1)),'monotonic outside the wall');
  assert.ok(vortexSpeed(200000)<.01);
});

test('flowShift: zero age is the identity; the sample trails the wind; the vortex turns it about the centre',()=>{
  assert.deepEqual(flowShift(.4,3000,-2000,0).map(Math.abs),[0,0]);
  const [s0,s1]=flowShift(0,1e6,1e6,60),[u,v]=beltWind(0);
  assert.ok(Math.abs(s0+u*60)<1,'east trails the belt wind far from the vortex');
  const [a,b]=flowShift(0,4000,0,30);
  assert.ok(Math.abs(Math.hypot(4000+a,b)-4000)<5,'rotation preserves distance from the centre (equator: no belt wind)');
});

import {createRegistry,defaultManifest} from './tile-registry.js';
import {bakeLandMask,maskAt,landCoverage,landDrag,MASK} from './cloud-flow.js';

const ridge=createRegistry([{id:'r',kind:'p',blend:0,bounds:[40*deg,50*deg,-12*deg,12*deg],provider:{sample:(lat,lon)=>({h:3000*Math.exp(-((lon/(5*deg))**2)),rgb:[.3,.4,.2],water:false})}}]);

test('land mask: land blur is 0 over open ocean, high inland, and the procedural fallback bakes',()=>{
  const m=bakeLandMask(ridge);
  assert.equal(m.data.length,MASK.w*MASK.h*4);
  assert.ok(maskAt(m,-60*deg,150*deg).land<.001);
  assert.ok(maskAt(m,45*deg,0).land>.9);
  const fb=bakeLandMask(createRegistry(defaultManifest()));
  assert.equal(fb.data.length,MASK.w*MASK.h*4);
  let any=0;for(let i=0;i<fb.data.length;i+=4)any=Math.max(any,fb.data[i]);
  assert.ok(any>0,'the fallback continents show up');
});

test('land mask: westerly wind lifts cloud on the windward slope and not the lee; land slows the wind',()=>{
  const m=bakeLandMask(ridge);
  assert.ok(beltWind(45*deg)[0]>0,'mid-latitude westerlies');
  const wind_=maskAt(m,45*deg,-6*deg),lee=maskAt(m,45*deg,6*deg);
  assert.ok(wind_.lift>.05&&lee.lift<-.05,`windward ${wind_.lift.toFixed(2)} lee ${lee.lift.toFixed(2)}`);
  assert.ok(landCoverage(wind_)>landCoverage(lee));
  assert.ok(landDrag(maskAt(m,45*deg,0))<landDrag(maskAt(m,-60*deg,150*deg)));
  assert.ok(landDrag(maskAt(m,45*deg,0))>=1-MASK.drag-1e-9);
});

test('land mask: inland air is drier than the open ocean on average',()=>{
  const m=bakeLandMask(ridge);let inland=0,sea=0;
  for(let k=0;k<20;k++){inland+=landCoverage(maskAt(m,(41+k*.4)*deg,(k%3-1)*3*deg));sea+=landCoverage(maskAt(m,-(41+k*.4)*deg,150*deg));}
  assert.ok(sea>inland,`sea ${sea.toFixed(2)} inland ${inland.toFixed(2)}`);
});

import {CLOUD_ALTITUDE} from './clouds.js';
test('flow map: cloud density is continuous in time across the phase resets, far from the storm',()=>{
  const r=rng(77),T=FLOW.period;let worst=0;
  for(let i=0;i<600;i++) {
    const pos=[80000+r()*40000,CLOUD_ALTITUDE+(r()-.5)*400,(r()*2-1)*60000],t0=(Math.floor(r()*40)+r()*.999)*T/2+(r()<.5?0:.0),k=Math.floor(t0/(T/2)+1)*T/2;
    for(const [ta,tb] of [[k-.05,k+.05],[t0,t0+.05]]) {
      const a=density(pos,ta,false,[0,0])[0],b=density(pos,tb,false,[0,0])[0];worst=Math.max(worst,Math.abs(a-b));
    }
  }
  assert.ok(worst<.05,`density jumps ${worst.toFixed(3)} in 0.1 s`);
});
