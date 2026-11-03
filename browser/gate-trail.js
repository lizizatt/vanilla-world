// Breadcrumb trail toward the next gate (design/waypoint-arrow.md, concept C). Pure math plus the chevron shader; no DOM or GPU.
// Vectors are in the craft's local frame (x east/right, y up, z south; forward at yaw is (-sin yaw, 0, -cos yaw)), yards.
export const TRAIL_CAP=70;       // yd of trail drawn however far the gate is: a far gate is just a direction
export const TRAIL_SPACING=7;    // yd between chevrons
export const TRAIL_START=5;      // yd ahead of the craft where the trail begins
export const GATE_CLEAR=8;       // trail stops this far short of a near gate
export const MAX_CHEVRONS=14;
export const CHEVRON_FLOATS=12;  // pos.xyz size | dir.xyz alpha | style 0 amber, 1 behind (cyan, double), 2 final (checkered) + 3 spare

const len=v=>Math.hypot(v[0],v[1],v[2]);
const mix=(a,b,t)=>[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t];
const unit=(v,fallback)=>{const n=len(v);return n>1e-9&&Number.isFinite(n)?[v[0]/n,v[1]/n,v[2]/n]:fallback;};

/**
 * Chevrons from just ahead of the craft toward the gate. `delta` is the craft->gate vector (any distance; only its direction and, up to
 * the cap, its length matter, so hundreds of thousands of yd give the same bounded geometry as 70). The curve leaves along the craft's
 * heading and bends toward the gate (a U-turn to the gate's side when it is behind); `straight` (orbit, other body) is a plain line.
 * Returns [] when there is nothing to show. alpha fades with distance along the trail and, unless `reduced`, pulses.
 */
export function trailChevrons({delta,yaw,behind=false,straight=false,final=false,time=0,reduced=false,cap=TRAIL_CAP,spacing=TRAIL_SPACING}) {
  if(!Array.isArray(delta)||delta.length!==3||!delta.every(Number.isFinite))return [];
  const range=len(delta),reach=Math.min(range-GATE_CLEAR,cap);
  if(!(reach>=TRAIL_START))return [];
  const d=unit(delta,[0,0,-1]),f=[-Math.sin(yaw),0,-Math.cos(yaw)],right=[Math.cos(yaw),0,-Math.sin(yaw)];
  const p0=[f[0]*TRAIL_START,-.4,f[2]*TRAIL_START],p2=[d[0]*reach,d[1]*reach,d[2]*reach];
  let p1;
  if(straight){p0.splice(0,3,d[0]*TRAIL_START,d[1]*TRAIL_START,d[2]*TRAIL_START);p1=mix(p0,p2,.5);}
  else{
    if(behind){const side=d[0]*right[0]+d[1]*right[1]+d[2]*right[2]>=0?1:-1;p1=[(f[0]+right[0]*side)*.7*reach,p2[1]*.5,(f[2]+right[2]*side)*.7*reach];}
    else p1=[p0[0]+f[0]*reach*.5,p2[1]*.5,p0[2]+f[2]*reach*.5];
  }
  const count=Math.max(1,Math.min(MAX_CHEVRONS,Math.floor(reach/spacing))),out=[];
  for(let i=0;i<count;i++) {
    const u=(i+1)/count,a=mix(p0,p1,u),b=mix(p1,p2,u),at=mix(a,b,u);
    const dir=unit([2*(b[0]-a[0]),2*(b[1]-a[1]),2*(b[2]-a[2])],d);
    let alpha=.95-.75*u;
    if(!reduced)alpha*=behind?(Math.sin(time*9)>0?1:.45):.75+.25*Math.sin(time*6-i*.9);
    out.push({at,dir,size:1.4+.05*len(at),alpha:Math.max(0,Math.min(1,alpha)),style:final&&i===count-1?2:behind?1:0});
  }
  return out;
}

/** Writes chevrons into out (CHEVRON_FLOATS each) with positions made eye-relative by `origin` (craft minus eye); returns the count. */
export function packChevrons(chevrons,origin,out) {
  const n=Math.min(chevrons.length,Math.floor(out.length/CHEVRON_FLOATS));
  for(let i=0;i<n;i++) {
    const c=chevrons[i],o=i*CHEVRON_FLOATS;
    out[o]=c.at[0]+origin[0];out[o+1]=c.at[1]+origin[1];out[o+2]=c.at[2]+origin[2];out[o+3]=c.size;
    out[o+4]=c.dir[0];out[o+5]=c.dir[1];out[o+6]=c.dir[2];out[o+7]=c.alpha;
    out[o+8]=c.style;out[o+9]=out[o+10]=out[o+11]=0;
  }
  return n;
}

/** Same camera uniform as the particle shader (particleUniform). Quads lie along the trail tangent and lean toward the camera; no depth test, so the aid reads through terrain. */
export const chevronShader=`
struct U {right:vec4f,up:vec4f,look:vec4f};
@group(0) @binding(0) var<uniform> u:U;
struct V {@builtin(position) clip:vec4f,@location(0) q:vec2f,@location(1) a:f32,@location(2) s:f32};
@vertex fn vs(@builtin(vertex_index) i:u32,@location(0) p:vec4f,@location(1) d:vec4f,@location(2) st:vec4f)->V {
  var corners=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1));
  let q=corners[i];
  let n=normalize(u.up.xyz*.6-u.look.xyz*.8);
  var side=cross(d.xyz,n);
  if(length(side)<.15){side=u.right.xyz;}
  side=normalize(side);
  let rel=p.xyz+(d.xyz*q.y+side*q.x)*p.w;
  let z=dot(rel,u.look.xyz);let near=u.up.w;let far=u.look.w;
  var v:V;
  v.clip=vec4f(dot(rel,u.right.xyz)/(0.55*u.right.w),dot(rel,u.up.xyz)/0.55,(z-near)*far/(far-near),z);
  v.q=q;v.a=d.w;v.s=st.x;return v;
}
fn band(q:vec2f,off:f32)->f32 {return abs(q.y-(.45-off-.6*abs(q.x)))*.86;}
@fragment fn fs(v:V)->@location(0) vec4f {
  var d=band(v.q,0.);
  if(v.s>.5&&v.s<1.5){d=min(d,band(v.q,.6));}
  let inside=step(abs(v.q.x),1.)*step(-1.,v.q.y);
  let fill=1.-smoothstep(.14,.18,d);
  let edge=(1.-smoothstep(.27,.31,d))*inside;
  var col=vec3f(1.,.83,.42);
  if(v.s>.5&&v.s<1.5){col=vec3f(.3,.9,1.);}
  if(v.s>1.5){let c=floor(v.q.x*3.)+floor(v.q.y*3.);col=vec3f(select(0.,1.,(c-2.*floor(c/2.))>.5));}
  let a=v.a*edge;
  return vec4f(col*fill*a,a);
}`;
