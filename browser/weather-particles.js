// Near-camera precipitation: a world-anchored wrapping box of GPU-positioned streaks (rain) or flakes (snow). No CPU simulation.
import {WEATHER as W} from './weather-config.js';

export const PARTICLE_UNIFORM_BYTES=96;
/** right,up,look carry aspect/near/far in w (same as the billboard shader); then eye+time, camera velocity+count, params. */
export function weatherParticleUniform(view,near,eye,time,vel,count,params,out=new Float32Array(PARTICLE_UNIFORM_BYTES/4)) {
  out.set([...view.right,view.aspect,...view.up,near,...view.look,200000,eye[0],eye[1],eye[2],time,vel[0],vel[1],vel[2],count,...params]);
  return out;
}

/** params: level (0-1 intensity), snowMix (0 rain, 1 snow), fade (above-cloud-base fade), flash. */
export const particleShader=`
struct U {right:vec4f,up:vec4f,look:vec4f,eye:vec4f,vel:vec4f,p:vec4f};
@group(0) @binding(0) var<uniform> u:U;
struct V {@builtin(position) clip:vec4f,@location(0) q:vec2f,@location(1) a:f32,@location(2) snow:f32};
fn h3(n:u32)->vec3f{
  var x=n*747796405u+2891336453u;x=((x>>((x>>28u)+4u))^x)*277803737u;x=(x>>22u)^x;
  var y=x*1664525u+1013904223u;y^=y>>15u;y*=2246822519u;y^=y>>13u;
  var z=y*1664525u+1013904223u;z^=z>>16u;z*=3266489917u;z^=z>>15u;
  return vec3f(f32(x&0xffffffu),f32(y&0xffffffu),f32(z&0xffffffu))/16777216.0;
}
@vertex fn vs(@builtin(vertex_index) vi:u32,@builtin(instance_index) ii:u32)->V {
  var corners=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1));
  let q=corners[vi];
  var v:V;v.q=q;v.a=0.0;v.snow=u.p.y;
  let S=${W.near.box.toFixed(1)};let level=u.p.x;
  let h=h3(ii);
  // Instances above the live count (density follows local intensity) collapse to nothing.
  if(f32(ii)>=u.vel.w*level){v.clip=vec4f(2.0,2.0,2.0,1.0);return v;}
  let snow=u.p.y;
  let fall=mix(${W.near.rainSpeed.toFixed(1)},${W.near.snowSpeed.toFixed(1)},snow)*(.85+.3*h.x);
  let sway=snow*vec3f(sin(u.eye.w*.9+h.x*40.0),0.0,cos(u.eye.w*.7+h.z*40.0))*2.0;
  let q0=h*S-vec3f(0.0,fall*u.eye.w,0.0)+sway;
  let rel=(fract((q0-u.eye.xyz)/S+.5)-.5)*S;
  let z0=dot(rel,u.look.xyz);
  // Camera-relative velocity of the drop, so streaks smear along the real apparent motion.
  let vel=vec3f(0.0,-fall,0.0)-u.vel.xyz;
  let a=rel;let b=rel+vel*mix(${W.near.streak.toFixed(3)},.012,snow);
  let t=q.y*.5+.5;
  let along=mix(a,b,t);
  var side=cross(normalize(vel),u.look.xyz);
  if(length(side)<.05){side=u.right.xyz;}
  side=normalize(side);
  let wdt=mix(${W.near.rainWidth.toFixed(3)},${W.near.snowSize.toFixed(3)},snow)*(.7+.6*h.y);
  var pos=along+side*q.x*wdt;
  if(snow>.5){pos=rel+(u.right.xyz*q.x+u.up.xyz*q.y)*wdt;}
  let z=dot(pos,u.look.xyz);let near=u.up.w;let far=u.look.w;
  let edge=1.0-smoothstep(.62,1.0,max(abs(rel.x),max(abs(rel.y),abs(rel.z)))/(S*.5));
  v.a=edge*u.p.z*smoothstep(near,near*4.0,z0)*mix(.42,.9,snow);
  v.clip=vec4f(dot(pos,u.right.xyz)/(0.55*u.right.w),dot(pos,u.up.xyz)/0.55,(z-near)*far/(far-near),z);
  return v;
}
@fragment fn fs(v:V)->@location(0) vec4f {
  let r=v.q;
  var f=max(1.0-r.x*r.x,0.0);
  if(v.snow>.5){f=max(1.0-dot(r,r),0.0);f=f*f;}
  let rain=vec3f(.62,.68,.76);let snow=vec3f(.95,.97,1.0);
  let col=mix(rain,snow,v.snow)*(.55+.45*u.p.w);
  let a=v.a*f;
  return vec4f(col*a,a);
}`;
