// Distant precipitation (design/weather.md option A, phase 3): shafts and curtains under the rendered cloud, drawn after the cloud pass.
// The CPU polar grid (weather.js) says where the rain is; this marches each pixel's ray below the cloud base and accumulates streaky, fog-tinted extinction,
// clipped by scene depth. It reads the same uniform block as the cloud shader (so the camera and flow frame agree) plus the grid.
import {flowWGSL} from './cloud-flow.js';
import {WEATHER as W} from './weather-config.js';

export const CURTAIN_UNIFORM_BYTES=256+W.polar.azimuth*W.polar.rings*4;
const f=x=>Number.isInteger(x)?x.toFixed(1):String(x);

/** Packs the camera block (the cloud uniform, 60 floats) with the weather extras and the polar grid. wx = (snow 0..1, level 0..1, strength 0..1, base fade). */
export function curtainUniform(cloud,polar,wx,out=new Float32Array(CURTAIN_UNIFORM_BYTES/4)) {
  out.set(cloud.subarray(0,60));out.set(wx,60);out.set(polar,64);return out;
}
/** 0..1 fade for the curtain as the eye climbs into and above the cloud base: full below (base-fade), gone at the base. */
export const curtainFade=(eyeY,base)=>Math.min(Math.max((base-eyeY)/W.curtain.fade,0),1);

export const curtainShader=`
struct C {eye:vec4f,right:vec4f,up:vec4f,look:vec4f,cloud:vec4f,near:vec4f,tint:vec4f,fog:vec4f,sun:vec4f,sunCol:vec4f,cloud2:vec4f,bend:vec4f,fe:vec4f,fu:vec4f,fs:vec4f,wx:vec4f,grid:array<vec4f,${W.polar.azimuth*W.polar.rings/4}>};
@group(0) @binding(0) var<uniform> c:C;
@group(0) @binding(1) var sceneDepth:texture_depth_2d;
${flowWGSL()}
struct V {@builtin(position) clip:vec4f,@location(0) ndc:vec2f};
@vertex fn vs(@builtin(vertex_index) i:u32)->V {
  var q=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
  var v:V;v.clip=vec4f(q[i],0.5,1);v.ndc=q[i];return v;
}
const AZ=${W.polar.azimuth};
const RINGS=${W.polar.rings};
const R_NEAR=${f(W.polar.near)};
const R_FAR=${f(W.polar.far)};
fn gridAt(a:i32,k:i32)->f32 {
  let ai=((a%AZ)+AZ)%AZ;let ki=clamp(k,0,RINGS-1);
  let idx=ai*RINGS+ki;return c.grid[idx>>2u][idx&3];
}
// Bilinear over azimuth (wraps) and log radius.
fn precipAt(x:f32,z:f32)->f32 {
  let r=length(vec2f(x,z));
  if(r>R_FAR){return 0.0;}
  let fa=(atan2(z,x)/6.2831853+1.0)*f32(AZ);
  let fk=clamp(log(max(r,R_NEAR)/R_NEAR)/log(R_FAR/R_NEAR)*f32(RINGS-1),0.0,f32(RINGS-1));
  let a0=i32(floor(fa));let k0=i32(floor(fk));let u=fract(fa);let w=fract(fk);
  return mix(mix(gridAt(a0,k0),gridAt(a0+1,k0),u),mix(gridAt(a0,k0+1),gridAt(a0+1,k0+1),u),w);
}
@fragment fn fs(v:V)->@location(0) vec4f {
  let strength=c.wx.z;
  if(strength<=0.001){return vec4f(0.0);}
  let dir=normalize(c.look.xyz+c.right.xyz*v.ndc.x*.55*c.right.w+c.up.xyz*v.ndc.y*.55);
  let d=textureLoad(sceneDepth,vec2i(v.clip.xy),0);
  var sceneDist=1e9;
  if(d<1.0){sceneDist=c.near.x*c.eye.w/(c.eye.w-d*(c.eye.w-c.near.x))/max(dot(dir,c.look.xyz),.05);}
  let base=c.cloud.z-${f(W.curtain.baseDrop)};
  let eyeY=c.eye.y;
  var sEnd=min(sceneDist,R_FAR);
  // The ray leaves the sub-cloud volume when it climbs through the base.
  if(dir.y>0.0001){sEnd=min(sEnd,(base-eyeY)/dir.y);}
  if(sEnd<=${f(W.curtain.start)}){return vec4f(0.0);}
  let t=c.up.w;let night=1.0-c.look.w;let snow=c.wx.x;
  let game=c.tint.w>.5;
  let fog=select(mix(vec3f(.08,.15,.20),vec3f(.008,.016,.045),night),c.fog.rgb,game);
  let jitter=fract(52.9829189*fract(dot(v.clip.xy,vec2f(.06711056,.00583715))));
  let ratio=sEnd/${f(W.curtain.start)};
  var T=1.0;var acc=vec3f(0.0);
  for(var i=0;i<${W.curtain.steps};i++){
    let u=(f32(i)+jitter)/${f(W.curtain.steps)};
    let s=${f(W.curtain.start)}*pow(ratio,u);
    let ds=s*(pow(ratio,1.0/${f(W.curtain.steps)})-1.0);
    let p=c.eye.xyz+dir*s;
    let P=precipAt(p.x-c.eye.x,p.z-c.eye.z);
    if(P<.02){continue;}
    let drop=base-p.y;
    let fall=mix(${f(W.curtain.fall[0])},${f(W.curtain.fall[1])},smoothstep(.3,.8,P));
    let shaft=exp(-max(drop,0.0)/fall);
    let sx=max(${f(W.curtain.streakXZ)},s*.04);
    let streak=mix(.12,1.0,smoothstep(.25,.75,vnoise3(vec3f(p.x/sx,p.y/${f(W.curtain.streakY)}+t*.8*(1.0-.75*snow),p.z/sx))));
    let k=ds*P*shaft*streak*${f(W.curtain.density)};
    let a=1.0-exp(-k);
    let lum=mix(.55,1.0,c.look.w)*(1.0-.35*P);
    let tone=mix(fog*.7+vec3f(.18,.2,.23)*lum,vec3f(.86,.9,.96)*mix(.35,1.0,c.look.w),snow);
    acc+=T*a*tone;T*=1.0-a;
    if(T<.02){break;}
  }
  // Fade with the camera climbing into the base, and never fully opaque so the cloud above reads through.
  let alpha=min(1.0-T,${f(W.curtain.maxAlpha)})*strength;
  let scale=select(0.0,alpha/max(1.0-T,1e-4),1.0-T>1e-4);
  return vec4f(acc*scale,alpha);
}
`;
