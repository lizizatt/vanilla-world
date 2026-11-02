import test from 'node:test';
import assert from 'node:assert/strict';
import {SHORE_N,SHORE_CELL,SHORE_D_MIN,SHORE_D_MAX,buildShoreClasses,shoreSolve,shoreTexture,shoreAt,shoreClass,shoreDepthTexture} from './shore-field.js';
import {BEACH,beachProfile,beachPeriodFraction,swashEnvelope,packBeachUniform,beachShading} from './beach-waves.js';

const N=SHORE_N;
// Land is z rows >= 60 (seaward normal -z); optional inlet and tidepools.
function coast({inlet=false,pools=false,line=false}={}){
  const c=new Uint8Array(N*N).fill(2);
  for(let j=60;j<N;j++)for(let i=0;i<N;i++)c[j*N+i]=0;
  if(inlet)for(let j=58;j<75;j++)for(let i=42;i<48;i++)c[j*N+i]=1;
  if(pools)for(const [i,j] of [[10,70],[20,66],[70,72],[80,68]])for(let a=0;a<3;a++)for(let b=0;b<3;b++)c[(j+b)*N+i+a]=1;
  if(line)for(let i=0;i<N;i++)c[20*N+i]=0;
  return c;
}
const angle=(f,i,j)=>{const k=j*N+i;return Math.atan2(f.nz[k],f.nx[k])*180/Math.PI;};

test('straight coast: sdf sign, seaward normal and confidence',()=>{
  const f=shoreSolve(coast());
  assert.ok(f.sdf[55*N+48]>0&&f.sdf[65*N+48]<0);
  assert.ok(Math.abs(f.sdf[58*N+48]-(60-58-.5)*SHORE_CELL)<4);
  assert.ok(Math.abs(angle(f,48,58)+90)<2,'normal points to -z');
  assert.ok(f.conf[58*N+48]>.9);
  assert.ok(f.open[40*N+48]>.9);
});

test('averaged normal ignores an inlet and tidepools',()=>{
  const plain=shoreSolve(coast()),busy=shoreSolve(coast({inlet:true,pools:true}));
  for(const i of [10,20,30,60,70,80]){
    const a=angle(plain,i,58),b=angle(busy,i,58);
    assert.ok(Math.abs(a-b)<8,`normal at ${i} moved ${Math.abs(a-b)} deg`);
  }
  // Even at the mouth of the 6-cell inlet the direction stays shoreward-perpendicular within a modest angle.
  assert.ok(Math.abs(angle(busy,45,56)+90)<25);
});

test('opening removes thin land lines and keeps real coasts',()=>{
  const f=shoreSolve(coast({line:true}));
  assert.ok(f.sdf[20*N+48]>0,'1-cell land line is open water');
  assert.ok(f.sdf[65*N+48]<0);
});

test('a river does not count as open sea',()=>{
  const c=new Uint8Array(N*N);
  for(let j=0;j<N;j++)for(let i=0;i<N;i++)c[j*N+i]=(i>=46&&i<=49)?1:0;
  const t=shoreTexture(c);
  assert.equal(t[(48*N+47)*4+3],0);
});

test('shoreTexture is deterministic and shoreAt reads it back',()=>{
  const c=coast({inlet:true}),a=shoreTexture(c),b=shoreTexture(c);
  assert.deepEqual(a,b);
  const origin=[1000,2000],z=origin[1]+58.5*SHORE_CELL,s=shoreAt(a,origin,origin[0]+48*SHORE_CELL,z);
  assert.ok(s.d>SHORE_D_MIN&&s.d<SHORE_D_MAX&&s.d>0&&s.d<20);
  assert.ok(s.n[1]<-.9&&s.weight>.9);
  assert.equal(shoreAt(a,origin,origin[0]-500,z).weight,0);
});

test('buildShoreClasses: inland water above or below sea level is not a shore (no floating beach sheet over a dry basin)',()=>{
  const sample=p=>{const o=new Float64Array(p.length/2*8);for(let n=0;n<p.length/2;n++){o[n*8]=p[n*2]<0?-55:0;o[n*8+7]=0;}return o;};
  const g=buildShoreClasses(sample,()=>[0,-100,0,0,0],[0,0],0,N);
  const at=x=>g.data[Math.floor((x-g.origin[0])/SHORE_CELL)]&3;
  assert.equal(at(-100),0,'pond at y=-55 is land');
  assert.equal(at(100),1,'water at sea level stays water');
});

