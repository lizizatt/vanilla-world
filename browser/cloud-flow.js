// Worldwide cloud flow model (see CLOUD-FLOW.md, option A): an analytic, stateless wind field over the globe (Hadley / Ferrel / polar belts,
// Coriolis-signed meridional flow) used to advect the cloud noise with a two-phase flow-map warp. Pure JS and deterministic; the same
// formulas are emitted as WGSL (flowWGSL) so the shader and the cloud-march.js mirror agree. Latitudes/longitudes are radians; speeds
// are yards per second; the east/north wind pair is in the local tangent frame (north up on the world map), never lon/lat noise space.

import {PLANET_RADIUS,WORLD_CENTRE,LAT_MAX} from './space.js';
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
const smoothstep=(a,b,x)=>{const t=clamp((x-a)/(b-a),0,1);return t*t*(3-2*t);};

export const FLOW={
  // Peak zonal / meridional surface wind of the belts; westerlies run stronger than the trades.
  zonal:24,meridional:6,westerlyBoost:1.25,
  // Zonal speed fades out toward the pole (east/north degenerate there); rad. `soft` rounds the kink of |lat| at the equator.
  poleFade:[80*Math.PI/180,89*Math.PI/180],soft:.05,
  // Cloud coverage offsets by latitude band (ITCZ boost, subtropical clearing, storm-track boost, thin polar cloud).
  bands:{itcz:.16,itczWidth:.12,clear:.22,clearAt:.49,clearWidth:.11,track:.14,trackAt:.87,trackWidth:.14,polar:.12,polarFrom:[1.2,1.45]},
  // Two-phase flow-map warp: cycle length (s) and the blend window of the triangle wave (pure single phase outside it).
  period:90,blend:[.4,.6],
  // Pinned Maelstrom vortex: Rankine core (yd) and far-field decay, peak tangential speed, and inflow angle off tangential.
  vortex:{core:5200,decay:14000,speed:50,inflow:.35,armReach:70000,armCover:.22},
};

/** Zonal (east) and meridional (north) belt wind at a latitude. Mirror-symmetric in hemispheres, Coriolis sign included. */
export function beltWind(lat) {
  const s=Math.sqrt(lat*lat+FLOW.soft*FLOW.soft)-FLOW.soft,x=Math.sin(6*s);
  const fade=1-smoothstep(FLOW.poleFade[0],FLOW.poleFade[1],Math.abs(lat));
  return [-FLOW.zonal*x*(x<0?FLOW.westerlyBoost:1)*fade,-FLOW.meridional*Math.sin(6*lat)];
}

/** Coverage offset from the global cells: wet ITCZ, dry subtropics, stormy mid-latitudes, thin polar cloud. */
export function bandCoverage(lat) {
  const B=FLOW.bands,a=Math.abs(lat),g=(x,c,w)=>Math.exp(-(((x-c)/w)**2));
  return B.itcz*g(lat,0,B.itczWidth)-B.clear*g(a,B.clearAt,B.clearWidth)+B.track*g(a,B.trackAt,B.trackWidth)-B.polar*smoothstep(B.polarFrom[0],B.polarFrom[1],a);
}

/** Two-phase flow-map weights at time t: phase offsets (s) into the cycle and the weight of phase A (phase B = 1 - wA, half a cycle later). */
export function flowPhase(t) {
  const f=t/FLOW.period-Math.floor(t/FLOW.period),tri=1-Math.abs(2*f-1),g=FLOW.period;
  return {tauA:f*g,tauB:((f+.5)%1)*g,wA:smoothstep(FLOW.blend[0],FLOW.blend[1],tri)};
}

/** Wind (east, north) at a point: belt winds. */
export const wind=(lat,lon)=>beltWind(lat);

export const MASK={w:256,h:128,blur:2,drag:.3,dry:.3,lift:.25,coast:.12,liftScale:.08};

