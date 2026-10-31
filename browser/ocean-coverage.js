// CPU model of "which water layer draws this point" for the open sea, using the shaders' own discard rules (renderer-shaders.js terrain fs):
//   fill (material 2, flat, ocean-mesh.js): drawn where the mesh has a triangle, discarded inside the clip window where the padded mask amp >= MASK_FILL_EPS;
//   clipmap (material 9, wave-render.js): lattice point P draws at P+d(P) when amp(P) >= MASK_EPS and P belongs to the finest level containing it;
//   tile liquid: land rects (tiles the fill is carved out of) carry their own authored water, so they are not required to be covered by the sea layers.
// A "gap" is a water point (outside every land rect) that neither the fill nor the clipmap draws: it shows the sea floor (a tear).
import {oceanMesh,OCEAN_CELL} from './ocean-mesh.js';
import {waveParams} from './wave-config.js';
import {paramsFromArray,regionScale,shoreK} from './wave-math.js';
import {buildWaveMask,maskAmp,forwardWave,clipLevels,CLIP_LEVELS,MASK_EPS,MASK_FILL_EPS,MASK_PAD,MASK_REFRESH,MASK_N,MASK_CELL,maskInside} from './wave-render.js';
import {WAVE_CEILING} from './renderer-waves.js';

export const rectContains=(r,x,z)=>x>=r[0]&&x<r[2]&&z>=r[1]&&z<r[3];
const rectDistance=(r,x,z)=>Math.hypot(Math.max(r[0]-x,0,x-r[2]),Math.max(r[1]-z,0,z-r[3]));

/** Scene: ocean rect [x0,z0,x1,z1], land rects (tile-granular, absolute chart), optional maelstrom centre. Builds the fill mesh and a triangle index. */
export function buildScene({ocean,land=[],maelstrom}) {
  const params=paramsFromArray(waveParams({}));
  const mesh=oceanMesh({ocean,sea_level:0,whirlpool:maelstrom},96,land),B=OCEAN_CELL/2,index=new Map(),tris=[];
  for(let i=0;i<mesh.length;i+=21){
    const t=[0,1,2].map(k=>[mesh[i+k*7]+ocean[0],mesh[i+k*7+2]+ocean[1]]);tris.push(t);
    const xs=t.map(p=>p[0]),zs=t.map(p=>p[1]);
    for(let cj=Math.floor(Math.min(...zs)/B);cj<=Math.floor(Math.max(...zs)/B);cj++)for(let ci=Math.floor(Math.min(...xs)/B);ci<=Math.floor(Math.max(...xs)/B);ci++){
      const key=cj*100003+ci;(index.get(key)||index.set(key,[]).get(key)).push(t);
    }
  }
  return {ocean,land,params,index,B,tris:tris.length,landBuckets:bucketLand(land)};
}
function bucketLand(land) {
  const B=1024,m=new Map();
  for(const r of land)for(let j=Math.floor(r[1]/B)-1;j<=Math.floor(r[3]/B)+1;j++)for(let i=Math.floor(r[0]/B)-1;i<=Math.floor(r[2]/B)+1;i++)(m.get(j*100003+i)||m.set(j*100003+i,[]).get(j*100003+i)).push(r);
  return {B,m};
}
const nearLand=(scene,x,z)=>scene.landBuckets.m.get(Math.floor(z/scene.landBuckets.B)*100003+Math.floor(x/scene.landBuckets.B))||[];
export const isLand=(scene,x,z)=>nearLand(scene,x,z).some(r=>rectContains(r,x,z));
/** Distance (yd) to the nearest land rect, capped at 2*bucket (beyond the shore fade it is open sea anyway). */
export function landDistance(scene,x,z) {
  let d=Infinity;
  const B=scene.landBuckets.B;
  for(let j=-1;j<=1;j++)for(let i=-1;i<=1;i++)for(const r of scene.landBuckets.m.get((Math.floor(z/B)+j)*100003+Math.floor(x/B)+i)||[])d=Math.min(d,rectDistance(r,x,z));
  return d;
}
/** The physics amplitude field amp_k = regionScale*shoreK, in the layout world.water_sample_batch returns (8 floats per point, height at 0, amp at 7). */
export const sampleBatchFor=scene=>points=>{
  const out=new Float32Array(points.length/2*8);
  for(let n=0;n<points.length/2;n++){
    const x=points[n*2],z=points[n*2+1];
    if(isLand(scene,x,z)){out[n*8]=NaN;continue;}
    out[n*8+7]=regionScale(scene.params,x,z)*shoreK(scene.params,landDistance(scene,x,z));
  }
  return out;
};

