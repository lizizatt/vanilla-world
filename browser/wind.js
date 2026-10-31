// Procedural wind (design/wind.md): one deterministic function of position, wall time, storm level, zone character and the Maelstrom.
// Pure and GPU-free. wind-wgsl.js emits the same arithmetic for the shaders; `parity` is checked by wind-parity.mjs and wind.test.mjs.
// Wind is render-only: nothing here reaches the physics (Rust) or the wave params. Chart x/z, east = +x, north = -z.
import {WIND as W} from './wind-config.js';
import {beltWind} from './cloud-flow.js';
import {smoothstep} from './math.js';
import {WAVE_TICKS_PER_SECOND} from './wave-config.js';

const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
const TAU=Math.PI*2;
/** Gust frequency of component i (rad/s): an integer multiple of 2 pi / period, so the wrapped clock is seamless. */
export const gustOmega=c=>TAU*c.n/W.period;

/** Wind clock (s) for a sim tick count (the wave clock convention): integer modulo so the wrap is exact. */
export const windTime=ticks=>(ticks%(W.period*WAVE_TICKS_PER_SECOND))/WAVE_TICKS_PER_SECOND;

/** Parameter block layout (12 floats = 3 vec4): [dirX, dirZ, baseSpeed, gain | floor, gust, storm, maelOn | maelX, maelZ, 0, 0]. */
export const WIND_PARAM_FLOATS=12;
export function packWind({base=[0,0],gain=1,floor=0,gust=0,storm=0,mael=null}={},out=new Float32Array(WIND_PARAM_FLOATS)) {
  const speed=Math.hypot(base[0],base[1]),dx=speed>1e-6?base[0]/speed:Math.cos(W.fallbackHeading),dz=speed>1e-6?base[1]/speed:Math.sin(W.fallbackHeading);
  out.set([dx,dz,speed,gain,floor,gust,clamp(storm,0,1),mael?1:0,mael?mael[0]:0,mael?mael[1]:0,0,0]);
  return out;
}

/** Surface belt wind (yd/s) in the chart plane at a latitude (rad): east -> +x, north -> -z. */
export function beltVector(lat) {const [e,n]=beltWind(lat);return [e*W.beltScale,-n*W.beltScale];}

/**
 * Wind at chart (x, z), wind clock t (s, from windTime): returns {dir:[x,z] unit, speed (yd/s), strength 0..1, gust -1..1, storm 0..1}.
 * `a` is the packed block (packWind). Gusts are travelling sines (smooth, bounded); the storm level raises speed and the Maelstrom adds a swirl.
 */
export function windAt(a,x,z,t) {
  let g=0,s2=0;
  W.gust.forEach((c,i)=>{const s=Math.sin(c.k[0]*x+c.k[1]*z-gustOmega(c)*t+c.p);g+=c.w*s;if(i===1)s2=s;});
  let storm=a[6];
  let mx=0,mz=0,mk=0;
  if(a[7]>0.5) {
    const rx=x-a[8],rz=z-a[9],r=Math.hypot(rx,rz),M=W.mael,vt=r<M.core?r/M.core:Math.exp(-(r-M.core)/M.decay);
    mk=1-smoothstep(M.core,M.core+M.halo*M.decay,r);
    const inv=1/Math.max(r,1),tx=-rz*inv,tz=rx*inv,ix=-rx*inv,iz=-rz*inv,v=M.speed*vt;
    mx=v*(Math.cos(M.inflow)*tx+Math.sin(M.inflow)*ix);mz=v*(Math.cos(M.inflow)*tz+Math.sin(M.inflow)*iz);
    storm=Math.max(storm,mk);
  }
  const sk=smoothstep(W.storm.ramp[0],W.storm.ramp[1],storm);
  const speed0=Math.max(0,a[2]*a[3]+a[4])*(1+a[5]*g)+sk*W.storm.add*(.75+.25*g);
  const veer=W.veer*s2*(1-sk*.6),cv=Math.cos(veer),sv=Math.sin(veer);
  const vx=(a[0]*cv-a[1]*sv)*speed0+mx,vz=(a[0]*sv+a[1]*cv)*speed0+mz,speed=Math.hypot(vx,vz),inv=1/Math.max(speed,1e-4);
  return {dir:[vx*inv,vz*inv],speed,strength:clamp(speed/W.maxSpeed,0,1),gust:g,storm:sk};
}

