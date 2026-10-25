import test from 'node:test';
import assert from 'node:assert/strict';
import {cloudShader,cloudShaderHigh,CLOUD_HALF_SIZE,CLOUD_ALTITUDE,CLOUD_THICKNESS} from './clouds.js';
import {march,extent,slab,density,steps,MIN_SPAN} from './cloud-march.js';

// Seeded Monte Carlo sweep of the cloud ray march (pure JS mirror of the sheet branch, no GPU).
function rng(seed) {
  return () => {seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};
}
const dirOf=(yaw,pitch)=>[Math.cos(pitch)*Math.cos(yaw),Math.sin(pitch),Math.cos(pitch)*Math.sin(yaw)];
const N=3000,WORLD=100000;
function randomRay(r) {
  const pick=r(),eyeY=pick<.3?-500+r()*1500:pick<.6?800+r()*3500:pick<.85?r()*15000:5000+r()*20000;
  let pitch=Math.asin(2*r()-1);
  const k=r();
  if(k<.2)pitch=(r()-.5)*.004;else if(k<.3)pitch=r()<.5?-Math.PI/2:Math.PI/2;
  return {eye:[(r()*2-1)*WORLD,eyeY,(r()*2-1)*WORLD],yaw:r()*Math.PI*2,pitch,t:r()*5000,time:Math.floor(r()*2880),coverage:r()<.5?undefined:r()*.95,night:r()<.3?r():0};
}
const run=(s,high,extra={})=>march({eye:s.eye,dir:dirOf(s.yaw,s.pitch),t:s.t,time:s.time,coverage:s.coverage,night:s.night,high,...extra});
// Mean over jitters: a coarse march aliases with the jitter by design, so structural gaps are judged on the expectation.
const mean=(s,high,extra={})=>{let a=0;for(let j=0;j<8;j++)a+=run(s,high,{...extra,jitter:(j+.5)/8}).alpha;return a/8;};

for(const high of [false,true]) {
  const tier=high?'High':'Standard';
  test(`sweep ${tier}: finite, in range, ordered`,()=>{
    const r=rng(11);
    for(let i=0;i<N;i++) {
      const s=randomRay(r),o=run(s,high);
      assert.ok(Number.isFinite(o.alpha)&&o.alpha>=0&&o.alpha<=1,`alpha ${o.alpha} ${JSON.stringify(s)}`);
      for(const c of o.rgb) assert.ok(Number.isFinite(c)&&c>=0&&c<=1.0001,`rgb ${o.rgb} ${JSON.stringify(s)}`);
      assert.ok(o.extent.s0>=0&&Number.isFinite(o.extent.s1)&&(!o.extent.ns||o.extent.s1>o.extent.s0));
    }
  });

  test(`sweep ${tier}: no gap at the horizon inside the slab`,()=>{
    const r=rng(12),{ya,yb}=slab(high);
    let worst=0,where=null;
    for(let i=0;i<400;i++) {
      const s=randomRay(r);s.eye[1]=ya+(Math.min(yb,CLOUD_ALTITUDE+CLOUD_THICKNESS/2)-ya)*r();s.coverage=.6+r()*.35;
      if(Math.abs(s.eye[2]+267)>40000)continue; // beyond ~70 deg latitude the flat z axis degenerates (noise is constant past the clamp)
      const yaw=s.yaw;
      let prev=null;
      for(const p of [-.0006,-.0004,.0004,.0006]) {
        const a=mean({...s,yaw,pitch:p},high);
        if(prev!==null&&Math.abs(a-prev)>worst){worst=Math.abs(a-prev);where={eye:s.eye,yaw,pitch:p,t:s.t,coverage:s.coverage};}
        prev=a;
      }
    }
    assert.ok(worst<.35,`alpha jumps ${worst.toFixed(3)} across the horizon at ${JSON.stringify(where)}`);
  });

  test(`sweep ${tier}: small camera/angle perturbations change alpha boundedly`,()=>{
    const r=rng(13);
    let bad=0,worst=0,where=null;
    for(let i=0;i<N;i++) {
      const s=randomRay(r),a=run(s,high).alpha;
      const b=run({...s,eye:[s.eye[0]+1,s.eye[1]+1,s.eye[2]+1],yaw:s.yaw+1e-4,pitch:Math.max(-1.5707,Math.min(1.5707,s.pitch+1e-4))},high).alpha;
      const d=Math.abs(a-b);
      if(d>worst){worst=d;where=s;}
      if(d>.25)bad++;
    }
    assert.ok(bad/N<.005,`${bad} of ${N} rays pop (worst ${worst.toFixed(3)} at ${JSON.stringify(where)})`);
  });

  test(`sweep ${tier}: a span-capped march fades out instead of ending hard`,()=>{
    const r=rng(14);
    for(let i=0;i<500;i++) {
      const s=randomRay(r);s.coverage=.95;
      const ex=extent(s.eye[1],dirOf(s.yaw,s.pitch)[1],1e9,high);
      if(!ex.capped)continue;
      const a=run(s,high),b=run({...s,t:s.t},high,{jitter:.99});
      const cut=run(s,high,{sceneDist:ex.s1+1});
      assert.ok(Math.abs(a.alpha-b.alpha)<.5,'jitter-stable');
      assert.ok(Math.abs(a.alpha-cut.alpha)<.2,`cap pop ${a.alpha.toFixed(3)} vs ${cut.alpha.toFixed(3)} at ${JSON.stringify(s)}`);
    }
  });

  test(`sweep ${tier}: alpha grows with march length`,()=>{
    const r=rng(15);
    for(let i=0;i<1000;i++) {
      const s=randomRay(r),ex=extent(s.eye[1],dirOf(s.yaw,s.pitch)[1],1e9,high);
      if(!ex.ns||ex.capped)continue;
      const near=mean(s,high,{sceneDist:ex.s0+(ex.s1-ex.s0)*.5}),far=mean(s,high);
      assert.ok(far>=near-.32,`alpha shrank ${near.toFixed(3)} -> ${far.toFixed(3)} at ${JSON.stringify(s)}`);
    }
  });

  test(`sweep ${tier}: rays reach the slab, steps stay bounded`,()=>{
    const r=rng(16),{ya,yb}=slab(high);
    for(let i=0;i<N;i++) {
      const s=randomRay(r),d=dirOf(s.yaw,s.pitch),ex=extent(s.eye[1],d[1],1e9,high);
      const toward=(s.eye[1]<ya&&d[1]>0)||(s.eye[1]>yb&&d[1]<0)||(s.eye[1]>=ya&&s.eye[1]<=yb);
      if(toward&&ex.s0<CLOUD_HALF_SIZE)assert.ok(ex.ns>0,`slab missed ${JSON.stringify(s)}`);
      if(ex.ns)assert.ok((ex.s1-ex.s0)/steps(high)<=Math.max(high?40000:MIN_SPAN,.3*ex.s0)/steps(high)+1e-6);
    }
  });
}

