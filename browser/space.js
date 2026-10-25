// Planet view: a stylised globe (Azeroth), sky thinning to space, stars, a sun and two moons, drawn when flying high.
// Camera/render only; physics stays flat. The globe is analytic (one fullscreen ray-sphere pass), the near terrain bends onto it.
// Sizing: Kalimdor is the largest populated continent, about 29,870 yd north-south, and is meant to span 40 degrees of latitude.
import {HEIGHT_RANGE,HEIGHT_MIN} from './height-bake.js';
import {BEND_RANGE,wgslRamp} from './terrain-transition.js';
import {nightLightsWgsl} from './night-lights-wgsl.js';
export const CONTINENT_YD=29867,CONTINENT_DEG=40;
export const PLANET_RADIUS=Math.round(CONTINENT_YD/(CONTINENT_DEG*Math.PI/180));
// World centre (render yd) at lat/lon 0, and the fallback continent rectangles [x0,z0,x1,z1] when no manifest is loaded (hosted build).
// The z is set so the Maelstrom (render z 3507, from maelstromCentre on the WoW map layout) sits MAELSTROM_LAT degrees north of the equator; the whole layout shifts rigidly, so distances are unchanged.
export const MAELSTROM_Z=3507,MAELSTROM_LAT=20;
export const WORLD_CENTRE=[1429,Math.round(MAELSTROM_Z+PLANET_RADIUS*MAELSTROM_LAT*Math.PI/180)];
export const FALLBACK_RECTS=[[-21867,-7467,5333,22400],[13525,-5333,24725,17067]];
// Altitude ramps in yd above sea level, chosen from the horizon dip acos(R/(R+h)): 100 yd is 3.9 deg, 500 yd 8.6 deg, 2000 yd 17.7 deg.
// bend: terrain curves onto the globe; globe: the sphere fades in behind it; space: sky thins to black and stars/sun/moons appear
// (the atmosphere is about 12% of R, ~5 kyd, so space is complete by 9 kyd).
// Globe depth sits this far below sea level so terrain, the whirlpool hole (180 yd) and low valleys are never hidden by the globe.
const GLOBE_DEPTH_DROP=400;
export const MOONS=[{radius:9000,orbit:300000,phase:2.4,turns:1,plane:[0,0],tint:[.9,.93,1]},
  {radius:5500,orbit:480000,phase:.9,turns:-2,plane:[.5,.35],tint:[.4,.65,1]}];
/** Local-to-planet frame at a render position: columns east, up, south (render x east, y up, z south). */
/** Sine of the angle the true horizon sits below level at an altitude, faded in with the terrain bend, so the sky gradient meets the limb instead of a flat horizon. */
export function horizonDip(altitude,bend=1,radius=PLANET_RADIUS) {
  const k=radius/(radius+Math.max(0,altitude));return Math.sqrt(1-k*k)*bend;
}
export function planetFrame(x,z,centre=WORLD_CENTRE,radius=PLANET_RADIUS) {
  const lon=(x-centre[0])/radius,lat=Math.max(-LAT_MAX,Math.min(LAT_MAX,-(z-centre[1])/radius));
  const [sl,cl,sp,cp]=[Math.sin(lon),Math.cos(lon),Math.sin(lat),Math.cos(lat)];
  return {east:[-sl,0,cl],up:[cp*cl,sp,cp*sl],south:[sp*cl,-cp,sp*sl]};
}