/**
 * Land/ocean mask baked once from the tile registry (procedural fallback included), equirect, row 0 = north pole, RGBA8:
 * R = blurred land fraction, G = .5+.5*orographic lift (belt wind blowing up the blurred terrain), B = .5+.5*coastal convergence (belt wind
 * blowing onshore). Land dries and slows the air, windward slopes and coasts raise cloud.
 */
export function bakeLandMask(registry,w=MASK.w,h=MASK.h) {
  const land=new Float32Array(w*h),hgt=new Float32Array(w*h),lonStep=2*Math.PI/w,latStep=Math.PI/h;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++) {
    const s=registry.sample(Math.PI/2-(y+.5)*latStep,((x+.5)/w-.5)*2*Math.PI);
    land[y*w+x]=s.land??(s.water?0:1);hgt[y*w+x]=s.water?0:Math.max(0,s.h);
  }
  const blur=a=>{
    const k=MASK.blur,n=2*k+1;
    for(let pass=0;pass<2;pass++) {
      const t=new Float32Array(w*h),b=new Float32Array(w*h);
      for(let y=0;y<h;y++)for(let x=0;x<w;x++){let s=0;for(let i=-k;i<=k;i++)s+=a[y*w+(x+i+w)%w];t[y*w+x]=s/n;}
      for(let y=0;y<h;y++)for(let x=0;x<w;x++){let s=0;for(let j=-k;j<=k;j++)s+=t[Math.min(h-1,Math.max(0,y+j))*w+x];b[y*w+x]=s/n;}
      a=b;
    }
    return a;
  };
  const M=blur(land),H=blur(hgt),out=new Uint8Array(w*h*4);
  for(let y=0;y<h;y++) {
    const lat=Math.PI/2-(y+.5)*latStep,dxY=Math.max(Math.cos(lat),.05)*lonStep*PLANET_RADIUS*2,dyY=latStep*PLANET_RADIUS*2,[u,v]=beltWind(lat),sp=Math.hypot(u,v)||1;
    for(let x=0;x<w;x++) {
      const i=y*w+x,at=(xx,yy)=>(yy<0?0:yy>=h?h-1:yy)*w+(xx+w)%w;
      const dHe=(H[at(x+1,y)]-H[at(x-1,y)])/dxY,dHn=(H[at(x,y-1)]-H[at(x,y+1)])/dyY;
      const dMe=(M[at(x+1,y)]-M[at(x-1,y)])/dxY,dMn=(M[at(x,y-1)]-M[at(x,y+1)])/dyY;
      const lift=clamp((u*dHe+v*dHn)/sp/MASK.liftScale,-1,1),coast=clamp((u*dMe+v*dMn)/sp*MASK.blur*lonStep*PLANET_RADIUS*2,-1,1);
      out[i*4]=Math.round(clamp(M[i],0,1)*255);out[i*4+1]=Math.round((.5+.5*lift)*255);out[i*4+2]=Math.round((.5+.5*coast)*255);out[i*4+3]=255;
    }
  }
  return {w,h,data:out};
}
/** Bilinear mask lookup at (lat, lon): {land (0..1), lift (-1..1), coast (-1..1)}. */
export function maskAt(mask,lat,lon) {
  const {w,h,data}=mask,x=((lon/(2*Math.PI)+.5)%1+1)%1*w-.5,y=clamp((.5-lat/Math.PI)*h-.5,0,h-1),x0=Math.floor(x),y0=Math.floor(y),fx=x-x0,fy=y-y0,y1=Math.min(y0+1,h-1);
  const px=(xx,yy,c)=>data[(yy*w+(xx+w)%w)*4+c]/255,lerp=(c)=>(px(x0,y0,c)*(1-fx)+px(x0+1,y0,c)*fx)*(1-fy)+(px(x0,y1,c)*(1-fx)+px(x0+1,y1,c)*fx)*fy;
  return {land:lerp(0),lift:lerp(1)*2-1,coast:lerp(2)*2-1};
}
/** Coverage offset and wind drag factor from the mask sample. */
export const landCoverage=m=>MASK.lift*Math.max(m.lift,0)*m.land+MASK.coast*Math.max(m.coast,0)-MASK.dry*m.land*.5;
export const landDrag=m=>1-MASK.drag*m.land;