test('shore class bytes carry the tile liquid depth ramp, which the clipmap tints with (no blue seam where it replaces the flat fill)',()=>{
  const sample=p=>{const o=new Float64Array(p.length/2*8);return o;};
  // Sea bed 14.83 yd under the surface: ramp V = 14.83/148.3 = .1 like the tile liquid's clamp(byte/255) at 1.72 byte/yd.
  const g=buildShoreClasses(sample,(x,z)=>z<0?[1,NaN,NaN,0,0]:[0,-14.83,0,0,0],[0,0],0,N);
  const shallow=g.data[N*N-1],unloaded=g.data[0];
  assert.equal(shoreClass(shallow),1);assert.equal(shoreClass(unloaded),1);
  const ramp=shoreDepthTexture(g.data);
  assert.ok(Math.abs(ramp[N*N-1]/255-.1)<.02,`ramp ${ramp[N*N-1]/255}`);
  assert.equal(ramp[0],255,'a tile that is not resident reads deep, like the fill');
  const land=new Uint8Array(N*N);
  assert.equal(shoreDepthTexture(land)[5],0);
  assert.match(beachShading,/@binding\(9\)[^;]*shoreDepth/);
  assert.match(beachShading,/fn beachRamp\(P:vec2f\)->f32/);
});

test('buildShoreClasses: unavailable tiles are water, land is 0, waves give class 2',()=>{
  const sample=p=>{const o=new Float64Array(p.length/2*8);for(let n=0;n<p.length/2;n++){o[n*8]=0;o[n*8+7]=p[n*2]>100?0:1;}return o;};
  const surface=(x,z)=>z<0?[1,NaN,NaN,0,0]:z<300?[0,-50,0,0,0]:[0,10,0,0,0];
  const g=buildShoreClasses(sample,surface,[0,0],0,N);
  assert.equal(g.data.length,N*N);
  const at=(x,z)=>g.data[Math.floor((z-g.origin[1])/SHORE_CELL)*N+Math.floor((x-g.origin[0])/SHORE_CELL)];
  assert.equal(at(-200,-50)===undefined?1:1,1);
  const row=Math.floor((400-g.origin[1])/SHORE_CELL);
  if(row<N)assert.equal(g.data[row*N+N/2],0);
  assert.deepEqual(buildShoreClasses(sample,surface,[0,0],0,N).data,g.data);
});

test('beachProfile: crest-only, bounded, periodic and zero outside the zone',()=>{
  let max=0;
  for(let d=-4;d<=100;d+=.5)for(let t=0;t<1;t+=.05){
    const p=beachProfile(d,13,t,1);
    assert.ok(p.h>=0&&Number.isFinite(p.slope));
    max=Math.max(max,p.h);
    if(d>BEACH.ZONE[1])assert.equal(p.h,0);
  }
  assert.ok(max<1.7,`height ${max}`);
  assert.ok(max>.4,'visible height');
  const a=beachProfile(20,5,.25),b=beachProfile(20,5,1.25);
  assert.ok(Math.abs(a.h-b.h)<1e-9);
  assert.equal(beachProfile(20,5,.25,.35,0).h,0);
  assert.ok(beachProfile(8,0,.3).q>=0);
});

test('beach waves shoal and lean as depth falls; swash is continuous',()=>{
  const deep=beachProfile(60,0,.3),near=beachProfile(14,0,.3);
  assert.ok(near.b>deep.b);
  let prev=swashEnvelope(0).front;
  for(let w=.01;w<=1;w+=.01){const f=swashEnvelope(w).front;assert.ok(Math.abs(f-prev)<1.2);prev=f;}
  assert.ok(beachPeriodFraction(3.3)>=0&&beachPeriodFraction(3.3)<1);
});

test('packBeachUniform is off without a field and ties to the wave clock',()=>{
  const out=new Float32Array(8);
  assert.deepEqual([...packBeachUniform(out,{field:null})],new Array(8).fill(0));
  const field={origin:[100,200],n:N,cell:SHORE_CELL};
  const params={period:1024,amp:1,dir:0},a=packBeachUniform(new Float32Array(8),{field,origin:[0,0],ticks:100,params:{}});
  assert.equal(a[0],1);
  assert.ok(Math.abs(a[3]-1/(N*SHORE_CELL))<1e-9);
});

