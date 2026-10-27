// Pure-JS mirror of the cloud sheet ray march in clouds.js (slab extent, stepping, density, fade, fog blend, lighting), used by the
// Monte Carlo sweep in clouds-sweep.test.mjs with no GPU. Keep it consistent with the WGSL: the sweep test checks the shared constants and
// the extent/fade expressions appear verbatim in the shader. The High tier's 3D noise texture is replaced here by the Standard analytic
// noise (the texture is baked from the same kind of value noise), so High geometry (towers, 28 steps, light tap) is covered, its noise is not.
import {sphereAt,vnoise3,bandCoverage,flowShift,flowPhase,FLOW,maskAt,landCoverage,landDrag} from './cloud-flow.js';
import {CLOUD_ALTITUDE,CLOUD_THICKNESS,CLOUD_HALF_SIZE,MAELSTROM as M,tier} from './cloud-config.js';
import {sunDirection,shellCurvatureAt,shellBendFromCurvature} from './clouds.js';
import {PLANET_RADIUS,WORLD_CENTRE,planetFrame} from './space.js';
import {smoothstep} from './math.js';
import {dirLatLon,flatOf} from './equirect.js';

export const FADE_START=30000,FOG_RANGE=150000,SPAN_PER_DISTANCE=.3;
export const MIN_SPAN=tier(false).minSpan;
export const steps=high=>tier(high).steps;
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
const mix=(a,b,t)=>a+(b-a)*t;
const fract=x=>x-Math.floor(x);
export {smoothstep};
const hash=(x,y)=>fract(Math.sin(x*127.1+y*311.7)*43758.5453);
function vnoise(x,y) {
  const ix=Math.floor(x),iy=Math.floor(y),fx=x-ix,fy=y-iy,sx=fx*fx*(3-2*fx),sy=fy*fy*(3-2*fy);
  return mix(mix(hash(ix,iy),hash(ix+1,iy),sx),mix(hash(ix,iy+1),hash(ix+1,iy+1),sx),sy);
}

/** Slab bounds in yards for a tier (High adds tower growth above and below). */
export function slab(high) {
  const {up,down}=tier(high).tower;
  return {ya:CLOUD_ALTITUDE-CLOUD_THICKNESS/2-down,yb:CLOUD_ALTITUDE+CLOUD_THICKNESS/2+up,up,down};
}

/** Density at a world position: [body, storm, height fraction]; `coverage` may be forced to sweep storm values. */
export function density(pos,t,high,centre=[0,0],coverageOverride,mask) {
  const {ya,up,down}=slab(high);
  const dx=pos[0]-centre[0],dz=pos[2]-centre[1],r=Math.hypot(dx,dz);
  const sp=sphereAt(pos[0],pos[2]);
  const a=Math.atan2(-dz,dx);
  const arm=smoothstep(.2,.8,.5+.5*Math.cos(M.arms*(a+M.pitch*Math.log(Math.max(r,1)/1000)-t*M.spin)));
  const storm=Math.exp(-r/M.radius);
  const wall=Math.exp(-(((r-M.wallRadius)/(M.wallRadius*.35))**2));
  const eye=smoothstep(M.eyeRadius,M.eyeRadius*1.5,r);
  const lm=mask?maskAt(mask,sp.lat,sp.lon):{land:0,lift:0,coast:0},drag=landDrag(lm);
  const base=.4+(bandCoverage(sp.lat)+landCoverage(lm)+Math.exp(-r/FLOW.vortex.armReach)*(arm-.5)*FLOW.vortex.armCover)*(1-storm);
  const coverage=coverageOverride??clamp(mix(base,mix(.1,.95,arm),storm)+.6*wall,0,.95)*eye;
  const body=tau=>{
    const s=flowShift(sp.lat,dx,dz,tau,drag),Q=[0,1,2].map(i=>sp.up[i]*PLANET_RADIUS+sp.east[i]*s[0]+sp.north[i]*s[1]);
    const grow=smoothstep(.45,.95,coverage)*mix(.4,1,vnoise3(Q[0]/3800+t*.012,Q[1]/3800-t*.009,Q[2]/3800));
    const base=CLOUD_ALTITUDE-CLOUD_THICKNESS/2-down*grow;
    const hf=clamp((pos[1]-base)/(CLOUD_THICKNESS+(up+down)*grow),0,1);
    const [q0,q1,q2]=[Q[0]/2600,Q[1]/2600,Q[2]/2600];
    let n=.55*vnoise3(q0,q1,q2)+.3*vnoise3(q0*2.3+7,q1*2.3+7,q2*2.3+7)+.15*vnoise3(q0*5.1+3,q1*5.1+3,q2*5.1+3);
    n=n*.78+.22*vnoise3(Q[0]/650+hf*3.1,Q[1]/650+hf*1.7,Q[2]/650+hf*2.3);
    const top=(n-(1-coverage))*(2.2+1.6*wall);
    return [smoothstep(0,.3,top-hf*.9)*smoothstep(0,.1,hf+.05),hf];
  };
  const fp=flowPhase(t),bh=fp.wA>=1?body(fp.tauA):fp.wA<=0?body(fp.tauB):(()=>{const b=body(fp.tauB),a2=body(fp.tauA);return [mix(b[0],a2[0],fp.wA),mix(b[1],a2[1],fp.wA)];})();
  return [bh[0],storm*(.55+.45*smoothstep(M.eyeRadius,M.wallRadius*2,r)),bh[1],ya];
}
/**
 * Marches one ray exactly like the fragment shader's sheet branch. Returns {alpha, rgb (premultiplied-free colour), extent}.
 * `o`: {eye:[x,y,z], dir:[x,y,z] (unit), t, high, time (Light.dbc half-minutes), centre, coverage, sceneDist, jitter (0..1), night (0..1)}.
 */
