// Planet view: a stylised globe (Azeroth), sky thinning to space, stars, a sun and two moons, drawn when flying high.
// Camera/render only; physics stays flat. The globe is analytic (one fullscreen ray-sphere pass), the near terrain bends onto it.
// Sizing: Kalimdor is the largest populated continent, about 29,870 yd north-south, and is meant to span 40 degrees of latitude.
export const CONTINENT_YD=29867,CONTINENT_DEG=40;
export const PLANET_RADIUS=Math.round(CONTINENT_YD/(CONTINENT_DEG*Math.PI/180));
// World centre (render yd) at lat/lon 0, and the fallback continent rectangles [x0,z0,x1,z1] when no manifest is loaded (hosted build).
export const WORLD_CENTRE=[1429,-267];
export const FALLBACK_RECTS=[[-21867,-17600,5333,12267],[13525,-5333,24725,17067]];
// Altitude ramps in yd above sea level, chosen from the horizon dip acos(R/(R+h)): 100 yd is 3.9 deg, 500 yd 8.6 deg, 2000 yd 17.7 deg.
// bend: terrain curves onto the globe; globe: the sphere fades in behind it; space: sky thins to black and stars/sun/moons appear
// (the atmosphere is about 12% of R, ~5 kyd, so space is complete by 9 kyd).
export const PLANET_RAMPS={bend:[150,1500],globe:[100,800],space:[2000,9000],cloud:[3000,9000]};
export const MOONS=[{radius:9000,orbit:300000,phase:2.4,turns:1,plane:[0,0],tint:[.9,.93,1]},
  {radius:5500,orbit:480000,phase:.9,turns:-2,plane:[.5,.35],tint:[.4,.65,1]}];
const smooth=(a,b,x)=>{const t=Math.min(1,Math.max(0,(x-a)/(b-a)));return t*t*(3-2*t);};
const fix=n=>Number(n.toFixed(6));

/** Fade factors for an altitude: bend (terrain curvature), globe (sphere alpha), space (black sky, stars), cloud (cloud visibility). */
export function planetFactors(altitude,enabled=true) {
  if(!enabled||!(altitude>0))return {bend:0,globe:0,space:0,cloud:1};
  const r=PLANET_RAMPS,s=name=>fix(smooth(r[name][0],r[name][1],altitude));
  return {bend:s('bend'),globe:s('globe'),space:s('space'),cloud:fix(1-s('cloud'))};
}