/** Tangential speed of the pinned Rankine-style Maelstrom vortex at flat distance r (yd): solid-body inside the core, decaying outside. */
export const vortexSpeed=r=>{const V=FLOW.vortex;return V.speed*(r<V.core?r/V.core:(V.core/r)*Math.exp(-(r-V.core)/V.decay));};
/** Vortex wind (east, north) at offset (dx, dz) from the centre (flat render axes, north = -z): counter-clockwise on the map, spiralling inward. */
export function vortex(dx,dz) {
  const r=Math.hypot(dx,dz);if(r<1e-6)return [0,0];
  const e=dx/r,n=-dz/r,v=vortexSpeed(r),ci=Math.cos(FLOW.vortex.inflow),si=Math.sin(FLOW.vortex.inflow);
  return [v*(-ci*n-si*e),v*(ci*e-si*n)];
}
/** Offset of the noise sample point (flat east, north yards) for a flow-map phase of age tau: the belt wind advects linearly, the vortex turns the sample about the centre. */
export function flowShift(lat,dx,dz,tau,drag=1) {
  const r=Math.hypot(dx,dz),turn=tau*vortexSpeed(r)*Math.cos(FLOW.vortex.inflow)/Math.max(r,1),cs=Math.cos(turn),sn=Math.sin(turn);
  const [u,v]=beltWind(lat).map(x=>x*drag);
  return [dx*cs-dz*sn-dx-u*tau,-(dx*sn+dz*cs-dz)-v*tau];
}

/** Sphere-safe noise: the flat render (x, z) is the equirect position (lon = (x-cx)/R, lat = (cz-z)/R); noise is sampled at the 3D point on
 * the planet, so it is isotropic at every latitude (lon/lat noise pinched into streaks toward the poles and tore at the antimeridian).
 * Returns the unit radial `up`, and the tangent `east` / `north` unit vectors (the planet frame of space.js, north = -south). */