const has=(re,name)=>!!name&&re.test(name);
/** Zone character key (WIND.zones) from the AreaTable zone {name, cold}, the weather climate (dry/snow) and whether the camera is over waves. */
export function zoneCharacter({area=null,climate=null,sea=false}={}) {
  if(sea)return 'sea';
  if(climate?.reason==='snow')return 'snow';
  if(climate?.reason==='dry')return 'desert';
  const n=area?.name;
  if(has(/coast|shore|bay\b|isle|beach|cape|harbou?r|straits?/i,n))return 'coast';
  if(has(/mountain|peak|highland|crag|ridge|foothill|hills|alterac|spine/i,n))return 'mountain';
  if(has(/forest|wood|glade|vale|swamp|marsh|jungle|grove|fen|dale|stranglethorn/i,n))return 'forest';
  return 'plains';
}

/** Sea state hook: the water shader's windK (0..1) driven by wind strength; only ever raises the belt value, never touches the physics waves. */
export const windSeaK=strength=>W.seaCalm+(1-W.seaCalm)*clamp(strength,0,1);
/** Render-only wave-size hook (>= 1) a future visual layer can read; the gameplay sea (wave-config.js) is deliberately not scaled by it. */
export const windWaveHint=strength=>1+smoothstep(W.spray.on,1,strength);

/** Effect amounts 0..1 from the wind strength; exactly 0 below each threshold. */
export const sprayK=s=>smoothstep(W.spray.on,W.spray.full,s);
export const dustK=s=>smoothstep(W.dust.on,W.dust.full,s);
export const snowK=s=>smoothstep(W.snow.on,W.snow.full,s);

/** 1 on flat ground, easing to 0 on slopes steeper than W.flat[1]. */
export const flatK=slope=>1-smoothstep(W.flat[0],W.flat[1],slope);

/**
 * Terrain heights for the ground layer: a world-anchored n x n lattice (step yd) cached forever (terrain is static) and filled nearest-first,
 * `budget` queries per update. `query(x,z)` returns the ground y or a non-finite value when unknown. `data` is the window around the eye
 * (row-major, unknown cells filled with the mean of the known ones) for the shader; `sample` is its bilinear twin.
 */