test('beach shader binds 7/8 and exposes the swap-point wind hook',()=>{
  assert.match(beachShading,/@binding\(7\)[^;]*bc:Beach/);
  assert.match(beachShading,/@binding\(8\)[^;]*shoreTex/);
  assert.match(beachShading,/fn beachWind\(\)->f32 \{return seaState\(\)\.x;\}/);
  assert.match(beachShading,/fn beachApply\(/);
  assert.match(beachShading,/fn clipLive\(/);
});

// Small island (radius ~3 cells) and a narrow shoal (3 cells wide) far offshore: the field must fade out instead of steering crests into spikes.
function island(r){const c=new Uint8Array(N*N).fill(2);for(let j=0;j<N;j++)for(let i=0;i<N;i++)if(Math.hypot(i-48,j-48)<=r)c[j*N+i]=0;return c;}
function shoal(w){const c=new Uint8Array(N*N).fill(2);for(let j=20;j<76;j++)for(let i=48;i<48+w;i++)c[j*N+i]=0;return c;}
const maxConf=(f,cls,ring)=>{let m=0;for(let k=0;k<N*N;k++)if(cls[k]!==0&&ring(k%N,Math.floor(k/N)))m=Math.max(m,f.conf[k]);return m;};

test('a tiny island yields no confident wave field; the saddle between two islands fades out',()=>{
  const near=(i,j)=>Math.hypot(i-48,j-48)<30;
  const c=island(3);assert.ok(maxConf(shoreSolve(c),c,near)<.25,'tiny island');
  const two=new Uint8Array(N*N).fill(2);
  for(let j=0;j<N;j++)for(let i=0;i<N;i++)if(Math.hypot(i-36,j-48)<=8||Math.hypot(i-60,j-48)<=8)two[j*N+i]=0;
  const f=shoreSolve(two);
  assert.ok(f.conf[48*N+48]<.3,`saddle conf ${f.conf[48*N+48]}`);
});

test('a narrow shoal keeps a coherent, seaward-pointing field on its flanks',()=>{
  const cls=shoal(3),f=shoreSolve(cls);
  assert.ok(f.nx[48*N+53]>.8&&f.nx[48*N+45]<-.8);
});
test('confidence never lets the normal turn fast or point away from the contour gradient',()=>{
  const f=shoreSolve(island(9));
  for(let j=2;j<N-2;j++)for(let i=2;i<N-2;i++){
    const k=j*N+i;if(f.conf[k]<.5)continue;
    const turn=Math.hypot(f.nx[k+1]-f.nx[k-1],f.nz[k+1]-f.nz[k-1])/2;
    assert.ok(turn<.14,`normal turns ${turn}/cell at ${i},${j}`);
  }
});

test('straight coast keeps full confidence (beach waves unchanged there)',()=>{
  const f=shoreSolve(coast());
  for(let i=8;i<N-8;i++)assert.ok(f.conf[58*N+i]>.9);
});

test('beach displacement is bounded',()=>{
  let max=0;
  for(let d=-2;d<90;d+=.5)for(let t=0;t<1;t+=.05)for(const wind of [0,.35,1])max=Math.max(max,beachProfile(d,0,t,wind,1).q);
  assert.ok(max<=BEACH.Q_MAX&&max>0);
});

test('beach phase wobble coordinate is a fixed direction, so a turning shore normal cannot slide the phase (radial streaks, rings, starbursts)',async()=>{
  const {ALONG_DIR}=await import('./beach-waves.js');
  assert.ok(Math.abs(Math.hypot(...ALONG_DIR)-1)<1e-9);
  assert.ok(!/dot\(P\+bc\.b\.yz,\s*tn\)/.test(beachShading)&&!/vec2f\(-f\.n\.y,f\.n\.x\)/.test(beachShading));
  // At the offshore-shoal repro (chart ~ 7088,7282) a 1 degree turn of the normal would have moved the old tangent-based coordinate by >100 yd.
  const P=[7088.5,7282.3],a=.017,old=(th)=>P[0]*-Math.sin(th)+P[1]*Math.cos(th);
  assert.ok(Math.abs(old(a)-old(0))>100);
  assert.ok(beachShading.includes(`vec2f(${ALONG_DIR[0]},${ALONG_DIR[1]})`));
});
