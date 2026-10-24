import test from 'node:test';
import assert from 'node:assert/strict';
import {FLOW,beltWind,bandCoverage,flowPhase,wind,flowWGSL} from './cloud-flow.js';
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

import {density} from './cloud-march.js';
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
