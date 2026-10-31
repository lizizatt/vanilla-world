// Wind-driven near-camera layers (design/wind.md): spray off wave crests (positioned on the shared Gerstner surface) and blowing dust/snow just above
// the ground. GPU-positioned instanced billboards in a world-anchored wrapping box, like the weather particles; no CPU simulation.
import {WIND as W,WIND_TUNE} from './wind-config.js';
import {windWGSL} from './wind-wgsl.js';
import {waveRenderShading} from './wave-render.js';

export const WIND_UNIFORM_BYTES=160;
/** Ground height lattice upload: meta vec4 (originX, originZ, step, n) + the n*n heights padded to vec4s. */
export const GRID_UNIFORM_FLOATS=4+Math.ceil(W.grid.n*W.grid.n/4)*4;
export function groundGridUniform(grid,out=new Float32Array(GRID_UNIFORM_FLOATS)) {out.set(grid.meta,0);out.set(grid.data,4);return out;}
/** KIND values of u.p.z. */
export const WIND_KIND={spray:0,dust:1,snow:2};
/**
 * Layout (vec4f x10): right+aspect, up+near, look+far, eye+windClock, (originX, originZ, groundY, light), (count, amount, kind, fade),
 * (driftX, driftZ, particleClock, layered 0|1), then the wind block (wind.js packWind). Everything but eye/drift is render-relative like the wave uniform.
 */
export function windParticleUniform(view,near,origin,windT,clock,ground,light,count,amount,kind,fade,drift,params,out=new Float32Array(WIND_UNIFORM_BYTES/4),layered=0) {
  out.set([...view.right,view.aspect,...view.up,near,...view.look,200000,view.eye[0],view.eye[1],view.eye[2],windT,origin[0],origin[1],ground,light,
    count,amount,kind,fade,drift[0],drift[1],clock,layered,...params]);
  return out;
}

/** Look-tuning block (vec4f x7, binding 2 of both shaders), packed from WIND_TUNE so the panel's changes apply live. Complements are computed here in f64 like the old literals. */
export const WIND_TUNE_FLOATS=28;
export function windTuneUniform(T=WIND_TUNE,out=new Float32Array(WIND_TUNE_FLOATS)) {
  out.set([T.groundHeight,T.dustAlpha,T.snowAlpha,T.clear, T.layerTop,T.layerAlpha,Math.max(1,Math.round(T.layerCount)),T.diag,
    T.sizeLength,T.sizeHeight,T.slopeFlat0,T.slopeFlat1, W.box.ground*T.distance,W.box.groundFar*T.distance,1-T.farShare,T.sway,
    T.sprayAlpha,T.sprayCrest0,T.sprayCrest1,T.spraySize, W.box.spray*T.sprayDistance,W.box.sprayFar*T.sprayDistance,1-T.sprayFarShare,T.sprayOn, T.sprayFull,0,0,0]);
  return out;
}

const f=x=>Number.isInteger(x)?x.toFixed(1):String(x);
const common=`
struct U {right:vec4f,up:vec4f,look:vec4f,eye:vec4f,org:vec4f,p:vec4f,drift:vec4f,w0:vec4f,w1:vec4f,w2:vec4f};
@group(0) @binding(0) var<uniform> u:U;
@group(0) @binding(2) var<uniform> tn:array<vec4f,7>;
struct V {@builtin(position) clip:vec4f,@location(0) q:vec2f,@location(1) a:f32,@location(2) col:vec3f};
${windWGSL()}
fn h3(n:u32)->vec3f{
  var x=n*747796405u+2891336453u;x=((x>>((x>>28u)+4u))^x)*277803737u;x=(x>>22u)^x;
  var y=x*1664525u+1013904223u;y^=y>>15u;y*=2246822519u;y^=y>>13u;
  var z=y*1664525u+1013904223u;z^=z>>16u;z*=3266489917u;z^=z>>15u;
  return vec3f(f32(x&0xffffffu),f32(y&0xffffffu),f32(z&0xffffffu))/16777216.0;
}
fn corner(vi:u32)->vec2f {
  var c=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1));
  return c[vi];
}
fn culled(q:vec2f)->V {var v:V;v.q=q;v.a=0.0;v.col=vec3f(0.0);v.clip=vec4f(2.0,2.0,2.0,1.0);return v;}
// Streak axis: along the wind but never edge-on to the camera.
fn streakSide(wd:vec2f)->vec3f {
  let s=vec3f(wd.x,0.0,wd.y);let d=dot(s,u.right.xyz);
  return normalize(u.right.xyz*tn[1].w+s*(.8*select(-1.0,1.0,d>=0.0)));
}
fn project(pos:vec3f,a:f32,col:vec3f,q:vec2f)->V {
  let z=dot(pos,u.look.xyz);let near=u.up.w;let far=u.look.w;
  var v:V;v.q=q;v.a=a;v.col=col;
  v.clip=vec4f(dot(pos,u.right.xyz)/(0.55*u.right.w),dot(pos,u.up.xyz)/0.55,(z-near)*far/(far-near),z);
  return v;
}
@fragment fn fs(v:V)->@location(0) vec4f {
  let f=max(1.0-dot(v.q,v.q),0.0);
  let a=v.a*f*f;
  return vec4f(v.col*a,a);
}`;

