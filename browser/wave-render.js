// Rendering side of the gameplay sea (design/ocean.md section 3/4). The surface drawn here is the surface the physics reads:
// the same wave-config.js parameter block (parsed with wave-math.js paramsFromArray), the sim tick clock (waveTime) and the same
// shore/storm amplitude m = regionScale*shoreK, which the world worker bakes into the mask texture by asking the physics itself
// (world.water_sample_batch -> amp_k), so render and Rust cannot disagree about where waves are. Each lattice point P of a camera-
// centred clipmap is a Gerstner x0; the vertex sits at x0+sum(m q a cos(th) dir), height sum(m a sin(th)), and the normal is the
// physics Jacobian inverse. That is exactly the surface sampleWaves() inverts, so a pod at the contact height rides the drawn water.
import {waveTime,paramsFromArray} from './wave-math.js';

// The clipmap keeps lattice points with amp >= MASK_EPS, the flat tile/fill water yields only where amp >= MASK_FILL_EPS: the band between is drawn by both,
// so the horizontal Gerstner displacement of the clip edge (and the coarse-level interpolation of it) cannot open a see-through gap along the wave-region boundary.
export const MASK_N=96,MASK_CELL=40,MASK_RANGE=10,MASK_EPS=.01,MASK_FILL_EPS=.5,MASK_REFRESH=384;
// The mask reads 0 outside its window, a hard edge. The fill only yields this far inside it, so a clip vertex displaced across the edge cannot leave a gap (> the largest Gerstner displacement, 5 yd in the maelstrom).
export const MASK_PAD=16;
export const CLIP_LEVELS=5,CLIP_N=64,CLIP_BASE=2,CLIP_HOLE=15,SKIRT=4,MAX_COMPONENTS=6;
export const clipSpacing=level=>CLIP_BASE*2**level;
export const clipHalf=level=>CLIP_N/2*clipSpacing(level);
const smoothstep=(e0,e1,x)=>{const s=Math.min(1,Math.max(0,(x-e0)/(e1-e0)));return s*s*(3-2*s);};
const TAU=Math.PI*2;
const wavelength=c=>TAU/c.k;

/** Amplitude mask, row-major r8unorm: texel (i,j) is the physics amp_k at (ox+(i+.5)*MASK_CELL, oz+(j+.5)*MASK_CELL) / MASK_RANGE. */
export function buildWaveMask(sampleBatch,center,rowStart=0,rowCount=MASK_N){
  const ox=Math.round(center[0]/MASK_CELL-MASK_N/2)*MASK_CELL,oz=Math.round(center[1]/MASK_CELL-MASK_N/2)*MASK_CELL;
  const total=rowCount*MASK_N,base=rowStart*MASK_N,data=new Uint8Array(total),STEP=2048;
  for(let start=0;start<total;start+=STEP){
    const count=Math.min(STEP,total-start),points=new Float64Array(count*2);
    for(let n=0;n<count;n++){const t=base+start+n;points[n*2]=ox+(t%MASK_N+.5)*MASK_CELL;points[n*2+1]=oz+(Math.floor(t/MASK_N)+.5)*MASK_CELL;}
    const out=sampleBatch(points);
    for(let n=0;n<count;n++){const h=out[n*8],k=out[n*8+7];data[start+n]=Number.isNaN(h)||!(k>0)?0:Math.min(255,Math.round(k/MASK_RANGE*255));}
  }
  return {origin:[ox,oz],cell:MASK_CELL,n:MASK_N,data,rowStart};
}
/** True when (x,z) is at least pad yd inside the mask window. */
export const maskInside=(mask,x,z,pad=0)=>x>mask.origin[0]+pad&&z>mask.origin[1]+pad&&x<mask.origin[0]+mask.n*mask.cell-pad&&z<mask.origin[1]+mask.n*mask.cell-pad;
/** Bilinear mask read in chart coordinates, mirroring the shader (0 outside the window). */
export function maskAmp(mask,x,z){
  const u=(x-mask.origin[0])/mask.cell-.5,v=(z-mask.origin[1])/mask.cell-.5,n=mask.n;
  if(x<=mask.origin[0]||z<=mask.origin[1]||x>=mask.origin[0]+n*mask.cell||z>=mask.origin[1]+n*mask.cell)return 0;
  const i=Math.floor(u),j=Math.floor(v),fx=u-i,fz=v-j,at=(a,b)=>mask.data[Math.min(n-1,Math.max(0,b))*n+Math.min(n-1,Math.max(0,a))];
  return ((at(i,j)*(1-fx)+at(i+1,j)*fx)*(1-fz)+(at(i,j+1)*(1-fx)+at(i+1,j+1)*fx)*fz)/255*MASK_RANGE;
}

