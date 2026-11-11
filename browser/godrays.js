// Screen-space crepuscular rays (GPU Gems 3 ch.13 style), OFF by default (settings.godrays 'off'|'low'|'high').
// One additive fullscreen pass after the clouds. No offscreen target: the occlusion mask is derived in-shader from the
// scene depth (depth>=1 = open sky), so the cost is N depth loads per pixel along the pixel->sun screen ray.
export const GODRAYS={samples:{low:16,high:40},strength:{low:.55,high:.7},density:.95,decay:.965,fovHalf:.55};

export const godraysTier=v=>v==='low'||v==='high'?v:'off';

/** Sun brightness/colour from its elevation (y): warm and strongest low on the horizon, none below it. */
export function godraySun(sunY,wet=0) {
  const lift=Math.min(1,Math.max(0,(sunY+.02)/.14)),k=Math.min(1,Math.max(0,sunY/.4));
  const gain=lift*lift*(3-2*lift)*(1-.8*Math.min(1,Math.max(0,wet)));
  return {gain,colour:[1,.55+.37*k,.25+.5*k]};
}

/** Uniform: right(+aspect) up look sun(+gain) colour(+samples) screen(w,h,decay,density). */
export function godrayUniform(view,sun,tier,wet,width,height,out=new Float32Array(24)) {
  const n=Math.hypot(...sun)||1,g=godraySun(sun[1]/n,wet);
  out.set([...view.right,view.aspect,...view.up,0,...view.look,0,sun[0]/n,sun[1]/n,sun[2]/n,g.gain*GODRAYS.strength[tier],
    ...g.colour,GODRAYS.samples[tier],width,height,GODRAYS.decay,GODRAYS.density]);
  return out;
}

export const godrayShader=`
struct G {right:vec4f,up:vec4f,look:vec4f,sun:vec4f,col:vec4f,scr:vec4f};
@group(0) @binding(0) var<uniform> g:G;
@group(0) @binding(1) var sceneDepth:texture_depth_2d;
struct V {@builtin(position) clip:vec4f,@location(0) ndc:vec2f};
@vertex fn vs(@builtin(vertex_index) i:u32)->V {
  var q=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
  var v:V;v.clip=vec4f(q[i],0.5,1);v.ndc=q[i];return v;
}
@fragment fn fs(v:V)->@location(0) vec4f {
  let z=dot(g.sun.xyz,g.look.xyz);
  let facing=smoothstep(.08,.5,z);
  if(facing<=0.0||g.sun.w<=0.001){discard;}
  let sunNdc=vec2f(dot(g.sun.xyz,g.right.xyz)/(z*${GODRAYS.fovHalf}*g.right.w),dot(g.sun.xyz,g.up.xyz)/(z*${GODRAYS.fovHalf}));
  var toSun=sunNdc-v.ndc;
  let dist=length(toSun);
  // Cap the march at ~1 screen so a far off-screen sun doesn't pin every sample to the edge (vertical banding).
  toSun*=min(1.0,1.2/max(dist,1e-4));
  let n=i32(g.col.w);
  let dim=vec2f(g.scr.xy);
  let stepPx=vec2f(toSun.x,-toSun.y)*.5*dim*g.scr.w/f32(n);
  let jitter=fract(52.9829189*fract(dot(v.clip.xy,vec2f(.06711056,.00583715))));
  var p=v.clip.xy+stepPx*jitter;
  var w=1.0;var sum=0.0;
  for(var i=0;i<n;i++){
    let c=vec2i(clamp(p,vec2f(0),dim-1.0));
    if(textureLoad(sceneDepth,c,0)>=1.0){sum+=w;}
    w*=g.scr.z;p+=stepPx;
  }
  let shaft=sum/f32(n);
  let near=1.0-.75*smoothstep(0.0,2.5,dist);
  let a=shaft*near*facing*g.sun.w;
  return vec4f(g.col.rgb*a,0.0);
}`;