/** Position model: the flat pose (x, z) is the globe sub-point (the radial below you), lon = (x - cx)/R and lat = -(z - cz)/R, so descending radially lands on the same flat (x, z). */
export function subPoint(x,z,centre=WORLD_CENTRE,radius=PLANET_RADIUS) {
  return {lat:-(z-centre[1])/radius,lon:(x-centre[0])/radius};
}
export function globeToFlat(lat,lon,centre=WORLD_CENTRE,radius=PLANET_RADIUS) {
  return [centre[0]+radius*lon,centre[1]-radius*lat];
}
/** Flight stays on the globe: longitude wraps and flying over a pole continues down the far meridian (lat' = pi - lat, lon + pi), returning flipped=true so the caller turns the heading half a turn. */
export function wrapFlat(x,z,centre=WORLD_CENTRE,radius=PLANET_RADIUS) {
  const turn=2*Math.PI*radius,half=turn/2,TAU=2*Math.PI;
  let lat=-(z-centre[1])/radius,dx=x-centre[0],flipped=false;
  lat=((lat+Math.PI)%TAU+TAU)%TAU-Math.PI;
  if(Math.abs(lat)>Math.PI/2){lat=Math.sign(lat)*Math.PI-lat;dx+=half;flipped=true;}
  dx=((dx+half)%turn+turn)%turn-half;
  const k=Math.PI/2-1e-4;
  return [centre[0]+dx,Math.abs(z-centre[1])>k*radius?centre[1]-radius*Math.max(-k,Math.min(k,lat)):z,flipped];
}
export const LAT_MAX=Math.PI/2-1e-4;/** Continent under a flat position from the populated continent rectangles (first = Kalimdor, second = Eastern Kingdoms). */
export function placeName(x,z,rects=FALLBACK_RECTS) {
  const inside=r=>x>=r[0]&&x<=r[2]&&z>=r[1]&&z<=r[3];
  return inside(rects[0])?'KALIMDOR':rects[1]&&inside(rects[1])?'EASTERN KINGDOMS':'THE GREAT SEA';
}
/** Nearest map landmark (icons have a label and a flat `position`), by great-circle arc scaled back to yards, or undefined without any. */
export function nearestLandmark(x,z,icons=[]) {
  let best;
  for(const i of icons){const d=Math.hypot(...wrapDelta(i.position[0]-x,i.position[1]-z));if(!best||d<best.distance)best={label:i.label,distance:d};}
  return best;
}
const wrapDelta=(dx,dz)=>{const turn=2*Math.PI*PLANET_RADIUS;return [((dx+turn/2)%turn+turn)%turn-turn/2,dz];};
export function spaceHud(pose,speed,rects,icons) {
  const {lat,lon}=subPoint(pose[0],pose[2]),d=r=>(Math.abs(r*180/Math.PI)).toFixed(1),near=nearestLandmark(pose[0],pose[2],icons),
    nearText=near?` · ${near.distance>=1000?(near.distance/1000).toFixed(1)+"k":near.distance.toFixed(0)} yd from ${near.label}`:"";
  const alt=Math.max(0,pose[1]),altText=alt>=10000?`${(alt/1000).toFixed(1)}k`:alt.toFixed(0);
  return `${placeName(pose[0],pose[2],rects)}${nearText} · ${d(lat)}°${lat>=0?'N':'S'} ${d(lon)}°${lon>=0?'E':'W'} · ALT ${altText} yd · ${speed>=10000?(speed/1000).toFixed(1)+'k':speed.toFixed(0)} yd/s`;
}

/** Moon position in the planet frame (static planet, slow rails: whole turns per day clock so the wrap never pops). */
export function moonPlanetPosition(moon,timeOfDay) {
  const a=moon.turns*Math.PI*(timeOfDay-720)/1440+moon.phase,[rx,rz]=moon.plane;
  const ex=[0,1,0],ey=[Math.cos(rx),0,Math.sin(rz)],n=Math.hypot(...ey),c=Math.cos(a),s=Math.sin(a);
  return ex.map((e,i)=>moon.orbit*(e*c+ey[i]/n*s));
}

