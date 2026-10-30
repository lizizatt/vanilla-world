// JS mirror of client/crates/flats-racer-physics/src/waves.rs (design/ocean.md section 4). Same maths, same fixed
// 3-iteration inversion, same operation order; golden vectors in wave-golden.json keep the two within 1e-9.
// Inputs are the flat array from wave-config.js waveParams().
import {WAVE_TICKS_PER_SECOND} from './wave-config.js';

export const INVERSION_ITERATIONS=3;
const HEADER=6,PER_COMPONENT=7,PER_DISC=6;
const smoothstep=(e0,e1,x)=>{const s=Math.min(1,Math.max(0,(x-e0)/(e1-e0)));return s*s*(3-2*s);};

export function paramsFromArray(a){
  if(a.length<HEADER+1||a[0]!==1)throw new Error('Unsupported wave parameters');
  const n=a[5],at=HEADER+n*PER_COMPONENT,m=a[at];
  if(!Number.isInteger(n)||n<1||n>6||!Number.isInteger(m)||a.length!==at+1+m*PER_DISC)throw new Error('Wave parameter length mismatch');
  const components=[],discs=[];
  for(let i=0;i<n;i++){const o=HEADER+i*PER_COMPONENT;components.push({k:a[o],omega:a[o+1],dir:[a[o+2],a[o+3]],amp:a[o+4],steepness:a[o+5],phase:a[o+6]});}
  for(let i=0;i<m;i++){const o=at+1+i*PER_DISC;discs.push({centre:[a[o],a[o+1]],inner:a[o+2],outer:a[o+3],scale:a[o+4],slopeCap:a[o+5]});}
  return {period:a[1],shoreFade:a[2],shoreMargin:a[3],defaultSlopeCap:a[4],components,discs};
}

/** Clock value (s) for a sim tick count; integer modulo so the wrap is exact. */
export const waveTime=(p,ticks)=>(ticks%(p.period*WAVE_TICKS_PER_SECOND))/WAVE_TICKS_PER_SECOND;
export const regionScale=(p,x,z)=>{
  let s=1;
  for(const d of p.discs)s+=(d.scale-s)*(1-smoothstep(d.inner,d.outer,Math.hypot(x-d.centre[0],z-d.centre[1])));
  return s;
};
export const maxDisplacement=p=>p.components.reduce((s,c)=>s+c.steepness*c.amp,0)*p.discs.reduce((m,d)=>Math.max(m,d.scale),1);
export const shoreK=(p,land)=>land===Infinity?1:smoothstep(0,p.shoreFade,land-p.shoreMargin);
export const openSea=()=>Infinity;
const FLAT=Object.freeze({height:0,normal:[0,1,0],velocity:[0,0,0],ampK:0});

/** Surface at (x, z), wave time t (s); `land(x, z)` = distance (yd) to land or authored water. Returns {height, normal, velocity, ampK}. */
export function sampleWaves(p,x,z,t,land=openSea){
  if(land(x,z)-maxDisplacement(p)<=p.shoreMargin)return FLAT;
  const ampK=(qx,qz)=>regionScale(p,qx,qz)*shoreK(p,land(qx,qz));
  let x0=x,z0=z;
  for(let i=0;i<INVERSION_ITERATIONS;i++){
    const m=ampK(x0,z0);let dx=0,dz=0;
    for(const c of p.components){
      const f=m*c.steepness*c.amp*Math.cos(c.k*(c.dir[0]*x0+c.dir[1]*z0)-c.omega*t+c.phase);
      dx+=f*c.dir[0];dz+=f*c.dir[1];
    }
    x0=x-dx;z0=z-dz;
  }
  const m=ampK(x0,z0);
  let height=0,gx=0,gz=0,sxx=0,sxz=0,szz=0,vx=0,vy=0,vz=0;
  for(const c of p.components){
    const th=c.k*(c.dir[0]*x0+c.dir[1]*z0)-c.omega*t+c.phase,sin=Math.sin(th),cos=Math.cos(th),a=m*c.amp;
    height+=a*sin;gx+=a*c.k*cos*c.dir[0];gz+=a*c.k*cos*c.dir[1];
    const q=c.steepness*a*c.k*sin;sxx+=q*c.dir[0]*c.dir[0];sxz+=q*c.dir[0]*c.dir[1];szz+=q*c.dir[1]*c.dir[1];
    vx+=c.steepness*a*c.omega*sin*c.dir[0];vy-=a*c.omega*cos;vz+=c.steepness*a*c.omega*sin*c.dir[1];
  }
  const ja=1-sxx,jb=-sxz,jc=1-szz,det=ja*jc-jb*jb;
  const hx=(jc*gx-jb*gz)/det,hz=(-jb*gx+ja*gz)/det,inv=1/Math.sqrt(hx*hx+1+hz*hz);
  return {height,normal:[-hx*inv,inv,-hz*inv],velocity:[vx,vy,vz],ampK:m};
}