/**
 * CPU (f64) mirror of the vertex shader's waveVertex(). P is the lattice point (chart x,z); `amp(x,z)` is the shore/storm amplitude m,
 * `eye`/`edge` the LOD distance and clip fade (omit for the full-fidelity surface). Returns {x,z,height,normal,crest}.
 */
export function forwardWave(p,t,px,pz,{amp,eye,clip}={}){
  const m=amp?amp(px,pz):1,dist=eye?Math.hypot(px-eye[0],pz-eye[1]):0;
  const edge=clip?1-smoothstep(.75*clip.half,clip.half,Math.max(Math.abs(px-clip.centre[0]),Math.abs(pz-clip.centre[1]))):1;
  let dx=0,dz=0,h=0,gx=0,gz=0,sxx=0,sxz=0,szz=0;
  for(const c of p.components){
    const w=(1-smoothstep(2*wavelength(c),4*wavelength(c),dist))*edge,a=m*c.amp*w;
    const th=c.k*(c.dir[0]*px+c.dir[1]*pz)-c.omega*t+c.phase,s=Math.sin(th),co=Math.cos(th);
    dx+=c.steepness*a*co*c.dir[0];dz+=c.steepness*a*co*c.dir[1];h+=a*s;gx+=a*c.k*co*c.dir[0];gz+=a*c.k*co*c.dir[1];
    const q=c.steepness*a*c.k*s;sxx+=q*c.dir[0]*c.dir[0];sxz+=q*c.dir[0]*c.dir[1];szz+=q*c.dir[1]*c.dir[1];
  }
  const det=(1-sxx)*(1-szz)-sxz*sxz,hx=((1-szz)*gx+sxz*gz)/det,hz=(sxz*gx+(1-sxx)*gz)/det,inv=1/Math.sqrt(hx*hx+1+hz*hz);
  return {x:px+dx,z:pz+dz,height:h,normal:[-hx*inv,inv,-hz*inv],crest:Math.min(1,Math.max(0,(1-det)*20))};
}

/** Static vertex data of one clipmap level in the terrain 7-float layout (pos, normal, material 9); n.x=1 marks skirt vertices. */
export function clipLevelMesh(level){
  const s=clipSpacing(level),half=CLIP_N/2,out=[],hole=level>0?CLIP_HOLE:0;
  const v=(i,j,skirt=0)=>out.push((i-half)*s,skirt?-SKIRT:0,(j-half)*s,skirt,1,0,9);
  const quad=(i,j)=>{v(i,j);v(i,j+1);v(i+1,j);v(i+1,j);v(i,j+1);v(i+1,j+1);};
  for(let j=0;j<CLIP_N;j++)for(let i=0;i<CLIP_N;i++)if(!(Math.abs(i-half+.5)<hole&&Math.abs(j-half+.5)<hole))quad(i,j);
  // Both-sided skirt walls along the outer rim hide T-junction cracks between levels (the lattice discard leaves the seam exact).
  const wall=(a,b)=>{
    v(a[0],a[1]);v(b[0],b[1]);v(a[0],a[1],1);v(b[0],b[1]);v(b[0],b[1],1);v(a[0],a[1],1);
    v(a[0],a[1]);v(a[0],a[1],1);v(b[0],b[1]);v(b[0],b[1]);v(a[0],a[1],1);v(b[0],b[1],1);
  };
  for(let i=0;i<CLIP_N;i++){wall([i,0],[i+1,0]);wall([i,CLIP_N],[i+1,CLIP_N]);wall([0,i],[0,i+1]);wall([CLIP_N,i],[CLIP_N,i+1]);}
  return Float32Array.from(out);
}

/** Level centres snapped in absolute chart (f64) so lattice points keep their identity while the camera moves; inner = the next finer level's square. */
export function clipLevels(eye){
  const levels=[];
  for(let l=0;l<CLIP_LEVELS;l++){
    const g=2*clipSpacing(l),c=[Math.floor(eye[0]/g)*g,Math.floor(eye[1]/g)*g];
    levels.push({level:l,centre:c,half:clipHalf(l),inner:l>0?{centre:levels[l-1].centre,half:clipHalf(l-1)}:undefined});
  }
  return levels;
}