export function march(o) {
  const {eye,dir,t=0,high=false,time=1440,centre=[0,0],coverage,sceneDist=1e9,jitter=.5,night=0,sun:sunOver}=o;
  const ex=extent(eye[1],dir[1],sceneDist,high);
  if(!ex.ns)return {alpha:0,rgb:[0,0,0],extent:ex};
  const sun=sunOver??sunDirection(time),ns=ex.ns,ss=(ex.s1-ex.s0)/steps(high);
  const grade=[1-.8*night,1-.73*night,1-.5*night],fog=[.08*(1-night),.15*(1-night),.2*(1-night)];
  let trans=1;const light=[0,0,0];
  for(let i=0;i<ns;i++) {
    const ts=ex.s0+ss*(i+jitter),rel=[dir[0]*ts,dir[1]*ts,dir[2]*ts],pos=worldAt(eye,rel),sunY=dot(upAt(eye[1],rel),sun),day=smoothstep(-.1,.25,sunY);
    const s=density(pos,t,high,centre,coverage,o.mask);
    if(s[0]<=.001)continue;
    const tail=ex.capped?1-ex.cutK*smoothstep(.55,1,(ts-ex.s0)/(ex.s1-ex.s0)):1;
    const w=(1-smoothstep(FADE_START,CLOUD_HALF_SIZE,ts))*.96*ex.sEdge*tail;
    const absorb=(1-Math.exp(-s[0]*ss*.008))*w;
    let shade=1;
    if(high){const sd=density([pos[0]+sun[0]*ss*2.5,pos[1]+sun[1]*ss*2.5,pos[2]+sun[2]*ss*2.5],t,high,centre,coverage,o.mask)[0];shade=mix(mix(.65,1,Math.exp(-sd*2)),1,smoothstep(.7,1,s[2]))*(1+.8*Math.max(dot(dir,sun),0)**6);}
    const lit=mix(.62,1,s[2])*mix(.75,1,s[1])*(.7+.3*trans)*shade;
    const mixFog=clamp(ts/FOG_RANGE,0,.93);
    for(let k=0;k<3;k++) {
      const under=[.55,.6,.7][k],lite=[.98,.97,.95][k];
      const tone=mix(under,lite,lit)*lit*mix(.55,1,day)*(1+.3*s[2]*day)+[.18,.1,.1][k]*(1-s[1])*lit+[1,.96,.88][k]*Math.max(dot(dir,sun),0)**4*(.4+1.4*(1-smoothstep(0,.6,s[0])))*day*s[2];
      light[k]+=trans*absorb*mix(tone*grade[k],fog[k],mixFog);
    }
    trans*=1-absorb;
    if(trans<.01)break;
  }
  const alpha=1-trans;
  return {alpha,rgb:alpha<.01?[0,0,0]:light.map(v=>Math.min(v/alpha,1)),extent:ex};
}
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];

