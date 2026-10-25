// Projected craft shadow: one fullscreen pass (like clouds) reads the finished scene depth, rebuilds each pixel's world
// position and darkens it where it lies under the craft along the sun direction. Works on terrain, water, scenery
// and a craft at altitude without any ground probe or shadow map.
export const SHADOW={maxHeight:500,sun:[-.35,1,-.25],strength:.5,fallbackHalf:[5,3]};

/** Half length/width in yards from a model's bounding size [x,y,z] (longer horizontal axis is the length). */
export const shadowHalf=size=>Array.isArray(size)&&size.every(Number.isFinite)
  ?[Math.max(size[0],size[1])/2,Math.min(size[0],size[1])/2]:SHADOW.fallbackHalf;

/** Uniform for the shadow shader; state is the worker telemetry (global x,y,z,yaw,...). */
export function shadowUniform(view,state,half,near,strength=SHADOW.strength,out=new Float32Array(36)) {
  const yaw=state[3],n=Math.hypot(...SHADOW.sun),s=SHADOW.sun;
  out.set([...view.eye,200000,...view.right,view.aspect,...view.up,0,...view.look,0,near,0,0,0,
    state[0],state[1],state[2],strength,-Math.sin(yaw),-Math.cos(yaw),half[0],half[1],s[0]/n,s[1]/n,s[2]/n,SHADOW.maxHeight]);
  return out;
}

export const shadowShader=`
struct S {eye:vec4f,right:vec4f,up:vec4f,look:vec4f,near:vec4f,p:vec4f,f:vec4f,sun:vec4f};
@group(0) @binding(0) var<uniform> c:S;
@group(0) @binding(1) var sceneDepth:texture_depth_2d;
struct V {@builtin(position) clip:vec4f,@location(0) ndc:vec2f};
@vertex fn vs(@builtin(vertex_index) i:u32)->V {
  var q=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
  var v:V;v.clip=vec4f(q[i],0.5,1);v.ndc=q[i];return v;
}
@fragment fn fs(v:V)->@location(0) vec4f {
  let d=textureLoad(sceneDepth,vec2i(v.clip.xy),0);
  if(d>=1.0){discard;}
  let dir=normalize(c.look.xyz+c.right.xyz*v.ndc.x*.55*c.right.w+c.up.xyz*v.ndc.y*.55);
  let dist=c.near.x*c.eye.w/(c.eye.w-d*(c.eye.w-c.near.x))/max(dot(dir,c.look.xyz),.05);
  let w=c.eye.xyz+dir*dist;
  let h=c.p.y-w.y;
  if(h<-1.0||h>c.sun.w){discard;}
  let hh=max(h,0.0);
  // Slide the shadow centre along the sun direction by the height above this surface.
  let centre=c.p.xz-c.sun.xz/c.sun.y*hh;
  let o=w.xz-centre;
  let along=dot(o,c.f.xy);let across=o.x*c.f.y-o.y*c.f.x;
  let soft=1.0+hh*.03;
  let e=length(vec2f(along/(c.f.z*1.1),across/(c.f.w*1.1)))/soft;
  let a=(1.0-smoothstep(.35,1.0+hh*.01,e))*c.p.w*(1.0-smoothstep(0.0,c.sun.w,hh))/soft;
  if(a<.004){discard;}
  return vec4f(0,0,0,a);
}`;

/** Shadow direction/strength from the sim sun: fades out as the sun sets, no shadow at night. */
export function sunShadow(sun) {
  const fade=Math.min(1,Math.max(0,sun[1]*5));
  return {sun:[sun[0],Math.max(sun[1],.15),sun[2]],strength:SHADOW.strength*fade};
}