function inTriangle(t,x,z,eps=1e-6) {
  const [a,b,c]=t,d=(b[0]-a[0])*(c[1]-a[1])-(c[0]-a[0])*(b[1]-a[1]);
  if(d===0)return false;
  const u=((x-a[0])*(c[1]-a[1])-(c[0]-a[0])*(z-a[1]))/d,v=((b[0]-a[0])*(z-a[1])-(x-a[0])*(b[1]-a[1]))/d;
  return u>=-eps&&v>=-eps&&u+v<=1+eps;
}
export const meshCovers=(scene,x,z)=>(scene.index.get(Math.floor(z/scene.B)*100003+Math.floor(x/scene.B))||[]).some(t=>inTriangle(t,x,z));

/** Everything the renderer would hold at one instant: eye (chart x,z,height), the mask it has uploaded (maybe stale) and the wave clock. */
export function makePose(scene,{eye,mask,t=0}) {
  const active=!!mask&&eye[2]<WAVE_CEILING,levels=clipLevels([eye[0],eye[1]]),outer=levels[CLIP_LEVELS-1];
  return {scene,eye,mask,t,active,levels,clip:{centre:outer.centre,half:outer.half},amp:(x,z)=>maskAmp(mask,x,z)};
}
const inSquare=(x,z,c,h)=>Math.abs(x-c[0])<h&&Math.abs(z-c[1])<h;

/** Does the fill draw (x,z)? Mirrors the fs discard for material 2: yields only inside the clip window where the padded mask amp is >= MASK_FILL_EPS. */
export function fillDraws(pose,x,z) {
  if(!meshCovers(pose.scene,x,z))return false;
  if(pose.active&&inSquare(x,z,pose.clip.centre,pose.clip.half)&&maskInside(pose.mask,x,z,MASK_PAD)&&pose.amp(x,z)>=MASK_FILL_EPS)return false;
  return true;
}
/** Does the clipmap draw (x,z)? Inverts the vertex displacement to the lattice point P, then applies level ownership and the clipLive discard. */
export function clipDraws(pose,x,z) {
  if(!pose.active)return false;
  const opts={amp:pose.amp,eye:[pose.eye[0],pose.eye[1]],clip:pose.clip},p=pose.scene.params;
  let px=x,pz=z;
  for(let i=0;i<8;i++){const f=forwardWave(p,pose.t,px,pz,opts);px+=x-f.x;pz+=z-f.z;}
  const f=forwardWave(p,pose.t,px,pz,opts);
  if(Math.hypot(f.x-x,f.z-z)>.05)return false;
  const owner=pose.levels.find(l=>inSquare(px,pz,l.centre,l.half));
  return !!owner&&pose.amp(px,pz)>=MASK_EPS;
}

