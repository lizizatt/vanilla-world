// Wind-driven near-camera layers (design/wind.md): spray off wave crests (positioned on the shared Gerstner surface) and blowing dust/snow just above
// the ground. GPU-positioned instanced billboards in a world-anchored wrapping box, like the weather particles; no CPU simulation.
import {WIND as W} from './wind-config.js';
import {windWGSL} from './wind-wgsl.js';
import {waveRenderShading} from './wave-render.js';

export const WIND_UNIFORM_BYTES=160;
/** KIND values of u.p.z. */
export const WIND_KIND={spray:0,dust:1,snow:2};
/**
 * Layout (vec4f x10): right+aspect, up+near, look+far, eye+windClock, (originX, originZ, groundY, light), (count, amount, kind, fade),
 * (driftX, driftZ, particleClock, 0), then the wind block (wind.js packWind). Everything but eye/drift is render-relative like the wave uniform.
 */
export function windParticleUniform(view,near,origin,windT,clock,ground,light,count,amount,kind,fade,drift,params,out=new Float32Array(WIND_UNIFORM_BYTES/4)) {
  out.set([...view.right,view.aspect,...view.up,near,...view.look,200000,view.eye[0],view.eye[1],view.eye[2],windT,origin[0],origin[1],ground,light,
    count,amount,kind,fade,drift[0],drift[1],clock,0,...params]);
  return out;
}

const f=x=>Number.isInteger(x)?x.toFixed(1):String(x);
const common=`
struct U {right:vec4f,up:vec4f,look:vec4f,eye:vec4f,org:vec4f,p:vec4f,drift:vec4f,w0:vec4f,w1:vec4f,w2:vec4f};
@group(0) @binding(0) var<uniform> u:U;
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
  return normalize(u.right.xyz*.6+s*(.8*select(-1.0,1.0,d>=0.0)));
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
  let B=${f(W.box.spray)};let h=h3(ii);
  let rel=(fract((h.xz*B-u.eye.xz)/B+.5)-.5)*B;
  let eyeR=u.eye.xz-u.org.xy;let P=eyeR+rel;
  let wd=windAt(u.w0,u.w1,u.w2,P+u.org.xy,u.eye.w);
  let amt=smoothstep(${f(W.spray.on)},${f(W.spray.full)},wd.w);
  let m=waveAmp(P);
  if(amt<=0.0||m<.03){return culled(q);}
  let w=waveVertex(P,eyeR);
  // Crest tops: height as a fraction of the local amplitude (the components sum to 1), plus the steepness term; stronger wind lowers the bar.
  let top=w.h/m+.5*w.crest;
  let emit=smoothstep(mix(.7,.25,amt),mix(1.0,.55,amt),top);
  if(emit<=0.0){return culled(q);}
  let sz=.7+.5*min(m,4.0);
  let a=fract(u.drift.z*.55+h.y);
  let rise=sz*.7*(1.0-(1.0-a)*(1.0-a));
  let blow=wd.xy*wd.z*a*.6;
  let c=vec3f(w.xz.x-eyeR.x+blow.x,w.h+.15+rise-u.eye.y,w.xz.y-eyeR.y+blow.y);
  let z0=dot(c,u.look.xyz);
  let L=sz*(.9+1.1*a)*(1.0+wd.z*.05);let H=sz*(.35+.6*a);
  let pos=c+streakSide(wd.xy)*q.x*L+u.up.xyz*q.y*H;
  let edge=1.0-smoothstep(.6,1.0,max(abs(rel.x),abs(rel.y))/(B*.5));
  let al=emit*amt*edge*smoothstep(0.0,.15,a)*(1.0-a)*.9*smoothstep(u.up.w,u.up.w*6.0,z0);
  return project(pos,al,vec3f(.86,.92,.95)*(.5+.5*u.org.w),q);
}`;

/** Blowing dust (kind 1) or snow (kind 2): a thin layer of streaks riding the wind just above u.org.z (the ground under the eye). */
export const groundShader=`${common}
@vertex fn vs(@builtin(vertex_index) vi:u32,@builtin(instance_index) ii:u32)->V {
  let q=corner(vi);
  if(f32(ii)>=u.p.x){return culled(q);}
  let B=${f(W.box.ground)};let h=h3(ii);let snow=select(0.0,1.0,u.p.z>1.5);
  let rel=(fract((h.xz*B+u.drift.xy-u.eye.xz)/B+.5)-.5)*B;
  let wd=windAt(u.w0,u.w1,u.w2,u.eye.xz+rel,u.eye.w);
  let lift=${f(W.box.height)}*mix(1.0,.75,snow)*(.3+.7*u.p.y);
  let y=u.org.z+.12+h.y*lift+.25*sin(u.drift.z*1.7+h.x*30.0)-u.eye.y;
  let c=vec3f(rel.x,y,rel.y);
  let z0=dot(c,u.look.xyz);
  let L=mix(.9+wd.z*.07,.3+wd.z*.03,snow);let H=mix(.45*(.6+.8*h.z),.12,snow);
  let pos=c+streakSide(wd.xy)*q.x*L+u.up.xyz*q.y*H;
  let edge=1.0-smoothstep(.62,1.0,max(abs(rel.x),abs(rel.y))/(B*.5));
  let al=edge*u.p.w*u.p.y*mix(.2*(.5+.5*h.z),.65,snow)*smoothstep(u.up.w,u.up.w*4.0,z0);
  let col=mix(vec3f(.72,.58,.40)*(.45+.55*u.org.w),vec3f(.95,.97,1.0)*(.55+.45*u.org.w),snow);
  return project(pos,al,col,q);
}`;
