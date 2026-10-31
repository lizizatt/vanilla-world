import test from 'node:test';
import assert from 'node:assert/strict';
import {waveParams} from './wave-config.js';
import {paramsFromArray,sampleWaves,waveTime,regionScale,shoreK,maxDisplacement} from './wave-math.js';
import {forwardWave,packWaveUniform,buildWaveMask,maskAmp,clipLevelMesh,clipLevels,clipHalf,clipSpacing,CLIP_LEVELS,CLIP_N,MASK_N,MASK_CELL,waveRenderShading,clipLift,BAND_LIFT,MASK_FILL_EPS} from './wave-render.js';

const MAEL=[2000,9000];
const p=paramsFromArray(waveParams({maelstrom:MAEL}));
// A coast: everything west of x=1000 is land; the physics reads distance to it.
const coast=(x)=>Math.max(0,x-1000);
const land=(x,z)=>coast(x);
const amp=(x,z)=>regionScale(p,x,z)*shoreK(p,land(x,z));
const TIMES=[0,1.5,37.25,511.9,1023.99];
const POINTS=[[1500,8800],[1620.5,9100.25],[2000,9000],[2049.3,8950.7],[3000,9500],[1100.25,9020]];

test('drawn surface is the surface the physics samples: same height and normal at the displaced lattice point', () => {
  for(const t of TIMES)for(const [px,pz] of POINTS){
    const f=forwardWave(p,t,px,pz,{amp});
    const s=sampleWaves(p,f.x,f.z,t,land);
    assert.ok(Math.abs(s.height-f.height)<2e-3,`height ${s.height} vs ${f.height} at ${px},${pz},t=${t}`);
    for(let i=0;i<3;i++)assert.ok(Math.abs(s.normal[i]-f.normal[i])<2e-3,`normal ${i}`);
  }
});

test('a pod at the contact height sits on the drawn surface at several x,z,t, in storm and calm', () => {
  const calm=paramsFromArray(waveParams({}));
  for(const [name,params,pts] of [['calm',calm,[[100,200],[333.3,-90.5]]],['storm',p,[[2010,9005],[2100,8900]]]])
    for(const t of TIMES)for(const [x,z] of pts){
      const regionAmp=(qx,qz)=>regionScale(params,qx,qz);
      const contact=sampleWaves(params,x,z,t,()=>Infinity).height;
      // Find the lattice point that the drawn mesh puts at (x,z) by fixed point on the forward map, then compare heights.
      let px=x,pz=z;for(let i=0;i<60;i++){const f=forwardWave(params,t,px,pz,{amp:regionAmp});px+=x-f.x;pz+=z-f.z;}
      const drawn=forwardWave(params,t,px,pz,{amp:regionAmp});
      assert.ok(Math.hypot(drawn.x-x,drawn.z-z)<1e-6,`${name} converged`);
      assert.ok(Math.abs(drawn.height-contact)<2e-3,`${name} t=${t}: drawn ${drawn.height} contact ${contact}`);
    }
});

test('waves are a real, time-varying surface (not flat) and crest and trough differ', () => {
  const heights=TIMES.map(t=>forwardWave(p,t,1500,8800,{amp}).height);
  assert.ok(Math.max(...heights)-Math.min(...heights)>.2);
});

test('shore fade: no displacement or height where the physics is flat, same as sampleWaves', () => {
  const f=forwardWave(p,12,990,9000,{amp}),s=sampleWaves(p,990,9000,12,land);
  assert.equal(f.height,0);assert.equal(s.height,0);
  assert.ok(maxDisplacement(p)>0);
});

test('uniform block reproduces the f64 phase: gpu theta = k dir.(P-origin) + packed phase = physics theta (mod 2pi)', () => {
  const origin=[2112,8801],ticks=1549.1954*120,t=waveTime(p,ticks),out=new Float32Array(64);
  const mask={origin:[0,0],n:MASK_N,cell:MASK_CELL};
  packWaveUniform(out,{params:p,ticks,origin,eye:[2112,8801],mask});
  assert.equal(out[0],1);assert.equal(out[1],p.components.length);
  p.components.forEach((c,i)=>{
    assert.ok(Math.abs(out[12+i*8]-c.k)<1e-7);assert.ok(Math.abs(out[15+i*8]-c.amp)<1e-7);
    for(const local of [[0,0],[300.5,-120.25],[-700,640]]){
      const gpu=out[12+i*8]*(c.dir[0]*local[0]+c.dir[1]*local[1])+out[17+i*8];
      const cpu=c.k*(c.dir[0]*(local[0]+origin[0])+c.dir[1]*(local[1]+origin[1]))-c.omega*t+c.phase;
      const d=((gpu-cpu)%(2*Math.PI)+3*Math.PI)%(2*Math.PI)-Math.PI;
      assert.ok(Math.abs(d)<2e-4,`component ${i} phase off by ${d}`);
    }
  });
  packWaveUniform(out,{params:p,ticks,origin,eye:[0,0],mask:undefined});
  assert.equal(out[0],0,'no mask, waves off');
});