/**
 * Per-frame uniform block (64 floats). head=(enabled,n,0,0) clip=(outer centre x,z render-relative, half, 0) mask=(origin x,z render-relative, 1/window, 0)
 * then per component (k,dx,dz,amp)(steepness,phase,wavelength,0). The phase is reduced in f64 for the render origin so f32 only sees local coordinates.
 */
export function packWaveUniform(out,{params,ticks,origin,eye,mask}){
  out.fill(0);
  const p=typeof params.period==='number'?params:paramsFromArray(params);
  if(!p.components.length||p.components.length>MAX_COMPONENTS||!mask)return out;
  const t=waveTime(p,ticks),outer=clipLevels(eye)[CLIP_LEVELS-1];
  out.set([1,p.components.length,0,0],0);
  out.set([outer.centre[0]-origin[0],outer.centre[1]-origin[1],outer.half,0],4);
  out.set([mask.origin[0]-origin[0],mask.origin[1]-origin[1],1/(mask.n*mask.cell),0],8);
  p.components.forEach((c,i)=>{
    const phase=((c.k*(c.dir[0]*origin[0]+c.dir[1]*origin[1])-c.omega*t+c.phase)%TAU+TAU)%TAU;
    out.set([c.k,c.dir[0],c.dir[1],c.amp],12+i*8);out.set([c.steepness,phase,wavelength(c),0],16+i*8);
  });
  return out;
}

export const waveRenderShading=`
struct Waves {head:vec4f,clip:vec4f,mask:vec4f,c:array<vec4f,${MAX_COMPONENTS*2}>};
@group(0) @binding(5) var<uniform> wv:Waves;
@group(0) @binding(6) var waveMask:texture_2d<f32>;
struct WV {xz:vec2f,h:f32,n:vec3f,crest:f32};
// Shore/storm amplitude m (the physics amp_k) at a render-space xz; 0 outside the mask window.
fn waveAmp(xz:vec2f)->f32 {
  let uv=(xz-wv.mask.xy)*wv.mask.z;
  if(any(uv<=vec2f(0.0))||any(uv>=vec2f(1.0))){return 0.0;}
  return textureSampleLevel(waveMask,waveSampler,uv,0.0).r*${MASK_RANGE.toFixed(1)};
}
// True when the render-space xz is at least ${MASK_PAD} yd inside the mask window (the ocean fill only yields there).
fn waveMaskInner(xz:vec2f)->bool {
  let uv=(xz-wv.mask.xy)*wv.mask.z;let pad=${MASK_PAD.toFixed(1)}*wv.mask.z;
  return all(uv>vec2f(pad))&&all(uv<vec2f(1.0-pad));
}
// Lattice point P (physics x0) -> displaced position, height, analytic normal; mirrors wave-render.js forwardWave and wave-math.js sampleWaves.
fn waveVertex(P:vec2f,eyeXZ:vec2f)->WV {
  let m=waveAmp(P);let dist=length(P-eyeXZ);
  let edge=1.0-smoothstep(.75*wv.clip.z,wv.clip.z,max(abs(P.x-wv.clip.x),abs(P.y-wv.clip.y)));
  var d=vec2f(0.0);var h=0.0;var g=vec2f(0.0);var sxx=0.0;var sxz=0.0;var szz=0.0;
  let n=u32(wv.head.y);
  for(var i=0u;i<n;i=i+1u){
    let c0=wv.c[2u*i];let c1=wv.c[2u*i+1u];
    let a=m*c0.w*(1.0-smoothstep(2.0*c1.z,4.0*c1.z,dist))*edge;let dir=c0.yz;
    let th=c0.x*dot(dir,P)+c1.y;let s=sin(th);let co=cos(th);
    d+=c1.x*a*co*dir;h+=a*s;g+=a*c0.x*co*dir;
    let q=c1.x*a*c0.x*s;sxx+=q*dir.x*dir.x;sxz+=q*dir.x*dir.y;szz+=q*dir.y*dir.y;
  }
  let det=(1.0-sxx)*(1.0-szz)-sxz*sxz;
  let hx=((1.0-szz)*g.x+sxz*g.y)/det;let hz=(sxz*g.x+(1.0-sxx)*g.y)/det;let inv=inverseSqrt(hx*hx+1.0+hz*hz);
  var out:WV;out.xz=P+d;out.h=h;out.n=vec3f(-hx*inv,inv,-hz*inv);out.crest=clamp((1.0-det)*20.0,0.0,1.0);return out;
}`;