/** Scans a dense grid over the clip window (plus margin); returns counts and the gap/flood points. */
export function scanPose(pose,{step=12,radius=pose.clip.half+96,limit=20}={}) {
  const res={points:0,water:0,gaps:[],flood:[],overlap:0,fillOnly:0,clipOnly:0},[ox,oz,rx,rz]=pose.scene.ocean;
  for(let z=Math.floor((pose.eye[1]-radius)/step)*step;z<=pose.eye[1]+radius;z+=step)for(let x=Math.floor((pose.eye[0]-radius)/step)*step;x<=pose.eye[0]+radius;x+=step){
    if(x<ox||x>=rx||z<oz||z>=rz)continue;
    res.points++;
    const fill=fillDraws(pose,x,z);
    if(isLand(pose.scene,x,z)){if(fill&&res.flood.length<limit&&isLand(pose.scene,x-.25,z-.25)&&isLand(pose.scene,x+.25,z+.25)&&isLand(pose.scene,x-.25,z+.25)&&isLand(pose.scene,x+.25,z-.25))res.flood.push([x,z]);continue;}
    res.water++;
    const clip=fill&&!pose.active?false:clipDraws(pose,x,z);
    if(fill&&clip)res.overlap++;else if(fill)res.fillOnly++;else if(clip)res.clipOnly++;
    else if(res.gaps.length<limit)res.gaps.push([x,z]);else res.gapsMore=(res.gapsMore||0)+1;
  }
  return res;
}

/**
 * Walks an eye along a polyline, refreshing the mask like waveItems does (rebuild when the eye is MASK_REFRESH from the mask centre) and
 * scanning each pose. `lag` (yd) delays the mask: the rebuild is built for the eye position `lag` yd earlier on the path, modelling the async slice fetch.
 */
export function sweepPath(scene,path,{height=3,stepYd=160,lag=0,time=0,scan={}}={}) {
  const sample=sampleBatchFor(scene),poses=[];
  const points=[];
  for(let i=0;i+1<path.length;i++){
    const [a,b]=[path[i],path[i+1]],len=Math.hypot(b[0]-a[0],b[1]-a[1]),n=Math.max(1,Math.ceil(len/stepYd));
    for(let k=0;k<n;k++)points.push([a[0]+(b[0]-a[0])*k/n,a[1]+(b[1]-a[1])*k/n]);
  }
  points.push(path[path.length-1]);
  let mask,centre;
  points.forEach((eye,i)=>{
    const behind=points[Math.max(0,i-Math.round(lag/stepYd))];
    if(!mask||Math.max(Math.abs(eye[0]-centre[0]),Math.abs(eye[1]-centre[1]))>MASK_REFRESH){mask=buildWaveMask(sample,behind);centre=[mask.origin[0]+MASK_N*MASK_CELL/2,mask.origin[1]+MASK_N*MASK_CELL/2];}
    const pose=makePose(scene,{eye:[eye[0],eye[1],height],mask,t:time+i*1.37});
    const r=scanPose(pose,scan);poses.push({eye:pose.eye,t:pose.t,...r});
  });
  return poses;
}

/** Deterministic synthetic world: islands of 533.33 yd land tiles (deliberately misaligned with the 250 yd fill lattice), lone tiles and a diagonal chain. */
export function syntheticScene({seed=7,maelstrom}={}) {
  let s=seed>>>0;const rnd=()=>(s=(Math.imul(s,1664525)+1013904223)>>>0)/2**32,T=1600/3,land=[],seen=new Set();
  const add=(i,j)=>{const k=`${i},${j}`;if(!seen.has(k)){seen.add(k);land.push([i*T,j*T,(i+1)*T,(j+1)*T]);}};
  for(const [ci,cj,r] of [[4,4,3],[-9,6,2],[10,-8,4],[-4,-12,2]])for(let j=-r;j<=r;j++)for(let i=-r;i<=r;i++)if(Math.hypot(i,j)<=r*(.6+.5*rnd()))add(ci+i,cj+j);
  for(let n=0;n<14;n++)add(-18+n,-4+(n>>1));
  for(const [i,j] of [[16,16],[-16,16],[0,-17],[18,0]])add(i,j);
  return buildScene({ocean:[-12000,-12000,12000,12000],land,maelstrom});
}
/** Sea-level polylines (chart x,z) crossing coasts, along coast lines and through open sea. */
export const syntheticPaths=()=>[
  [[-6000,-6000],[6000,6000]],
  [[-7000,2000],[7000,2200]],
  [[1400,-9000],[1500,9000]],
  [[-9000,-9500],[9000,-9500]],
];