/** Mirror of the WGSL upAt/worldAt for the always-curved layer: eye-relative point -> local up, and -> world (x, height, z) on the planet mapping. */
const upAt=(eyeY,rel)=>{const k=shellCurvatureAt(eyeY),n=[k*rel[0],1+k*(rel[1]+eyeY),k*rel[2]],l=Math.hypot(...n);return n.map(v=>v/l);};
export function worldAt(eye,rel) {
  const k=shellCurvatureAt(eye[1]),u=rel[1]+eye[1],hd2=rel[0]*rel[0]+rel[2]*rel[2],ry=1+k*u,qs=Math.sqrt(k*k*hd2+ry*ry);
  const h=(k*hd2+u*(2+k*u))/(qs+1),hd=Math.sqrt(hd2),thetaE=Math.atan2(k*hd,ry);
  if(hd<=1e-3)return [eye[0],h,eye[2]];
  const hx=[rel[0]/hd,rel[2]/hd],theta=thetaE/(k*PLANET_RADIUS),f=planetFrame(eye[0],eye[2]),s=Math.sin(theta),c=Math.cos(theta);
  const n=[s*hx[0],c,s*hx[1]],pv=[0,1,2].map(i=>f.east[i]*n[0]+f.up[i]*n[1]+f.south[i]*n[2]);
  const {lat,lon}=dirLatLon(pv),g=flatOf(lat,lon,WORLD_CENTRE,PLANET_RADIUS),b=shellBendFromCurvature(k),arc=thetaE/k;
  return [mix(eye[0]+hx[0]*arc,g[0],b),h,mix(eye[2]+hx[1]*arc,g[1],b)];
}
/** Ray extent through the curved layer: start, end, whether the end was cut by the span cap (not by leaving the layer), and the scene-depth soft edge. */
export function extent(eyeY,dirY,sceneDist,high,far=1e8) {
  const x=shellExtent(eyeY,dirY,shellCurvatureAt(eyeY),high,far),cap=x.s0+Math.max(tier(high).minSpan,SPAN_PER_DISTANCE*x.s0);
  let s1=x.s1,sEdge=1;
  if(sceneDist<1e8){sEdge=smoothstep(0,350,sceneDist-x.s0);s1=Math.min(s1,sceneDist);}
  const ns=x.live&&s1>x.s0&&sEdge>0?steps(high):0;
  return {s0:x.s0,s1,ns,sEdge,capped:x.sFull>cap&&s1===cap,cutK:smoothstep(0,.5,(x.sFull-cap)/Math.max(cap-x.s0,1))};
}

/** Mirror of the WGSL shellRoots: both distances where a ray from height `e` (direction y `dy`) meets the shell at altitude `y` of curvature k = 1/Re. */
export function shellRoots(e,dy,y,k) {
  const a=Math.max(k,1e-9),b=(1+k*e)*dy,cc=(e-y)*(2+k*(e+y)),disc=b*b-a*cc;
  if(disc<0)return [1e30,-1e30];
  const sq=Math.sqrt(disc);let q=-(b+(b>=0?sq:-sq));
  if(Math.abs(q)<1e-12)q=-1e-12;
  const t1=q/a,t2=cc/q;return [Math.min(t1,t2),Math.max(t1,t2)];
}
/** Mirror of the shell branch of the extent: first contiguous piece inside the outer shell and outside the inner one. */
export function shellExtent(eyeY,dirY,k,high,far=1e8) {
  const {ya,yb,down}=slab(high),O=shellRoots(eyeY,dirY,yb,k),I=shellRoots(eyeY,dirY,ya+down*(1-smoothstep(0,.12,dirY)),k);
  const G=shellRoots(eyeY,dirY,0,k),gHit=eyeY>0&&G[0]>0&&G[0]<=G[1];
  let s0=Math.max(O[0],0),sFull=gHit?Math.min(O[1],G[0]):O[1],live=O[0]<=O[1];
  if(I[0]<=I[1]){
    if(I[0]>s0){
      // An eye inside the layer looking slightly down leaves through the base, then re-enters farther out: keep the longer piece so the horizon bank does not vanish when the eye crosses the base.
      if(I[1]<sFull&&sFull-I[1]>.25*(Math.min(sFull,I[0])-s0))s0=I[1];else sFull=Math.min(sFull,I[0]);
    }else if(I[1]>s0)s0=I[1];
  }
  live=live&&sFull>s0;
  if(gHit)live=live&&s0<G[0];
  const cap=s0+Math.max(tier(high).minSpan,SPAN_PER_DISTANCE*s0),s1=Math.min(sFull,cap);
  return {s0,s1,sFull,live:live&&s1>s0&&s0<far};
}