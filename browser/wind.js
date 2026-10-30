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

/**
 * Per-frame runtime: smooths the zone parameters, evaluates the wind at the eye and decides which effect layers run.
 * ctx: {dt, x, z, t (windTime), lat, character, storm, mael:[x,z]|null, enabled}. Cheap (one windAt per frame).
 */
export class WindRuntime {
  constructor() {
    this.base=[0,0];this.gain=1;this.floor=0;this.gust=0;this.ready=false;this.character='plains';
    this.params=new Float32Array(WIND_PARAM_FLOATS);this.sample={dir:[1,0],speed:0,strength:0,gust:0,storm:0};
    this.on=0;this.spray=0;this.dust=0;this.snow=0;this.drift=[0,0];
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
    const d=ctx.dt>0&&ctx.dt<.25?ctx.dt:0,dx=s.dir[0]*s.speed*d,dz=s.dir[1]*s.speed*d,L=W.box.ground;
    this.drift=[(this.drift[0]+dx)%L,(this.drift[1]+dz)%L];
    return this;
  }
  get ground() {return Math.max(this.dust,this.snow);}
}
