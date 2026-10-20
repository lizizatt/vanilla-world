// Procedural cloud sheet: one camera-following quad, analytic wind swirl around a vortex centre, no textures or extra passes.
export const CLOUD_ALTITUDE_FACTOR=.8;
// Mt Hyjal summit height in yards, measured from the user's Kalimdor terrain (tile bounds near Hyjal, see README "Clouds").
export const HYJAL_SUMMIT=1971;
export const CLOUD_ALTITUDE=CLOUD_ALTITUDE_FACTOR*HYJAL_SUMMIT;
export const CLOUD_HALF_SIZE=60000;

export function cloudUniform(view,time,daylight,manifest,near,out=new Float32Array(24)) {
  const o=manifest.ocean;
  out.set([...view.eye,200000,...view.right,view.aspect,...view.up,time,...view.look,daylight,
    (o[0]+o[2])/2,(o[1]+o[3])/2,CLOUD_ALTITUDE,CLOUD_HALF_SIZE,near]);
  return out;
}

export const cloudShader=`
struct C {eye:vec4f,right:vec4f,up:vec4f,look:vec4f,cloud:vec4f,near:vec4f};
@group(0) @binding(0) var<uniform> c:C;
struct V {@builtin(position) clip:vec4f,@location(0) p:vec3f};
@vertex fn vs(@builtin(vertex_index) i:u32)->V {
  var q=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(1,1),vec2f(-1,-1),vec2f(1,1),vec2f(-1,1));
  let position=vec3f(c.eye.x+q[i].x*c.cloud.w,c.cloud.z,c.eye.z+q[i].y*c.cloud.w);
  let relative=position-c.eye.xyz;let z=dot(relative,c.look.xyz);
  var v:V;v.clip=vec4f(dot(relative,c.right.xyz)/(0.55*c.right.w),dot(relative,c.up.xyz)/0.55,
    (z*.97-c.near.x)*c.eye.w/(c.eye.w-c.near.x),z);
  v.p=position;return v;
}
fn hash(p:vec2f)->f32 {return fract(sin(dot(p,vec2f(127.1,311.7)))*43758.5453);}
fn vnoise(p:vec2f)->f32 {
  let i=floor(p);let f=fract(p);let s=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2f(1,0)),s.x),mix(hash(i+vec2f(0,1)),hash(i+vec2f(1,1)),s.x),s.y);
}
@fragment fn fs(v:V)->@location(0) vec4f {
  let centre=c.cloud.xy;let t=c.up.w;
  let d=v.p.xz-centre;let r=length(d);
  // Wind: tangential swirl that is fast near the centre, plus a slow inward drift; sampled by rotating the lookup point.
  let swirl=t*.03/(1.0+r/9000.0);
  let cs=cos(swirl);let sn=sin(swirl);
  let w=vec2f(d.x*cs-d.y*sn,d.x*sn+d.y*cs)*(1.0+t*.00002)+centre;
  let arm=.5+.5*sin(2.0*atan2(d.y,d.x)+r/6000.0-swirl*8.0);
  let q=w/2600.0;
  let n=.55*vnoise(q)+.3*vnoise(q*2.3+7.0)+.15*vnoise(q*5.1+3.0);
  let coverage=mix(.38,.8,exp(-r/32000.0))+.12*arm*exp(-r/20000.0);
  var alpha=smoothstep(1.0-coverage,1.0-coverage+.22,n);
  let eyeDistance=length(v.p-c.eye.xyz);
  alpha*=smoothstep(40.0,260.0,abs(c.eye.y-c.cloud.z))*(1.0-smoothstep(30000.0,c.cloud.w,eyeDistance))*.9;
  if(alpha<.01){discard;}
  let night=1.0-c.look.w;
  let lit=mix(vec3f(.95,.96,.98),vec3f(.62,.68,.78),smoothstep(.4,.9,n));
  let color=lit*mix(vec3f(1.0),vec3f(.2,.27,.5),night);
  let fog=mix(vec3f(.08,.15,.20),vec3f(.008,.016,.045),night);
  return vec4f(mix(color,fog,clamp(eyeDistance/150000.0,0.0,.93)),alpha);
}`;
