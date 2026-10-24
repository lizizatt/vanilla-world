import test from 'node:test';
import assert from 'node:assert/strict';
import {shellRoots,shellExtent,extent,slab} from './cloud-march.js';
import {PLANET_RADIUS} from './space.js';
import {shellCurvature} from './clouds.js';
const rng=s=>()=>(s=(s*1664525+1013904223)>>>0)/4294967296;
const unit=v=>{const n=Math.hypot(...v);return v.map(x=>x/n);};
const dirOf=(yaw,pitch)=>[Math.cos(pitch)*Math.cos(yaw),Math.sin(pitch),Math.cos(pitch)*Math.sin(yaw)];
const altOf=(e,k,d,t)=>{const Re=1/k,P=d.map(x=>x*t);return Math.hypot(P[0],P[1]+(Re+e),P[2])-Re;};
function sample(r,n) {
  const out=[];
  for(let i=0;i<n;i++){const e=[50,520,2000,9000,60000,500000,1e6][Math.floor(r()*7)]*(.5+r());
    const bend=.003+r()*r()*.997,pitch=(r()*2-1)*Math.PI/2*(r()<.3?.2:1);
    out.push({e,k:shellCurvature(bend),bend,high:r()<.5,yaw:r()*6.283,pitch:r()<.1?-Math.PI/2+r()*.01:pitch});}
  return out;
}

test('shell roots lie on the shell, and the extent stays inside the cloud band',()=>{
  const r=rng(11);let live=0;
  for(const s of sample(r,6000)) {
    const d=dirOf(s.yaw,s.pitch),{ya,yb}=slab(s.high);
    for(const y of [ya,yb]) {
      const [t1,t2]=shellRoots(s.e,d[1],y,s.k);
      for(const t of [t1,t2])if(Math.abs(t)<1e29)assert.ok(Math.abs(altOf(s.e,s.k,d,t)-y)<1+1e-6*Math.abs(t),`root off shell ${JSON.stringify(s)}`);
    }
    const x=shellExtent(s.e,d[1],s.k,s.high);
    assert.ok(Number.isFinite(x.s0)&&Number.isFinite(x.s1)&&x.s0>=0,JSON.stringify(s));
    if(x.live){live++;assert.ok(x.s1>x.s0);const a=altOf(s.e,s.k,d,(x.s0+x.s1)/2);assert.ok(a>ya-2&&a<yb+2,`mid-piece altitude ${a} outside band ${JSON.stringify(s)}`);}
  }
  assert.ok(live>500,`only ${live} live rays`);
});

test('small curvature reproduces the flat slab extent',()=>{
  const r=rng(5);
  for(let i=0;i<2000;i++) {
    const e=r()*30000,high=r()<.5,d=dirOf(r()*6.283,(r()*2-1)*1.5);
    if(Math.abs(d[1])<.02||high&&d[1]<.12)continue; // below that the shell deliberately uses the nominal base (no downward billows)
    const f=extent(e,d[1],1e9,high),s=shellExtent(e,d[1],1e-9,high);
    if(f.s1<=f.s0||f.s0>50000)continue;
    assert.ok(Math.abs(f.s0-s.s0)<5e-3*Math.max(1,f.s0),`s0 ${f.s0} vs ${s.s0} e=${e} dy=${d[1]}`);
  }
});

test('High tier: a low eye inside the downward billow zone still sees the sheet down to the sea horizon',()=>{
  const k=.85/42785;
  for(let deg=-1;deg>=-12;deg-=.5) {
    const x=shellExtent(1168,Math.sin(deg*Math.PI/180),k,true);
    assert.ok(x.live&&x.s1-x.s0>1000,`cut at ${deg} deg: ${JSON.stringify(x)}`);
  }
});

test('orbit: straight down reaches the shell, view from space is live at the limb',()=>{
  for(const e of [20000,100000,500000,1e6]) {
    const k=shellCurvature(1),{yb}=slab(true),x=shellExtent(e,-1,k,true);
    assert.ok(x.live&&Math.abs(x.s0-(e-yb))<1,`nadir ${e} ${x.s0}`);
    const tangent=-Math.sqrt(1-((1+k*yb)/(1+k*e))**2)*1.001;
    assert.ok(shellExtent(e,tangent,k,true).live,`limb ray from ${e} should graze the cloud shell`);
  }
});

test('continuity: a tiny turn changes the entry distance by a bounded amount away from the grazing edge',()=>{
  const r=rng(23);let checked=0,worst=0;
  for(const s of sample(r,6000)) {
    const d1=dirOf(s.yaw,s.pitch),d2=dirOf(s.yaw,s.pitch+2e-5),a=shellExtent(s.e,d1[1],s.k,s.high),b=shellExtent(s.e,d2[1],s.k,s.high);
    if(!a.live||!b.live||a.s0>1e6)continue;
    const [t1,t2]=shellRoots(s.e,d1[1],slab(s.high).yb,s.k);
    if(t2-t1<.02*Math.max(t1,1))continue;
    checked++;worst=Math.max(worst,Math.abs(a.s0-b.s0)/Math.max(a.s0,100));
  }
  assert.ok(checked>300);assert.ok(worst<.05,`entry jumped ${worst}`);
});