/** Uniform floats (16 x vec4) for spaceShader. */
export function spaceUniform(view,sun,factors,rects,timeOfDay,near,far,out=new Float32Array(64),body) {
  const radius=body?.radius??PLANET_RADIUS,chart=body?.centre??WORLD_CENTRE,moons=body?.moons??null;
  const eye=view.eye,altitude=Math.max(0,eye[1]),f=planetFrame(eye[0],eye[2],chart,radius);
  out.fill(0);
  out.set([...view.look,view.aspect,...view.right,near,...view.up,far,altitude,factors.space,factors.globe,radius],0);
  out.set([...sun,timeOfDay],16);
  out.set([...f.east,chart[0],...f.up,chart[1],...f.south,Math.min(3,rects.length)],20);
  rects.slice(0,3).forEach((r,i)=>out.set(r,32+i*4));
  const centre=[0,-(radius+altitude),0];
  (moons??MOONS).forEach((moon,i)=>{
    const p=moons?moon.position:moonPlanetPosition(moon,timeOfDay),local=[f.east,f.up,f.south].map(axis=>axis[0]*p[0]+axis[1]*p[1]+axis[2]*p[2]);
    out.set([centre[0]+local[0],centre[1]+local[1],centre[2]+local[2],moon.radius],48+i*4);
    out.set([...moon.tint,0],56+i*4);
  });
  out.set(factors.fog||[0,0,0],44);out[59]=factors.mesh?1:0;out[63]=factors.registry?1:0;
  return out;
}

// Terrain/water/prop vertex shaders call bend(): the flat render (x, z) is wrapped onto the globe with the SAME equirect mapping as the
// globe, patches and clouds (lon = (x-cx)/R, lat = (cz-z)/R), expressed in the eye's planet frame, blended in by k so low flight and
// all driving stay flat. Differences from the eye are used so f32 keeps precision near the camera.
/** JS mirror of the WGSL bend(): eye-relative flat offset -> eye-relative render position on the equirect globe (k = 1), flat at k = 0. */
export function bendRel(rel,eye,k=1,radius=PLANET_RADIUS,centre=WORLD_CENTRE) {
  if(k<=0||Math.hypot(rel[0],rel[2])<1)return rel.slice();
  const lat0=Math.max(-LAT_MAX,Math.min(LAT_MAX,(centre[1]-eye[2])/radius)),lat=Math.max(-LAT_MAX,Math.min(LAT_MAX,lat0-rel[2]/radius)),dl=rel[0]/radius;
  const cl=Math.cos(lat),sp0=Math.sin(lat0),cp0=Math.cos(lat0),cd=cl*Math.cos(dl);
  const n=[cl*Math.sin(dl),cp0*cd+sp0*Math.sin(lat),sp0*cd-cp0*Math.sin(lat)],r=radius+rel[1]+eye[1];
  return [rel[0]+(n[0]*r-rel[0])*k,rel[1]+(n[1]*r-(radius+eye[1])-rel[1])*k,rel[2]+(n[2]*r-rel[2])*k];
}
const wgslF=x=>Number.isInteger(x)?x+'.0':String(x);
/** WGSL bend() for a body of the given radius and chart centre (design/elune.md M3). The default export is Azeroth, byte-identical to before. */
export const bendShaderFor=(radius,centre)=>`
fn bend(rel:vec3f,eye:vec3f,k:f32)->vec3f {
  if(k<=0.0||length(rel.xz)<1.0){return rel;}
  let R=${wgslF(radius)};let lim=${LAT_MAX};
  let lat0=clamp((${wgslF(centre[1])}-eye.z)/R,-lim,lim);let lat=clamp(lat0-rel.z/R,-lim,lim);let dl=rel.x/R;
  let cl=cos(lat);let sp0=sin(lat0);let cp0=cos(lat0);let cd=cl*cos(dl);
  let n=vec3f(cl*sin(dl),cp0*cd+sp0*sin(lat),sp0*cd-cp0*sin(lat));
  let w=vec3f(0.0,-(R+eye.y),0.0)+n*(R+rel.y+eye.y);
  return mix(rel,w,k);
}`;
export const bendShader=bendShaderFor(PLANET_RADIUS,WORLD_CENTRE);