const latAt=z=>clamp((WORLD_CENTRE[1]-z)/PLANET_RADIUS,-LAT_MAX,LAT_MAX);
export function sphereAt(x,z) {
  const lat=latAt(z),lon=(x-WORLD_CENTRE[0])/PLANET_RADIUS,sl=Math.sin(lat),cl=Math.cos(lat),so=Math.sin(lon),co=Math.cos(lon);
  return {lat,lon,up:[cl*co,sl,cl*so],east:[-so,0,co],north:[-sl*co,cl,-sl*so]};
}
const fract=x=>x-Math.floor(x);
// Sine-free 3D hash (Hoskins) and value noise: cheap on the GPU and exact in the mirror up to float rounding.
function hash3(x,y,z) {
  let a=fract(x*.1031),b=fract(y*.1031),c=fract(z*.1031);
  const d=a*(c+31.32)+b*(b+31.32)+c*(a+31.32);a+=d;b+=d;c+=d;
  return fract((a+b)*c);
}
export function vnoise3(x,y,z) {
  const ix=Math.floor(x),iy=Math.floor(y),iz=Math.floor(z),fx=x-ix,fy=y-iy,fz=z-iz,sx=fx*fx*(3-2*fx),sy=fy*fy*(3-2*fy),sz=fz*fz*(3-2*fz);
  const m=(a,b,t)=>a+(b-a)*t,h=(i,j,k)=>hash3(ix+i,iy+j,iz+k);
  return m(m(m(h(0,0,0),h(1,0,0),sx),m(h(0,1,0),h(1,1,0),sx),sy),m(m(h(0,0,1),h(1,0,1),sx),m(h(0,1,1),h(1,1,1),sx),sy),sz);
}
/** The WGSL twin of the functions above; uses only constants, so it can be dropped into any module. */
export function flowWGSL() {
  const f=x=>Number.isInteger(x)?x.toFixed(1):String(x),B=FLOW.bands;
  return `
struct Sph {up:vec3f,e:vec3f,n:vec3f,lat:f32,lon:f32};
fn latAt(z:f32)->f32 {return clamp((c.fu.w-z)/${PLANET_RADIUS}.0,-${f(LAT_MAX)},${f(LAT_MAX)});}
fn sphereAt(xz:vec2f)->Sph {
  let lat=latAt(xz.y);let lon=(xz.x-c.fe.w)/${PLANET_RADIUS}.0;
  let sl=sin(lat);let cl=cos(lat);let so=sin(lon);let co=cos(lon);
  return Sph(vec3f(cl*co,sl,cl*so),vec3f(-so,0.0,co),vec3f(-sl*co,cl,-sl*so),lat,lon);
}
fn hash3(p:vec3f)->f32 {var q=fract(p*.1031);q+=dot(q,q.zyx+31.32);return fract((q.x+q.y)*q.z);}
fn vnoise3(p:vec3f)->f32 {
  let i=floor(p);let f=fract(p);let s=f*f*(3.0-2.0*f);
  let a=mix(mix(hash3(i),hash3(i+vec3f(1,0,0)),s.x),mix(hash3(i+vec3f(0,1,0)),hash3(i+vec3f(1,1,0)),s.x),s.y);
  let b=mix(mix(hash3(i+vec3f(0,0,1)),hash3(i+vec3f(1,0,1)),s.x),mix(hash3(i+vec3f(0,1,1)),hash3(i+vec3f(1,1,1)),s.x),s.y);
  return mix(a,b,s.z);
}fn beltWind(lat:f32)->vec2f {
  let s=sqrt(lat*lat+${f(FLOW.soft*FLOW.soft)})-${f(FLOW.soft)};let x=sin(6.0*s);
  let fade=1.0-smoothstep(${f(FLOW.poleFade[0])},${f(FLOW.poleFade[1])},abs(lat));
  return vec2f(-${f(FLOW.zonal)}*x*select(1.0,${f(FLOW.westerlyBoost)},x<0.0)*fade,-${f(FLOW.meridional)}*sin(6.0*lat));
}
fn g2(x:f32)->f32 {return exp(-x*x);}
fn bandCoverage(lat:f32)->f32 {
  let a=abs(lat);
  return ${f(B.itcz)}*g2(lat/${f(B.itczWidth)})-${f(B.clear)}*g2((a-${f(B.clearAt)})/${f(B.clearWidth)})+${f(B.track)}*g2((a-${f(B.trackAt)})/${f(B.trackWidth)})-${f(B.polar)}*smoothstep(${f(B.polarFrom[0])},${f(B.polarFrom[1])},a);
  }
  fn vortexSpeed(r:f32)->f32 {return ${f(FLOW.vortex.speed)}*select((${f(FLOW.vortex.core)}/max(r,1.0))*exp(-(r-${f(FLOW.vortex.core)})/${f(FLOW.vortex.decay)}),r/${f(FLOW.vortex.core)},r<${f(FLOW.vortex.core)});}
  // Flow-map shift of the noise sample (east, north yd) for a phase of age tau: belt wind advects, the vortex turns the sample about the centre.
  fn flowShift(lat:f32,d:vec2f,tau:f32,drag:f32)->vec2f {
    let r=length(d);let turn=tau*vortexSpeed(r)*${f(Math.cos(FLOW.vortex.inflow))}/max(r,1.0);let cs=cos(turn);let sn=sin(turn);
    let bw=beltWind(lat)*drag;
    return vec2f(d.x*cs-d.y*sn-d.x-bw.x*tau,-(d.x*sn+d.y*cs-d.y)-bw.y*tau);
  }
  // (tauA, tauB, weight of phase A): two phases half a cycle apart, crossfaded where the triangle wave nears a phase reset.
  fn flowPhase(t:f32)->vec3f {
    let g=${f(FLOW.period)};let fr=fract(t/g);let tri=1.0-abs(2.0*fr-1.0);
    return vec3f(fr*g,fract(fr+.5)*g,smoothstep(${f(FLOW.blend[0])},${f(FLOW.blend[1])},tri));
  }`;
}