export class GroundGrid {
  constructor(query,{n,step,budget}=W.grid) {
    this.query=query;this.n=n;this.step=step;this.budget=budget;this.cache=new Map();this.data=new Float32Array(n*n);this.meta=[0,0,step,n];this.known=0;
    const h=(n-1)/2;this.order=[];for(let j=0;j<n;j++)for(let i=0;i<n;i++)this.order.push([i,j,Math.hypot(i-h,j-h)]);this.order.sort((a,b)=>a[2]-b[2]);
  }
  update(x,z) {
    const {n,step}=this,i0=Math.round(x/step)-(n-1)/2,j0=Math.round(z/step)-(n-1)/2;
    if(this.cache.size>6000)this.cache.clear();
    let left=this.budget,sum=0,cnt=0;
    for(const [i,j] of this.order) {
      const key=(i0+i)*1048576+(j0+j);let y=this.cache.get(key);
      if(y===undefined&&left>0){left--;y=this.query((i0+i)*step,(j0+j)*step);y=Number.isFinite(y)?y:NaN;this.cache.set(key,y);}
      if(Number.isFinite(y)){sum+=y;cnt++;}
    }
    const mean=cnt?sum/cnt:0;this.known=cnt;
    for(let j=0;j<n;j++)for(let i=0;i<n;i++){const y=this.cache.get((i0+i)*1048576+(j0+j));this.data[j*n+i]=Number.isFinite(y)?y:mean;}
    this.meta=[i0*step,j0*step,step,n];
    return this;
  }
  /** Bilinear ground height at world (x,z), clamped to the window. Matches groundShader's groundY. */
  sample(x,z) {
    const [ox,oz,step,n]=this.meta,fx=(x-ox)/step,fz=(z-oz)/step,i=Math.floor(fx),j=Math.floor(fz),tx=fx-i,tz=fz-j;
    const at=(a,b)=>this.data[clamp(b,0,n-1)*n+clamp(a,0,n-1)];
    return (at(i,j)*(1-tx)+at(i+1,j)*tx)*(1-tz)+(at(i,j+1)*(1-tx)+at(i+1,j+1)*tx)*tz;
  }
  /** Local slope (rise/run) by central differences one lattice step either side. Matches groundShader's slopeAt. */
  slope(x,z) {
    const s=this.step,gx=this.sample(x+s,z)-this.sample(x-s,z),gz=this.sample(x,z+s)-this.sample(x,z-s);
    return Math.hypot(gx,gz)/(2*s);
  }
}

/**
 * Per-frame runtime: smooths the zone parameters, evaluates the wind at the eye and decides which effect layers run.
 * ctx: {dt, x, z, t (windTime), lat, character, storm, mael:[x,z]|null, enabled}. Cheap (one windAt per frame).
 */
export class WindRuntime {
  constructor() {
    this.base=[0,0];this.gain=1;this.floor=0;this.gust=0;this.ready=false;this.character='plains';
    this.params=new Float32Array(WIND_PARAM_FLOATS);this.sample={dir:[1,0],speed:0,strength:0,gust:0,storm:0};
    this.on=0;this.spray=0;this.dust=0;this.snow=0;this.drift=[0,0];this.layerDrift=[0,0];
  }
  step(ctx) {
    const Z=W.zones[ctx.character]??W.zones.plains;
    if(!ctx.enabled){this.on=0;this.spray=this.dust=this.snow=0;this.sample={dir:[1,0],speed:0,strength:0,gust:0,storm:0};this.ready=false;return this;}
    const b=beltVector(ctx.lat??0),k=this.ready?1-Math.exp(-ctx.dt/W.tau):1;
    this.base=[this.base[0]+(b[0]-this.base[0])*k,this.base[1]+(b[1]-this.base[1])*k];
    this.gain+=(Z.gain-this.gain)*k;this.floor+=(Z.floor-this.floor)*k;this.gust+=(Z.gust-this.gust)*k;this.ready=true;this.character=ctx.character;
    packWind({base:this.base,gain:this.gain,floor:this.floor,gust:this.gust,storm:ctx.storm??0,mael:ctx.mael},this.params);
    const s=this.sample=windAt(this.params,ctx.x,ctx.z,ctx.t);
    this.on=1;this.spray=ctx.sea?sprayK(s.strength):0;
    this.dust=ctx.character==='desert'?dustK(s.strength):0;this.snow=ctx.character==='snow'?snowK(s.strength):0;
    // Drift of the ground layer (yd), integrated on the CPU so a changing gust never teleports the particles; wrapped to keep f32 exact.
    const d=ctx.dt>0&&ctx.dt<.25?ctx.dt:0,k2=d*W.groundSpeed,dx=s.dir[0]*s.speed*k2,dz=s.dir[1]*s.speed*k2,L=W.box.groundFar;
    this.drift=[(this.drift[0]+dx)%L,(this.drift[1]+dz)%L];
    const k3=W.layers.speed;this.layerDrift=[(this.layerDrift[0]+dx*k3)%L,(this.layerDrift[1]+dz*k3)%L];
    return this;
  }
  get ground() {return Math.max(this.dust,this.snow);}
}