/** Spray: needs the wave bindings (uniform 5, mask 6, sampler 4) of the water pass. Particle count in u.p.x, amount (0..1) in u.p.y. */
export const sprayShader=`${common}
@group(0) @binding(4) var waveSampler:sampler;
${waveRenderShading}
@vertex fn vs(@builtin(vertex_index) vi:u32,@builtin(instance_index) ii:u32)->V {
  let q=corner(vi);
  if(f32(ii)>=u.p.x||wv.head.x<.5){return culled(q);}
  // The last share of the budget is the far ring: a wide box whose puffs grow with distance so spray still reads on distant crests.
  let far=f32(ii)>=floor(u.p.x*tn[5].z);
  let B=select(tn[5].x,tn[5].y,far);let h=h3(ii);
  let rel=(fract((h.xz*B-u.eye.xz)/B+.5)-.5)*B;
  let d=length(rel);let ds=1.0+d*.035;
  let eyeR=u.eye.xz-u.org.xy;let P=eyeR+rel;
  let wd=windAt(u.w0,u.w1,u.w2,P+u.org.xy,u.eye.w);
  let amt=smoothstep(tn[5].w,tn[6].x,wd.w);
  let m=waveAmp(P);
  if(amt<=0.0||m<.03){return culled(q);}
  let w=waveVertex(P,eyeR);
  // Crest tops only: height as a fraction of the local amplitude plus the steepness term must clear a threshold that eases down a little as the wind rises.
  // No general haze; the sea between crests emits nothing.
  let top=w.h/m+.5*w.crest;
  let pick=1.0-smoothstep(.25,.45+.35*amt,h.z);
  let emit=pick*smoothstep(tn[4].y-.12*amt,tn[4].z-.12*amt,top);
  if(emit<=0.0){return culled(q);}
  let sz=(.2+.1*min(m,4.0))*ds*tn[4].w;
  let a=fract(u.drift.z*.55+h.y);
  let rise=sz*.5*(1.0-(1.0-a)*(1.0-a));
  let blow=wd.xy*wd.z*a*.5;
  let c=vec3f(w.xz.x-eyeR.x+blow.x,w.h+.08+rise-u.eye.y,w.xz.y-eyeR.y+blow.y);
  let z0=dot(c,u.look.xyz);
  let L=sz*(.9+1.1*a)*(1.0+wd.z*.03);let H=sz*(.25+.4*a);
  let pos=c+streakSide(wd.xy)*q.x*L+u.up.xyz*q.y*H;
  let edge=1.0-smoothstep(.6,1.0,max(abs(rel.x),abs(rel.y))/(B*.5));
  let al=emit*amt*edge*smoothstep(0.0,.15,a)*(1.0-a)*tn[4].x*smoothstep(u.up.w,u.up.w*6.0,z0);
  return project(pos,al,vec3f(.86,.92,.95)*(.5+.5*u.org.w),q);
}`;