test('sweep: density is continuous (no seams at noise cells or the world wrap)',()=>{
  const r=rng(17);
  for(let i=0;i<2000;i++) {
    const p=[(r()*2-1)*WORLD,1500,(r()*2-1)*WORLD],cell=2600*Math.round(r()*30-15)+r()*.001;
    for(const q of [[cell,1500,p[2]],[p[0],1500,cell],[cell*4096/2600,1500,p[2]]]) {
      const a=density(q,100,true,[0,0],.8)[0],b=density([q[0]+.01,q[1]+.01,q[2]+.01],100,true,[0,0],.8)[0];
      assert.ok(Math.abs(a-b)<.05,`seam at ${q}`);
    }
  }
});

test('sweep: the pre-fix extent is caught (horizon gap and hard cap)',()=>{
  const eyeY=1500,legacy=extent(eyeY,.0002,1e9,false,CLOUD_HALF_SIZE,true),fixed=extent(eyeY,.0002,1e9,false);
  assert.equal(legacy.ns,0);
  assert.ok(fixed.ns>0&&fixed.capped);
  const s={eye:[0,eyeY,0],yaw:1,pitch:.0002,t:300,coverage:.9,time:720,night:0};
  assert.equal(mean(s,false,{legacy:true}),0);
  assert.ok(mean(s,false)>.5,'fixed horizon ray renders cloud');
});

test('parity: shader keeps the extent, cap, tail and step expressions the JS mirror uses',()=>{
  for(const [name,src,ns] of [['standard',cloudShader,8],['high',cloudShaderHigh,28]]) {
    for(const frag of ['select(select(-.0005,.0005,dir.y>=0.0),dir.y,abs(dir.y)>=.0005)',`sCap=s0+max(${name==='high'?'40000.0':'9000.0'},.3*s0)`,'sFull>sCap&&s1==sCap','s0<select(c.cloud.w,1e8,shell)','1.0-cutK*smoothstep(.55,1.0,(ts-s0)/Ls)','smoothstep(30000.0,c.cloud.w,dd)','clamp(dd/150000.0,0.0,.93)'])
      assert.ok(src.includes(frag),`${name} shader lost: ${frag}`);
    assert.ok(src.includes(`NS=${ns}`)||src.includes(`const NS=${ns}`)||src.includes(`${ns}`),`${name} step count`);
  }
});

test('above-layer look-down: no hard edge across pitch, saturated tops stay lit (grey-plateau regression)',()=>{
  for(const H of [6000,9000,16000,30000]) {
    let prev=null,worst=0;
    for(let deg=8;deg<=60;deg+=.05) {
      const p=-deg*Math.PI/180,o=[0,1,2,3,4,5,6,7].map(j=>march({eye:[0,H,0],dir:[Math.cos(p),Math.sin(p),0],t:500,coverage:.95,high:true,jitter:(j+.5)/8}));
      const a=o.reduce((s,x)=>s+x.alpha,0)/8,lum=o.reduce((s,x)=>s+x.rgb[0],0)/8;
      if(prev&&a>.9&&prev.a>.9)worst=Math.max(worst,Math.abs(lum-prev.lum));
      prev={a,lum};
    }
    assert.ok(worst<.12,`colour edge ${worst.toFixed(3)} at H=${H}`);
  }
});

test('far sheet stays visible below a tall High slab (right-side-culled regression)',()=>{
  const mean=(high,yaw)=>{let a=0,n=0;for(let p=-.1;p<=-.02;p+=.01)for(let j=0;j<4;j++){a+=march({eye:[0,6000,1600],dir:[Math.cos(p)*Math.cos(yaw),Math.sin(p),Math.cos(p)*Math.sin(yaw)],t:500,coverage:.8,high,jitter:(j+.5)/4}).alpha;n++;}return a/n;};
  for(const yaw of [0,1,2,3,4,5]) assert.ok(mean(true,yaw)>mean(false,yaw)*.7,`High loses the sheet at yaw ${yaw}`);
});

test('storm arms sweep slowly enough that a fixed view never flips clear/overcast within seconds',async()=>{
  const {MAELSTROM}=await import('./clouds.js');
  assert.ok(2*Math.PI/(MAELSTROM.arms*MAELSTROM.spin)>=120);
});