export const spaceShaderFor=radius=>`
struct S {look:vec4f,right:vec4f,up:vec4f,p:vec4f,sun:vec4f,e:vec4f,u:vec4f,s:vec4f,rect:array<vec4f,4>,moon:array<vec4f,2>,tint:array<vec4f,2>};
@group(0) @binding(0) var<uniform> s:S;
@group(0) @binding(1) var surfaceTex:texture_2d<f32>;
@group(0) @binding(2) var surfaceSamp:sampler;
@group(0) @binding(4) var lightsTex:texture_2d<f32>;
const R=${wgslF(radius)};const DEPTH_R=R-${GLOBE_DEPTH_DROP}.0;
struct V {@builtin(position) clip:vec4f,@location(0) ndc:vec2f};
@vertex fn vs(@builtin(vertex_index) i:u32)->V {
  var p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
  var v:V;v.clip=vec4f(p[i],0,1);v.ndc=p[i];return v;
}
fn h1(p:vec3f)->f32 {return fract(sin(dot(p,vec3f(127.1,311.7,74.7)))*43758.5453);}
fn h2(p:vec2f)->f32 {return fract(sin(dot(p,vec2f(127.1,311.7)))*43758.5453);}
fn vn(p:vec2f)->f32 {
  let i=floor(p);let f=fract(p);let q=f*f*(3.0-2.0*f);
  return mix(mix(h2(i),h2(i+vec2f(1,0)),q.x),mix(h2(i+vec2f(0,1)),h2(i+vec2f(1,1)),q.x),q.y);
}
fn fbm(p:vec2f)->f32 {return .5*vn(p)+.25*vn(p*2.03+7.0)+.125*vn(p*4.1+13.0)+.0625*vn(p*8.3+3.0);}
${nightLightsWgsl}
fn stars(d:vec3f)->f32 {
  var t=0.0;
  for(var l=0;l<2;l++){
    let p=d*(60.0+70.0*f32(l));let c=floor(p);let f=fract(p)-.5;let k=vec3f(f32(l)*17.0);
    let o=(vec3f(h1(c+k+1.3),h1(c+k+2.7),h1(c+k+4.1))-.5)*.6;
    t+=step(.93,h1(c+k))*smoothstep(.12,0.0,length(f-o))*(.4+.6*h1(c+k+9.0));
  }
  return t;
}
fn toPlanet(v:vec3f)->vec3f {return s.e.xyz*v.x+s.u.xyz*v.y+s.s.xyz*v.z;}
fn over(under:vec4f,c:vec3f,a:f32)->vec4f {return vec4f(c*a+under.rgb*(1.0-a),a+under.a*(1.0-a));}
fn sphereT(o:vec3f,d:vec3f,c:vec3f,r:f32)->f32 {
  let oc=o-c;let b=dot(oc,d);let q=dot(oc,oc)-r*r;let disc=b*b-q;
  return select(-1.0,-b-sqrt(disc),disc>0.0&&-b-sqrt(disc)>0.0);
}
// Globe surface colour and lighting for a unit planet-frame point pv, local normal n and view ray d. Shared by the analytic sphere and the patch mesh.
fn surface(pv:vec3f,n:vec3f,d:vec3f,sun:vec3f)->vec3f {
  let lat=asin(clamp(pv.y,-1.0,1.0));let lon=atan2(pv.z,pv.x);
  let m=vec2f(${WORLD_CENTRE[0]}.0+R*lon,${WORLD_CENTRE[1]}.0-R*lat);
  var sdist=-1e5;
  for(var r=0;r<i32(s.s.w);r++){
    let q=s.rect[r];sdist=max(sdist,min(min(m.x-q.x,q.z-m.x),min(m.y-q.y,q.w-m.y)));
  }
  // Noise is sampled on the unit sphere (x,z circle plus y offset), so it has no seam at the antimeridian.
  let sp=pv.xz*15.0+vec2f(pv.y*5.7,pv.y*3.1);
  var edge=sdist-2200.0+(fbm(sp)-.5)*9000.0;
  var regCol=vec3f(0.0);
  if(s.tint[1].w>.5){
    // Registry authority: land weight and colour come from the baked chunk registry, not the rectangle + noise mask.
    let r=textureSampleLevel(surfaceTex,surfaceSamp,vec2f(lon/6.2831853+.5,.5-lat/3.1415927),0.0);
    edge=(r.a-.5)*3000.0;regCol=r.rgb;
  }
  let land=smoothstep(-600.0,600.0,edge);
  let tex=fbm(pv.xz*85.0+vec2f(pv.y*31.0,pv.y*17.0));
  var ground=mix(vec3f(.2,.38,.14),vec3f(.5,.42,.26),smoothstep(.35,.7,tex));
  if(s.tint[1].w>.5){ground=ground*.5+regCol*(.6+tex*.5);}
  // Deep/shallow body colours are the terrain water shader's, so the sea has no colour step at the loaded-tile edge.
  let sea=mix(vec3f(.025,.18,.29),vec3f(.09,.43,.39),smoothstep(-1500.0,1500.0,edge));
  var col=mix(sea,ground,land);
  let lit=clamp(dot(n,sun)*1.6+.15,0.0,1.0);
  let spec=pow(max(dot(reflect(-sun,n),-d),0.0),40.0)*(1.0-land);
  let rim=pow(1.0-max(dot(n,-d),0.0),3.0);
  // Night floor equals the terrain/water night grade (0.35 x the blue night tint), so mesh and globe ocean agree across the terminator.
  let floorC=mix(vec3f(.16,.22,.4),vec3f(.03),smoothstep(-.12,.25,dot(n,sun)));
  return col*(floorC+lit)+vec3f(.5,.6,.7)*spec*lit+vec3f(.25,.5,1.0)*rim*(.15+lit)*.8*clamp(s.p.x/3000.0,0.0,1.0);
}
// Same haze law as the terrain/water shaders (distance/150000, gone once the bend takes over); fog colour rides in the unused fourth rect slot.
fn fogGlobe(c:vec3f,t:f32,n:vec3f,d:vec3f)->vec3f {let low=1.0-${wgslRamp(BEND_RANGE)}s.p.x);let f=pow(1.0-abs(dot(normalize(n),normalize(d))),3.0);let k=max(clamp(t/150000.0,0.0,.93),.85*f)*low;return mix(c,s.rect[3].xyz,k);}
struct FO {@location(0) color:vec4f,@builtin(frag_depth) depth:f32};
@fragment fn fs(v:V)->FO {
  let d=normalize(s.look.xyz+s.right.xyz*v.ndc.x*.55*s.look.w+s.up.xyz*v.ndc.y*.55);
  let alt=s.p.x;let space=s.p.y;let globe=s.p.z;let sun=normalize(s.sun.xyz);
  let o=vec3f(0.0);let centre=vec3f(0.0,-(R+alt),0.0);
  var acc=vec4f(0.0);
  let sd=max(dot(d,sun),0.0);
  var bg=vec3f(.005,.006,.012)+vec3f(1.0,.93,.8)*(smoothstep(.9994,.9999,sd)*2.0+pow(sd,300.0)*.6+pow(sd,24.0)*.12);
  bg+=vec3f(.9,.95,1.0)*stars(toPlanet(d))*1.2;
  acc=vec4f(bg*space,space);
  var order=array<f32,3>(sphereT(o,d,centre,R),sphereT(o,d,s.moon[0].xyz,s.moon[0].w),sphereT(o,d,s.moon[1].xyz,s.moon[1].w));
  var ids=array<i32,3>(0,1,2);
  for(var a=0;a<2;a++){for(var b=0;b<2-a;b++){if(order[b]<order[b+1]){let t=order[b];order[b]=order[b+1];order[b+1]=t;let q=ids[b];ids[b]=ids[b+1];ids[b+1]=q;}}}
  var depth=1.0;
  for(var i=0;i<3;i++){
    let t=order[i];if(t<0.0){continue;}
    let id=ids[i];
    if(id==0){
      if(s.tint[0].w>.5){continue;}
      let n=normalize(d*t-centre);
      acc=over(acc,fogGlobe(surface(toPlanet(n),n,d,sun),t,n,d),globe);
      let dz=dot(d,s.look.xyz);
      let dt=sphereT(o,d,centre,DEPTH_R);
      let zz=max(dt,t)*dz;
      depth=select(1.0,clamp((zz-s.right.w)*s.up.w/((s.up.w-s.right.w)*zz),0.0,1.0),globe>.02);
    } else {
      let mc=s.moon[id-1];let n=normalize(d*t-mc.xyz);
      let lit=clamp(dot(n,sun)*2.0+.12,0.0,1.0);
      let crater=.75+.25*fbm(n.xz*9.0+n.y*5.0);
      acc=over(acc,s.tint[id-1].rgb*crater*lit,space);
    }
  }
  // Limb glow for rays that miss the globe.
  let oc=o-centre;let b=dot(oc,d);
  let hitGlobe=sphereT(o,d,centre,R)>0.0;
  if(!hitGlobe){
    // Decays smoothly with the angle above the limb; a b<0 test cut a hard step at level.
    let reach=sqrt(max(dot(oc,oc)-R*R,0.0));let dip=reach/length(oc);
    let near=exp(-max(d.y+dip,0.0)*reach/(R*.035));
    let np=normalize(oc-d*min(b,0.0));
    acc=over(acc,vec3f(.3,.55,1.0)*(.2+.8*clamp(dot(np,sun)+.3,0.0,1.0)),near*.8*globe*clamp(alt/3000.0,0.0,1.0));
  }
  var out:FO;out.color=acc;out.depth=depth;return out;
}
// Settlement lights, drawn additively after terrain so the horizon meshes that cover the globe at orbit cannot hide them.
@fragment fn lfs(v:V)->@location(0) vec4f {
  let d=normalize(s.look.xyz+s.right.xyz*v.ndc.x*.55*s.look.w+s.up.xyz*v.ndc.y*.55);
  let centre=vec3f(0.0,-(R+s.p.x),0.0);let t=sphereT(vec3f(0.0),d,centre,R);
  let high=smoothstep(2500.0,9000.0,s.p.x)*s.p.z;
  if(t<0.0||high<.002){discard;}
  let n=normalize(d*t-centre);let pv=toPlanet(n);
  let dark=1.0-smoothstep(-.12,.1,dot(n,normalize(s.sun.xyz)));
  if(dark<.002){discard;}
  let lat=asin(clamp(pv.y,-1.0,1.0));let lon=atan2(pv.z,pv.x);
  return vec4f(lightsAt(vec2f(lon/6.2831853+.5,.5-lat/3.1415927),s.rect[3].w)*dark*high,0.0);
}
`;
export const spaceShader=spaceShaderFor(PLANET_RADIUS);

