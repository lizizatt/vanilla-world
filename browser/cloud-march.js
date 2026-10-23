// Pure-JS mirror of the cloud sheet ray march in clouds.js (slab extent, stepping, density, fade, fog blend, lighting), used by the
// Monte Carlo sweep in clouds-sweep.test.mjs with no GPU. Keep it consistent with the WGSL: the sweep test checks the shared constants and
// the extent/fade expressions appear verbatim in the shader. The High tier's 3D noise texture is replaced here by the Standard analytic
// noise (the texture is baked from the same kind of value noise), so High geometry (towers, 28 steps, light tap) is covered, its noise is not.
import {CLOUD_ALTITUDE,CLOUD_THICKNESS,CLOUD_HALF_SIZE,CLOUD_TOWER,MAELSTROM as M,sunDirection} from './clouds.js';

export const FADE_START=30000,FOG_RANGE=150000,MIN_SPAN=9000,SPAN_PER_DISTANCE=.3,MIN_DIR_Y=.0005;
export const steps=high=>high?28:8;
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
const mix=(a,b,t)=>a+(b-a)*t;
const fract=x=>x-Math.floor(x);
export const smoothstep=(a,b,x)=>{const t=clamp((x-a)/(b-a),0,1);return t*t*(3-2*t);};
const hash=(x,y)=>fract(Math.sin(x*127.1+y*311.7)*43758.5453);
function vnoise(x,y) {
  const ix=Math.floor(x),iy=Math.floor(y),fx=x-ix,fy=y-iy,sx=fx*fx*(3-2*fx),sy=fy*fy*(3-2*fy);
  return mix(mix(hash(ix,iy),hash(ix+1,iy),sx),mix(hash(ix,iy+1),hash(ix+1,iy+1),sx),sy);
}

/** Slab bounds in yards for a tier (High adds tower growth above and below). */
export function slab(high) {
  const up=high?CLOUD_TOWER.up:0,down=high?CLOUD_TOWER.down:0;
  return {ya:CLOUD_ALTITUDE-CLOUD_THICKNESS/2-down,yb:CLOUD_ALTITUDE+CLOUD_THICKNESS/2+up,up,down};
}

/** Ray/slab extent: start, end, whether the end was cut by the span cap (not by leaving the slab), and the scene-depth soft edge. */
export function extent(eyeY,dirY,sceneDist,high,far=CLOUD_HALF_SIZE,legacy=false) {
  const {ya,yb}=slab(high);
  if(legacy)return extentLegacy(eyeY,dirY,sceneDist,high,ya,yb);
  const dy=Math.abs(dirY)<MIN_DIR_Y?(dirY>=0?MIN_DIR_Y:-MIN_DIR_Y):dirY;
  const ta=(ya-eyeY)/dy,tb=(yb-eyeY)/dy;
  const s0=Math.max(0,Math.min(ta,tb)),full=Math.max(ta,tb),cap=s0+Math.max(MIN_SPAN,SPAN_PER_DISTANCE*s0);
  let s1=Math.min(full,cap),sEdge=1;
  if(sceneDist<1e8){sEdge=smoothstep(0,350,sceneDist-s0);s1=Math.min(s1,sceneDist);}
  const ns=s1>s0&&sEdge>0&&s0<far?steps(high):0;
  return {s0,s1,ns,sEdge,capped:full>cap&&s1===cap,cutK:smoothstep(0,.5,(full-cap)/Math.max(cap-s0,1))};
}

// The pre-fix behaviour (flat 9 km cap with a hard end, no march for near-horizontal rays), kept so the sweep can prove it detects those defects.
function extentLegacy(eyeY,dirY,sceneDist,high,ya,yb) {
  let s0=0,s1=0,ns=0,sEdge=1;
  if(Math.abs(dirY)>MIN_DIR_Y){
    const ta=(ya-eyeY)/dirY,tb=(yb-eyeY)/dirY;
    s0=Math.max(0,Math.min(ta,tb));s1=Math.min(Math.max(ta,tb),s0+Math.max(MIN_SPAN,SPAN_PER_DISTANCE*s0));
    if(sceneDist<1e8){sEdge=smoothstep(0,350,sceneDist-s0);s1=Math.min(s1,sceneDist);}
    if(s1>s0&&sEdge>0)ns=steps(high);
  }
  return {s0,s1,ns,sEdge,capped:false};
}

