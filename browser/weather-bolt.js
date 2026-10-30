// Lightning draw: up to MAX_BOLTS jagged bolts as camera-facing quad chains (positions built in the shader from a seed),
// plus a screen-wide additive flash veil. See weather-lightning.js for scheduling.
export const MAX_BOLTS=3,BOLT_SEGMENTS=24,BOLT_UNIFORM_BYTES=112;
/** right,up,look (aspect/near/far in w) | e = (veil flash, 0, top y, bottom y) | bolts[3] = (dx,dz,seed,flash). All positions relative to the eye. */
export function boltUniform(view,near,topY,bottomY,bolts,veil,out=new Float32Array(BOLT_UNIFORM_BYTES/4)) {
  out.fill(0);
  out.set([...view.right,view.aspect,...view.up,near,...view.look,200000,veil,0,topY,bottomY],0);
  bolts.slice(0,MAX_BOLTS).forEach((b,i)=>out.set([b.dx,b.dz,b.seed,b.flash],16+i*4));
  return out;
}
export const boltShader=`
struct U {right:vec4f,up:vec4f,look:vec4f,e:vec4f,b:array<vec4f,${MAX_BOLTS}>};
@group(0) @binding(0) var<uniform> u:U;
struct V {@builtin(position) clip:vec4f,@location(0) q:vec2f,@location(1) a:f32};
fn hs(n:f32,k:f32)->f32{return fract(sin(n*12.9898+k*78.233)*43758.5453);}
fn pt(b:vec4f,i:f32)->vec3f{
  let t=i/${BOLT_SEGMENTS.toFixed(1)};
  let env=sin(3.14159*t);
  let j=vec2f(hs(b.z,i)-.5,hs(b.z,i+50.0)-.5)*90.0*env;
  return vec3f(b.x+j.x,mix(u.e.z,u.e.w,t),b.y+j.y);
}
@vertex fn vs(@builtin(vertex_index) vi:u32,@builtin(instance_index) ii:u32)->V {
  var corners=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1));
  let q=corners[vi];var v:V;v.q=q;
  let bi=ii/${BOLT_SEGMENTS}u;let si=f32(ii%${BOLT_SEGMENTS}u);
  let b=u.b[bi];
  if(b.w<=0.0){v.a=0.0;v.clip=vec4f(2.0,2.0,2.0,1.0);return v;}
  let p0=pt(b,si);let p1=pt(b,si+1.0);
  let dist=length((p0+p1)*.5);
  var side=cross(p1-p0,u.look.xyz);
  if(length(side)<.001){side=u.right.xyz;}
  side=normalize(side);
  let w=max(1.2,dist*.0028);
  let pos=mix(p0,p1,q.y*.5+.5)+side*q.x*w;
  let z=dot(pos,u.look.xyz);let near=u.up.w;let far=u.look.w;
  v.a=b.w;
  v.clip=vec4f(dot(pos,u.right.xyz)/(0.55*u.right.w),dot(pos,u.up.xyz)/0.55,(z-near)*far/(far-near),z);
  return v;
}
@fragment fn fs(v:V)->@location(0) vec4f {
  let f=max(1.0-v.q.x*v.q.x,0.0);
  let a=clamp(v.a*f*f*1.4,0.0,1.0);
  return vec4f(vec3f(.82,.88,1.0)*a,a*.5);
}
struct F {@builtin(position) clip:vec4f};
@vertex fn fvs(@builtin(vertex_index) vi:u32)->F {
  var p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));var f:F;f.clip=vec4f(p[vi],0.0,1.0);return f;
}
@fragment fn ffs(f:F)->@location(0) vec4f {
  return vec4f(vec3f(.42,.48,.68)*u.e.x,0.0);
}`;