/** Local-to-planet frame at a render position: columns east, up, south (render x east, y up, z south). */
/** Sine of the angle the true horizon sits below level at an altitude, faded in with the terrain bend, so the sky gradient meets the limb instead of a flat horizon. */
export function horizonDip(altitude,bend=1,radius=PLANET_RADIUS) {
  const k=radius/(radius+Math.max(0,altitude));return Math.sqrt(1-k*k)*bend;
}
export function planetFrame(x,z,centre=WORLD_CENTRE,radius=PLANET_RADIUS) {
  const lon=(x-centre[0])/radius,lat=Math.max(-1.4,Math.min(1.4,-(z-centre[1])/radius));
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
/** Flight stays on the globe: longitude wraps around the planet and latitude stops short of the poles (the frame clamps there). */
export function wrapFlat(x,z,centre=WORLD_CENTRE,radius=PLANET_RADIUS) {
  const turn=2*Math.PI*radius,half=turn/2;
  const dx=((x-centre[0]+half)%turn+turn)%turn-half,lim=1.4*radius;
  return [centre[0]+dx,Math.max(centre[1]-lim,Math.min(centre[1]+lim,z))];
}
/** Continent under a flat position from the populated continent rectangles (first = Kalimdor, second = Eastern Kingdoms). */
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
export function spaceUniform(view,sun,factors,rects,timeOfDay,near,far,out=new Float32Array(64)) {
  const eye=view.eye,altitude=Math.max(0,eye[1]),f=planetFrame(eye[0],eye[2]);
  out.fill(0);
  out.set([...view.look,view.aspect,...view.right,near,...view.up,far,altitude,factors.space,factors.globe,PLANET_RADIUS],0);
  out.set([...sun,timeOfDay],16);
  out.set([...f.east,WORLD_CENTRE[0],...f.up,WORLD_CENTRE[1],...f.south,Math.min(4,rects.length)],20);
  rects.slice(0,4).forEach((r,i)=>out.set(r,32+i*4));
  const centre=[0,-(PLANET_RADIUS+altitude),0];
  MOONS.forEach((moon,i)=>{
    const p=moonPlanetPosition(moon,timeOfDay),local=[f.east,f.up,f.south].map(axis=>axis[0]*p[0]+axis[1]*p[1]+axis[2]*p[2]);
    out.set([centre[0]+local[0],centre[1]+local[1],centre[2]+local[2],moon.radius],48+i*4);
    out.set([...moon.tint,0],56+i*4);
  });
  return out;
}

// Terrain/water/prop vertex shaders call bend(): azimuthal-equidistant wrap onto the globe (ground distance d becomes arc d/R),
// blended in by k so low flight and all driving stay flat.
export const bendShader=`
fn bend(rel:vec3f,eyeY:f32,k:f32)->vec3f {
  let d=length(rel.xz);
  if(k<=0.0||d<1.0){return rel;}
  let R=${PLANET_RADIUS}.0;let th=d/R;let rr=R+rel.y+eyeY;
  let h=rr*sin(th);let y=rr*cos(th)-R-eyeY;
  let s=mix(d,h,k)/d;
  return vec3f(rel.x*s,mix(rel.y,y,k),rel.z*s);
}`;

export const spaceShader=`
struct S {look:vec4f,right:vec4f,up:vec4f,p:vec4f,sun:vec4f,e:vec4f,u:vec4f,s:vec4f,rect:array<vec4f,4>,moon:array<vec4f,2>,tint:array<vec4f,2>};
@group(0) @binding(0) var<uniform> s:S;
const R=${PLANET_RADIUS}.0;
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
      let hit=d*t;let n=normalize(hit-centre);
      let pv=toPlanet(n);let lat=asin(clamp(pv.y,-1.0,1.0));let lon=atan2(pv.z,pv.x);
      let m=vec2f(${WORLD_CENTRE[0]}.0+R*lon,${WORLD_CENTRE[1]}.0-R*lat);
      var sdist=-1e5;
      for(var r=0;r<i32(s.s.w);r++){
        let q=s.rect[r];sdist=max(sdist,min(min(m.x-q.x,q.z-m.x),min(m.y-q.y,q.w-m.y)));
      }
      // Noise is sampled on the unit sphere (x,z circle plus y offset), so it has no seam at the antimeridian.
      let sp=pv.xz*15.0+vec2f(pv.y*5.7,pv.y*3.1);
      let edge=sdist-2200.0+(fbm(sp)-.5)*9000.0;
      let land=smoothstep(-600.0,600.0,edge);
      let tex=fbm(pv.xz*85.0+vec2f(pv.y*31.0,pv.y*17.0));
      let ground=mix(vec3f(.2,.38,.14),vec3f(.5,.42,.26),smoothstep(.35,.7,tex));
      let sea=mix(vec3f(.02,.1,.22),vec3f(.06,.3,.42),smoothstep(-6000.0,2000.0,edge));
      var col=mix(sea,ground,land);
      let cloud=0.0;
      let lit=clamp(dot(n,sun)*1.6+.15,0.0,1.0);
      let spec=pow(max(dot(reflect(-sun,n),-d),0.0),40.0)*(1.0-land)*(1.0-cloud);
      let rim=pow(1.0-max(dot(n,-d),0.0),3.0);
      col=col*(.03+lit)+vec3f(.5,.6,.7)*spec*lit+vec3f(.25,.5,1.0)*rim*(.15+lit)*.8;
      acc=over(acc,col,globe);
      let dz=dot(d,s.look.xyz);
      let dt=sphereT(o,d,centre,R-40.0);
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
  let oc=o-centre;let b=dot(oc,d);let closest=sqrt(max(dot(oc,oc)-b*b,0.0));
  let hitGlobe=sphereT(o,d,centre,R)>0.0;
  if(!hitGlobe&&b<0.0){
    let near=exp(-max(closest-R,0.0)/(R*.035));
    let np=normalize(oc+d*(-b));
    acc=over(acc,vec3f(.3,.55,1.0)*(.2+.8*clamp(dot(np,sun)+.3,0.0,1.0)),near*.8*globe);
  }
  var out:FO;out.color=acc;out.depth=depth;return out;
}`;