// Patch mesh (globe-patches.js): each instance is one lat/lon patch drawn as a 16x16 grid. Edge vertices of finer patches snap onto coarser neighbours (flags) so LOD cracks close exactly.
export const patchShaderFor=radius=>{const space=spaceShaderFor(radius);return space.slice(0,space.indexOf('@fragment fn fs'))+`
@group(0) @binding(3) var heightTex:texture_2d<f32>;
struct PV {@builtin(position) clip:vec4f,@location(0) pv:vec3f,@location(1) n:vec3f,@location(2) w:vec3f};
fn patchPos(p:vec4f,ij:vec2u)->vec3f {
  let uv=vec2f(ij)/16.0;
  let lat=mix(p.x,p.y,uv.y);let lon=mix(p.z,p.w,uv.x);
  let pv=vec3f(cos(lat)*cos(lon),sin(lat),cos(lat)*sin(lon));
  let n=vec3f(dot(s.e.xyz,pv),dot(s.u.xyz,pv),dot(s.s.xyz,pv));
  let tc=vec2f(lon/6.2831853+.5,.5-lat/3.1415927);
  var hm=textureSampleLevel(heightTex,surfaceSamp,tc,0.0).r*${HEIGHT_RANGE}.0+${HEIGHT_MIN}.0;
  // Only lift where the registry says land, so relief never stands on sea-coloured ground (the cyan limb block).
  if(s.tint[1].w>.5&&textureSampleLevel(surfaceTex,surfaceSamp,tc,0.0).a<.5){hm=0.0;}
  return vec3f(0.0,-(R+s.p.x),0.0)+n*(R+max(hm,0.0));
}
@vertex fn pvs(@builtin(vertex_index) vi:u32,@location(0) p:vec4f,@location(1) f:vec4f)->PV {
  let corner=array<vec2u,6>(vec2u(0,0),vec2u(1,0),vec2u(0,1),vec2u(0,1),vec2u(1,0),vec2u(1,1));
  let cell=vi/6u;let c=corner[vi%6u];
  let ij=vec2u(cell%16u,cell/16u)+c;let uv=vec2f(ij)/16.0;
  let lat=mix(p.x,p.y,uv.y);let lon=mix(p.z,p.w,uv.x);
  let pv=vec3f(cos(lat)*cos(lon),sin(lat),cos(lat)*sin(lon));
  let n=vec3f(dot(s.e.xyz,pv),dot(s.u.xyz,pv),dot(s.s.xyz,pv));
  var w=patchPos(p,ij);
  // A finer patch beside a coarser one: odd edge vertices sit on the neighbour's straight edge so no T-junction crack opens.
  if((ij.x&1u)==1u&&((ij.y==0u&&f.x>.5)||(ij.y==16u&&f.y>.5))){w=.5*(patchPos(p,ij-vec2u(1,0))+patchPos(p,ij+vec2u(1,0)));}
  if((ij.y&1u)==1u&&((ij.x==0u&&f.z>.5)||(ij.x==16u&&f.w>.5))){w=.5*(patchPos(p,ij-vec2u(0,1))+patchPos(p,ij+vec2u(0,1)));}
  let z=dot(w,s.look.xyz);
  var o:PV;
  o.clip=vec4f(dot(w,s.right.xyz)/(.55*s.look.w),dot(w,s.up.xyz)/.55,min((z-s.right.w)*s.up.w/(s.up.w-s.right.w),.9999*z),z);
  o.pv=pv;o.n=n;o.w=w;return o;
}
@fragment fn pfs(v:PV)->FO {
  let n=normalize(v.n);let d=normalize(v.w);
  // From far away the far hemisphere's patches rasterise inside the disc with the near hit's depth; they would repaint the limb with night-side colour.
  if(s.p.x>20000.0&&dot(n,d)>0.0){discard;}
  // Shade with the displaced face normal: the radial normal made cliffs seen at the limb glow rim-cyan.
  var ng=cross(dpdx(v.w),dpdy(v.w));ng=select(n,normalize(ng),dot(ng,ng)>1e-6);ng=select(-ng,ng,dot(ng,n)>=0.0);
  // Open sea (no relief) keeps the smooth radial normal; chord facets of the 16x16 grid otherwise show as blocky specular glint.
  ng=normalize(mix(n,ng,smoothstep(2.0,30.0,length(v.w-vec3f(0.0,-(R+s.p.x),0.0))-R)));
  let dz=dot(d,s.look.xyz);let dt=sphereT(vec3f(0.0),d,vec3f(0.0,-(R+s.p.x),0.0),DEPTH_R);
  // Rays that miss the depth sphere graze the surface; write far depth so terrain behind the limb is never culled by the globe.
  let zz=select(1.0e9,max(dt*dz,1.0/v.clip.w),dt>0.0);
  var o:FO;o.color=vec4f(fogGlobe(surface(normalize(v.pv),ng,d,normalize(s.sun.xyz)),zz/max(dz,.05),n,d)*s.p.z,s.p.z);
  o.depth=clamp((zz-s.right.w)*s.up.w/((s.up.w-s.right.w)*zz),0.0,1.0);return o;
}`;};
export const patchShader=patchShaderFor(PLANET_RADIUS);