/** Blowing dust (kind 1) or snow (kind 2): a thin layer of streaks riding the wind just above u.org.z (the ground under the eye). */
export const groundShader=`${common}
struct G {m:vec4f,h:array<vec4f,${Math.ceil(W.grid.n*W.grid.n/4)}>};
@group(0) @binding(1) var<uniform> g:G;
fn gAt(i:i32,j:i32)->f32 {
  let n=${W.grid.n-1};let k=u32(clamp(j,0,n)*${W.grid.n}+clamp(i,0,n));
  return g.h[k/4u][k%4u];
}
// Local slope by central differences one lattice step either side (wind.js GroundGrid.slope is the twin).
fn slopeAt(p:vec2f)->f32 {
  let s=g.m.z;
  return length(vec2f(groundY(p+vec2f(s,0.0))-groundY(p-vec2f(s,0.0)),groundY(p+vec2f(0.0,s))-groundY(p-vec2f(0.0,s))))/(2.0*s);
}
// Bilinear terrain height from the CPU lattice (wind.js GroundGrid.sample is the twin).
fn groundY(p:vec2f)->f32 {
  let f=(p-g.m.xy)/g.m.z;let fl=floor(f);let t=f-fl;let i=i32(fl.x);let j=i32(fl.y);
  return mix(mix(gAt(i,j),gAt(i+1,j),t.x),mix(gAt(i,j+1),gAt(i+1,j+1),t.x),t.y);
}
@vertex fn vs(@builtin(vertex_index) vi:u32,@builtin(instance_index) ii:u32)->V {
  let q=corner(vi);
  if(f32(ii)>=u.p.x){return culled(q);}
  // The last share of the budget is the far ring: a wide box whose quads grow with distance so the layer reads out to the horizon of the lattice.
  let far=f32(ii)>=floor(u.p.x*tn[3].z);
  let B=select(tn[3].x,tn[3].y,far);let h=h3(ii);let snow=select(0.0,1.0,u.p.z>1.5);
  let rel=(fract((h.xz*B+u.drift.xy-u.eye.xz)/B+.5)-.5)*B;
  let d=length(rel);let ds=1.0+d*.045;
  let wd=windAt(u.w0,u.w1,u.w2,u.eye.xz+rel,u.eye.w);
  let lift=tn[0].x*mix(1.0,.8,snow)*(.35+.65*u.p.y);
  let L=mix(.4+wd.z*.02,.2+wd.z*.01,snow)*ds*tn[2].x;let H=mix(.1*(.6+.8*h.z),.06,snow)*(1.0+d*.012)*tn[2].y;
  // Centre sits above the local terrain by the quad's half height, the sway (always >= 0) and the lattice clearance (coarser far away), so nothing dips into the ground.
  let layered=u.drift.w>.5;let wp=u.eye.xz+rel;
  // Stacked layers (u.drift.w=1): the instance picks a layer riding a fixed fraction of the main layer's height instead of the random lift.
  // Layer k of n rides (k+1)/(n+1) of the layer top (n=3: .25 .5 .75).
  let ln=max(u32(tn[1].z),1u);
  let rise=select(h.y*lift,(f32(ii%ln)+1.0)/(f32(ln)+1.0)*tn[1].x+.03*h.y,layered);
  let y=groundY(wp)+tn[0].w+${f(W.grid.clearFar)}*d+H+rise+tn[3].w*(.5+.5*sin(u.drift.z*1.7+h.x*30.0))-u.eye.y;
  let c=vec3f(rel.x,y,rel.y);
  let z0=dot(c,u.look.xyz);
  let pos=c+streakSide(wd.xy)*q.x*L+u.up.xyz*q.y*H;
  let edge=1.0-smoothstep(.62,1.0,max(abs(rel.x),abs(rel.y))/(B*.5));
  let flat=1.0-smoothstep(tn[2].z,tn[2].w,slopeAt(wp));
  let al=flat*select(1.0,tn[1].y,layered)*edge*u.p.w*u.p.y*mix(tn[0].y*(.5+.5*h.z),tn[0].z,snow)*smoothstep(u.up.w,u.up.w*4.0,z0);
  let col=mix(vec3f(.72,.58,.40)*(.45+.55*u.org.w),vec3f(.95,.97,1.0)*(.55+.45*u.org.w),snow);
  return project(pos,al,col,q);
}`;