test('mask is the physics amp_k: built from water_sample_batch rows, NaN or zero means no waves', () => {
  const sample=points=>{const o=new Float32Array(points.length/2*8);for(let i=0;i<points.length/2;i++){const x=points[i*2],z=points[i*2+1];o[i*8]=x<500?NaN:0;o[i*8+7]=amp(x,z);}return o;};
  const mask=buildWaveMask(sample,[2000,9000]);
  assert.equal(mask.data.length,MASK_N*MASK_N);
  for(const [x,z] of [[2000,9000],[1500,9100],[2400,8700]])assert.ok(Math.abs(maskAmp(mask,x,z)-amp(x,z))<.12,`${x},${z}: ${maskAmp(mask,x,z)} vs ${amp(x,z)}`);
  assert.equal(maskAmp(mask,mask.origin[0]-10,9000),0);
  assert.equal(maskAmp(buildWaveMask(()=>new Float32Array(2048*8).fill(NaN),[0,0]),0,0),0);
});

test('clipmap levels nest: each hole is covered by the next finer level wherever the camera snaps', () => {
  for(const eye of [[0,0],[3.9,-1.1],[1023.7,555.5],[-17.2,9001.9]]){
    const levels=clipLevels(eye);
    levels.forEach((l,i)=>{
      assert.equal(Math.abs(l.centre[0]%(2*clipSpacing(i))),0);
      if(i>0){
        const hole=15*clipSpacing(i),inner=levels[i-1];
        assert.ok(l.centre[0]-hole>=inner.centre[0]-inner.half-1e-9&&l.centre[0]+hole<=inner.centre[0]+inner.half+1e-9);
        assert.ok(l.centre[1]-hole>=inner.centre[1]-inner.half-1e-9&&l.centre[1]+hole<=inner.centre[1]+inner.half+1e-9);
      }
      assert.ok(Math.abs(eye[0]-l.centre[0])<=l.half&&Math.abs(eye[1]-l.centre[1])<=l.half);
    });
  }
  assert.equal(clipHalf(CLIP_LEVELS-1),1024);
});

test('clipmap mesh budget stays cheap and uses material 9', () => {
  let triangles=0;
  for(let l=0;l<CLIP_LEVELS;l++){const m=clipLevelMesh(l);assert.equal(m.length%21,0);triangles+=m.length/21;for(let i=6;i<m.length;i+=7)assert.equal(m[i],9);}
  assert.ok(triangles<40000,`${triangles} triangles`);
  assert.equal(clipLevelMesh(0).length/21,CLIP_N*CLIP_N*2+CLIP_N*4*4);
});

test('shader declares the wave bindings and mirrors the maths', () => {
  assert.match(waveRenderShading,/@binding\(5\)[^;]*wv:Waves/);
  assert.match(waveRenderShading,/@binding\(6\)[^;]*waveMask/);
  assert.match(waveRenderShading,/for\(var i=0u;i<n;i=i\+1u\)/);
});

test('mask slices stitch to exactly the full mask', () => {
  const sample=points=>{const out=new Float32Array(points.length/2*8);for(let i=0;i<points.length/2;i++){out[i*8]=(points[i*2]+points[i*2+1])%7<1?NaN:0;out[i*8+7]=((points[i*2]*3+points[i*2+1])%9)};return out;};
  const full=buildWaveMask(sample,[2000,9000]),stitched=new Uint8Array(MASK_N*MASK_N);
  for(let row=0;row<MASK_N;row+=12){const part=buildWaveMask(sample,[2000,9000],row,Math.min(12,MASK_N-row));assert.deepEqual(part.origin,full.origin);stitched.set(part.data,row*MASK_N);}
  assert.deepEqual(stitched,full.data);
});

test('ocean fill overlaps the clipmap along the mask edge so no sea-floor tear opens',async()=>{
  const {MASK_EPS,MASK_FILL_EPS}=await import('./wave-render.js');
  const {terrainShader}=await import('./renderer-shaders.js');
  assert.ok(MASK_FILL_EPS>MASK_EPS);
  assert.ok(terrainShader.includes(`waveAmp(v.p.xz)>=${MASK_FILL_EPS}`));
  assert.ok(terrainShader.includes('!clipLive(v.w.xy)'));
});

test('coast z-fighting: in the clip/fill overlap band the clipmap stays strictly above the flat fill (and by more than the depth step) at every phase', () => {
  const near=.5;
  for(const dist of [5,60,300,1200])for(let m=.01;m<MASK_FILL_EPS;m+=.01)for(let t=0;t<1024;t+=7.3)for(const [px,pz] of POINTS){
    const h=forwardWave(p,t,px,pz,{amp:()=>m}).height+clipLift(p,m,dist,near);
    const step=dist*dist/(near*2**24);
    assert.ok(h>=Math.max(BAND_LIFT,step)-1e-9,`m=${m} dist=${dist} t=${t}: clip ${h} is not above the fill`);
  }
});

test('coast z-fighting: the lift vanishes where the fill yields, is continuous in m, and only exists in the shader once', () => {
  assert.ok(clipLift(p,MASK_FILL_EPS,50,.5)>MASK_FILL_EPS*.99);
  assert.equal(clipLift(p,2*MASK_FILL_EPS,50,.5),0);
  assert.equal(clipLift(p,3,50,.5),0);
  let prev=clipLift(p,0,50,.5);
  for(let m=.001;m<=2*MASK_FILL_EPS;m+=.001){const l=clipLift(p,m,50,.5);assert.ok(Math.abs(l-prev)<.01,`jump at m=${m}`);prev=l;}
  assert.ok(clipLift(p,MASK_FILL_EPS,50,.5)<MASK_FILL_EPS*1.0+.05);
  assert.equal(waveRenderShading.match(/fn clipLift\(/g).length,1);
});