/** Density at a world position: [body, storm, height fraction]; `coverage` may be forced to sweep storm values. */
export function density(pos,t,high,centre=[0,0],coverageOverride) {
  const {ya,up,down}=slab(high);
  const dx=pos[0]-centre[0],dz=pos[2]-centre[1],r=Math.hypot(dx,dz);
  const turn=t*M.drift*Math.exp(-r/M.radius),cs=Math.cos(turn),sn=Math.sin(turn);
  const wx=dx*cs-dz*sn,wz=dx*sn+dz*cs;
  const a=Math.atan2(-dz,dx);
  const arm=smoothstep(.2,.8,.5+.5*Math.cos(M.arms*(a+M.pitch*Math.log(Math.max(r,1)/1000)-t*M.spin)));
  const storm=Math.exp(-r/M.radius);
  const wall=Math.exp(-(((r-M.wallRadius)/(M.wallRadius*.35))**2));
  const eye=smoothstep(M.eyeRadius,M.eyeRadius*1.5,r);
  const coverage=coverageOverride??clamp(mix(.4,mix(.1,.95,arm),storm)+.6*wall,0,.95)*eye;
  const grow=smoothstep(.45,.95,coverage)*mix(.4,1,vnoise(wx/3800+t*.012,wz/3800-t*.009));
  const base=CLOUD_ALTITUDE-CLOUD_THICKNESS/2-down*grow;
  const hf=clamp((pos[1]-base)/(CLOUD_THICKNESS+(up+down)*grow),0,1);
  const qx=wx/2600,qz=wz/2600;
  let n=.55*vnoise(qx,qz)+.3*vnoise(qx*2.3+7,qz*2.3+7)+.15*vnoise(qx*5.1+3,qz*5.1+3);
  n=n*.78+.22*vnoise(wx/650+hf*3.1,wz/650+hf*1.7);
  const top=(n-(1-coverage))*(2.2+1.6*wall);
  const body=smoothstep(0,.3,top-hf*.9)*smoothstep(0,.1,hf+.05);
  return [body,storm*(.55+.45*smoothstep(M.eyeRadius,M.wallRadius*2,r)),hf,ya];
}

/**
 * Marches one ray exactly like the fragment shader's sheet branch. Returns {alpha, rgb (premultiplied-free colour), extent}.
 * `o`: {eye:[x,y,z], dir:[x,y,z] (unit), t, high, time (Light.dbc half-minutes), centre, coverage, sceneDist, jitter (0..1), night (0..1)}.
 */
export function march(o) {
  const {eye,dir,t=0,high=false,time=1440,centre=[0,0],coverage,sceneDist=1e9,jitter=.5,night=0,legacy=false}=o;
  const ex=extent(eye[1],dir[1],sceneDist,high,CLOUD_HALF_SIZE,legacy);
  if(!ex.ns)return {alpha:0,rgb:[0,0,0],extent:ex};
  const sun=sunDirection(time),day=smoothstep(-.1,.25,sun[1]),ns=ex.ns,ss=(ex.s1-ex.s0)/steps(high);
  const grade=[1-.8*night,1-.73*night,1-.5*night],fog=[.08*(1-night),.15*(1-night),.2*(1-night)];
  let trans=1;const light=[0,0,0];
  for(let i=0;i<ns;i++) {
    const ts=ex.s0+ss*(i+jitter),pos=[eye[0]+dir[0]*ts,eye[1]+dir[1]*ts,eye[2]+dir[2]*ts];
    const s=density(pos,t,high,centre,coverage);
    if(s[0]<=.001)continue;
    const tail=ex.capped?1-ex.cutK*smoothstep(.55,1,(ts-ex.s0)/(ex.s1-ex.s0)):1;
    const w=(1-smoothstep(FADE_START,CLOUD_HALF_SIZE,ts))*.96*ex.sEdge*tail;
    const absorb=(1-Math.exp(-s[0]*ss*.008))*w;
    let shade=1;
    if(high){const sd=density([pos[0]+sun[0]*ss*2.5,pos[1]+sun[1]*ss*2.5,pos[2]+sun[2]*ss*2.5],t,high,centre,coverage)[0];shade=mix(mix(.65,1,Math.exp(-sd*2)),1,smoothstep(.7,1,s[2]))*(1+.8*Math.max(dot(dir,sun),0)**6);}
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
