// Procedural cumulus slab: one camera-following quad whose fragments march a short ray through a layer of
// analytic noise density, with a maelstrom (eye, eye wall, spiral arms) around a vortex centre. No textures or extra passes.
import {PLANET_RADIUS,WORLD_CENTRE,planetFrame} from './space.js';
import {flowWGSL,FLOW,MASK,bakeLandMask} from './cloud-flow.js';
import {createRegistry,defaultManifest} from './tile-registry.js';
export const CLOUD_ALTITUDE_FACTOR=.8;
// Mt Hyjal summit height in yards, measured from the user's Kalimdor terrain (tile bounds near Hyjal, see README "Clouds").
export const HYJAL_SUMMIT=1971;
export const CLOUD_ALTITUDE=CLOUD_ALTITUDE_FACTOR*HYJAL_SUMMIT;
export const CLOUD_THICKNESS=520;
// High tier only: how far dense storm columns grow above / below the slab (yards, at full storm density).
export const CLOUD_TOWER={up:2400,down:160};
export const CLOUD_HALF_SIZE=250000;
// Tunables in yards / radians per second. Arms rotate counter-clockwise as seen on the world map (north up).
export const MAELSTROM={eyeRadius:2200,wallRadius:5200,radius:24000,arms:3,pitch:.7,spin:.012,drift:.006};
// World-map registration: the eye sits 43% of the way from Kalimdor's east coast to the Eastern Kingdoms' west coast,
// and at 35% / 40% of the way down each continent's tile rows, averaged because the two continents are offset provisionally.
const MAELSTROM_MAP={across:.43,kalimdorDown:.35,easternDown:.4};

// Whirlpool dip, the single source of truth for JS and Rust (set_whirlpool in voyage.rs): the ocean surface at distance r
// from the centre sits depth*(1-(r/radius)^2)^2 yd below sea level (zero value and slope at the rim). The funnel ends at the bottom.
export const WHIRLPOOL_DIP={radius:2400,depth:330};

export function maelstromCentre(manifest) {
  const o=manifest.ocean,[kalimdor,east]=manifest.world_bounds.map((b,i)=>{
    const placement=manifest.regions[i].placement[1];
    return placement+(b[1]+(i?MAELSTROM_MAP.easternDown:MAELSTROM_MAP.kalimdorDown)*(b[3]+1-b[1]))*1600/3;
  });
  return [o[0]+MAELSTROM_MAP.across*(o[2]-o[0]),(kalimdor+east)/2];
}

// Sun direction from the Light.dbc half-minute clock (1440 = noon): east at 6:00 (720), overhead at noon, west at 18:00, with a fixed southward lean.
export function sunDirection(timeOfDay) {
  const a=Math.PI*(timeOfDay-720)/1440,v=[Math.cos(a),Math.sin(a),.35],n=Math.hypot(...v);
  return v.map(x=>x/n);
}

// Curvature is only applied once the terrain bend has started (bend >= .003), so ground flight and driving keep the flat sheet.
// kappa = bend / R is the curvature of the cloud shells (1 / yd); space blends the fade/fog distance origin to the shell entry.
export const shellCurvature=bend=>bend>=.003?bend/PLANET_RADIUS:0;
export function cloudUniform(view,time,daylight,manifest,near,game,out=new Float32Array(60),timeOfDay=1440,planet={bend:0,space:0}) {
  const [x,z]=maelstromCentre(manifest),sun=sunDirection(timeOfDay);
  out.set([...view.eye,200000,...view.right,view.aspect,...view.up,time,...view.look,daylight,x,z,CLOUD_ALTITUDE,CLOUD_HALF_SIZE,near]);
  const f=planetFrame(view.eye[0],view.eye[2]);
  out.set([shellCurvature(planet.bend),planet.space,0,0],44);
  out.set([...f.east,WORLD_CENTRE[0],...f.up,WORLD_CENTRE[1],...f.south,PLANET_RADIUS],48);
  out.set([...sun,sun[1]],32);out.set([1,.96,.88,0],36);out.set([.55,.6,.7,0],40);
  // Zone lighting fades to the global sun/sky look with altitude (planet.space 0..1), so orbit is lit by the sun alone.
  if(game){
    const k=Math.min(Math.max(planet.space||0,0),1),mixTo=(c,d)=>c.map((v,i)=>v+(d[i]-v)*k);
    out.set([...mixTo(game.cloud,[1,1,1]),1,...mixTo(game.fog,[.08,.15,.2]),0],24);
    if(game.sun)out.set([...mixTo(game.sun,[1,.96,.88]),0],36);if(game.cloud2)out.set([...mixTo(game.cloud2,[.55,.6,.7]),1],40);
  }
  return out;
}

// Funnel: a tapered, rotating column rising far above the sheet at the maelstrom centre (yards). Tunable.
// The column continues below the sheet down to sea level, flaring into a mist skirt (skirtRadius) at the whirlpool.
export const FUNNEL={top:7500,seaLevel:-WHIRLPOOL_DIP.depth,skirtRadius:1700,baseRadius:500,baseDensity:.12,sparseHeight:2200,topRadius:3200,flare:1.5,spin:.5,twist:5,fadeStart:90000,fadeEnd:170000};
const COMMON=`
struct C {eye:vec4f,right:vec4f,up:vec4f,look:vec4f,cloud:vec4f,near:vec4f,tint:vec4f,fog:vec4f,sun:vec4f,sunCol:vec4f,cloud2:vec4f,bend:vec4f,fe:vec4f,fu:vec4f,fs:vec4f};
@group(0) @binding(0) var<uniform> c:C;
@group(0) @binding(1) var sceneDepth:texture_depth_2d;
fn hash(p:vec2f)->f32 {return fract(sin(dot(p,vec2f(127.1,311.7)))*43758.5453);}
// Curved cloud shells (planet view): the layer is a spherical shell of effective radius 1/kappa under the eye. These are scaled by kappa so
// the flat limit (kappa -> 0) stays finite: roots of a t^2 + 2 b t + cc = 0 for the sphere at altitude y; returns (near, far) or (1e30, -1e30).
fn shellRoots(e:f32,dy:f32,y:f32)->vec2f {
  let k=c.bend.x;let a=max(k,1e-9);
  let b=(1.0+k*e)*dy;let cc=(e-y)*(2.0+k*(e+y));
  let disc=b*b-a*cc;
  if(disc<0.0){return vec2f(1e30,-1e30);}
  let sq=sqrt(disc);
  var q=-(b+select(-sq,sq,b>=0.0));
  if(abs(q)<1e-12){q=-1e-12;}
  let t1=q/a;let t2=cc/q;
  return vec2f(min(t1,t2),max(t1,t2));
}
// Local up (render frame) at an eye-relative point on the shells.
fn upAt(rel:vec3f)->vec3f {
  let k=c.bend.x;
  return normalize(vec3f(k*rel.x,1.0+k*(rel.y+c.eye.y),k*rel.z));
}
// Eye-relative point -> world (x, height, z). Flat when kappa = 0. Otherwise heights are above the shells' sea level and the horizontal position
// is the equirectangular planet mapping (same as the globe), with the arc scaled from the effective radius to the true one.
fn worldAt(rel:vec3f)->vec3f {
  let k=c.bend.x;
  if(k<=0.0){return c.eye.xyz+rel;}
  let u=rel.y+c.eye.y;let hd2=dot(rel.xz,rel.xz);
  let ry=1.0+k*u;let qs=sqrt(k*k*hd2+ry*ry);
  let h=(k*hd2+u*(2.0+k*u))/(qs+1.0);
  let hd=sqrt(hd2);
  let thetaE=atan2(k*hd,ry);
  let theta=thetaE/(k*${PLANET_RADIUS}.0);
  let hx=select(vec2f(1.0,0.0),rel.xz/hd,hd>1e-3);
  let n=vec3f(sin(theta)*hx.x,cos(theta),sin(theta)*hx.y);
  let pv=c.fe.xyz*n.x+c.fu.xyz*n.y+c.fs.xyz*n.z;
  let lat=asin(clamp(pv.y,-1.0,1.0));let lon=atan2(pv.z,pv.x);
  return vec3f(c.fe.w+c.fs.w*lon,h,c.fu.w-c.fs.w*lat);
}
fn vnoise(p:vec2f)->f32 {
  let i=floor(p);let f=fract(p);let s=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2f(1,0)),s.x),mix(hash(i+vec2f(0,1)),hash(i+vec2f(1,1)),s.x),s.y);
}`;
const M=MAELSTROM;
const F=FUNNEL;
// One fullscreen ray march samples the cumulus sheet and the funnel together, always taking whichever sample is nearer,
// so the two volumes occlude each other in true front-to-back order. Both are clipped to the scene depth.
// High tier: the sheet's noise comes from a tiling 64^3 texture (bakeCloudNoise) and each step takes one light tap toward the sun.
const HIGH_BINDINGS=`
@group(0) @binding(2) var noise:texture_3d<f32>;
@group(0) @binding(3) var nsamp:sampler;`;
const HIGH_NOISE=`
fn cloudNoise(Q:vec3f,up:vec3f,pos:vec3f,t:f32,hf:f32)->f32 {
  let u=(Q+up*(pos.y*3.0-t*4.0))/6500.0;
  let lo=textureSampleLevel(noise,nsamp,u,0.0);
  let hi=textureSampleLevel(noise,nsamp,u*2.6+.37,0.0);
  return .35*vnoise3(Q/2600.0)+.5*lo.r+.15*hi.g;
}`;
const STD_NOISE=`
fn cloudNoise(Q:vec3f,up:vec3f,pos:vec3f,t:f32,hf:f32)->f32 {
  let q=Q/2600.0;
  let n=.55*vnoise3(q)+.3*vnoise3(q*2.3+7.0)+.15*vnoise3(q*5.1+3.0);
  return n*.78+.22*vnoise3(Q/650.0+vec3f(hf*3.1,hf*1.7,hf*2.3));
}`;const HIGH_TAP=`
      let sd=sheetDensity(worldAt(rel+c.sun.xyz*ss*2.5),t).x;
      let shade=mix(mix(.65,1.0,exp(-sd*2.0)),1.0,smoothstep(.7,1.0,hf))*(1.0+.8*pow(max(dot(dir,c.sun.xyz),0.0),6.0));`;
const MASK_BINDINGS=`
@group(0) @binding(4) var landMask:texture_2d<f32>;
@group(0) @binding(5) var maskSamp:sampler;
// Baked land/ocean mask (cloud-flow.js bakeLandMask): x = land, y = windward lift, z = coastal convergence (both -1..1).
fn maskAt(lat:f32,lon:f32)->vec3f {
  let m=textureSampleLevel(landMask,maskSamp,vec2f(lon/6.2831853+.5,.5-lat/3.14159265),0.0);
  return vec3f(m.r,m.g*2.0-1.0,m.b*2.0-1.0);
}`;
const build=high=>COMMON+flowWGSL()+(high?HIGH_BINDINGS:'')+MASK_BINDINGS+`
struct V {@builtin(position) clip:vec4f,@location(0) ndc:vec2f};
@vertex fn vs(@builtin(vertex_index) i:u32)->V {
  var q=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
  var v:V;v.clip=vec4f(q[i],0.5,1);v.ndc=q[i];return v;
}
const THICK=${CLOUD_THICKNESS.toFixed(1)};
const UP=${high?CLOUD_TOWER.up:0}.0;
const DOWN=${high?CLOUD_TOWER.down:0}.0;
${high?HIGH_NOISE:STD_NOISE}
fn cloudBody(sp:Sph,d:vec2f,pos:vec3f,t:f32,tau:f32,drag:f32,coverage:f32,wall:f32)->vec2f {
  let s=flowShift(sp.lat,d,tau,drag);
  let Q=sp.up*${PLANET_RADIUS}.0+sp.e*s.x+sp.n*s.y;
  // Dense columns grow upward (towering tops) and a little downward, billowing slowly; low coverage keeps the flat sheet.
  let grow=smoothstep(.45,.95,coverage)*mix(.4,1.0,vnoise3(Q/3800.0+vec3f(t*.012,-t*.009,0.0)));
  let hf=clamp((pos.y-(c.cloud.z-THICK*.5-DOWN*grow))/(THICK+(UP+DOWN)*grow),0.0,1.0);
  let n=cloudNoise(Q,sp.up,pos,t,hf);
  let top=(n-(1.0-coverage))*(2.2+1.6*wall);
  return vec2f(smoothstep(0.0,.3,top-hf*.9)*smoothstep(0.0,.1,hf+.05),hf);
}
fn sheetDensity(pos:vec3f,t:f32)->vec3f {
  let d=pos.xz-c.cloud.xy;let r=length(d);
  // Noise is sampled at the 3D point on the planet (cloud-flow.js sphereAt), so it stays isotropic toward the poles; flowShift advects that point.
  let sp=sphereAt(pos.xz);
  // North is -z, so atan2(-z,x) grows counter-clockwise on the map.
  let a=atan2(-d.y,d.x);
  let arm=smoothstep(.2,.8,.5+.5*cos(${M.arms.toFixed(1)}*(a+${M.pitch}*log(max(r,1.0)/1000.0)-t*${M.spin})));
  let storm=exp(-r/${M.radius.toFixed(1)});
  let wall=exp(-pow((r-${M.wallRadius.toFixed(1)})/(${M.wallRadius.toFixed(1)}*.35),2.0));
  let eye=smoothstep(${M.eyeRadius.toFixed(1)},${(M.eyeRadius*1.5).toFixed(1)},r);
  // Away from the storm the global cells set the cover, with faint spiral arms reaching far out.
  let lm=maskAt(sp.lat,sp.lon);let drag=1.0-${MASK.drag}*lm.x;
  let landCov=${MASK.lift}*max(lm.y,0.0)*lm.x+${MASK.coast}*max(lm.z,0.0)-${MASK.dry*.5}*lm.x;
  let base=.4+(bandCoverage(sp.lat)+landCov+exp(-r/${FLOW.vortex.armReach.toFixed(1)})*(arm-.5)*${FLOW.vortex.armCover})*(1.0-storm);
  let coverage=clamp(mix(base,mix(.1,.95,arm),storm)+.6*wall,0.0,.95)*eye;
  // Two-phase flow map: each phase samples the noise displaced by the wind for its age, crossfaded near the resets; a single phase most of the time.
  let fp=flowPhase(t);
  var bh:vec2f;
  if(fp.z>=1.0){bh=cloudBody(sp,d,pos,t,fp.x,drag,coverage,wall);}
  else if(fp.z<=0.0){bh=cloudBody(sp,d,pos,t,fp.y,drag,coverage,wall);}
  else{bh=mix(cloudBody(sp,d,pos,t,fp.y,drag,coverage,wall),cloudBody(sp,d,pos,t,fp.x,drag,coverage,wall),fp.z);}
  let body=bh.x;let hf=bh.y;
  return vec3f(body,storm*(.55+.45*smoothstep(${(M.eyeRadius).toFixed(1)},${(M.wallRadius*2).toFixed(1)},r)),hf);
}
const BASE=${(CLOUD_ALTITUDE-CLOUD_THICKNESS*.5).toFixed(1)};
const SEA=${F.seaLevel.toFixed(1)};
const TOP=${(CLOUD_ALTITUDE+F.top).toFixed(1)};
fn radius(h:f32,y:f32)->f32 {
  let up=mix(${F.baseRadius.toFixed(1)},${F.topRadius.toFixed(1)},pow(h,${F.flare.toFixed(2)}));
  return mix(${F.skirtRadius.toFixed(1)},up,pow(smoothstep(SEA,BASE,y),.5));
}
// Terrain/water bend (space.js bendShader) forward, and its inverse for a render-frame point: the funnel is defined in the flat world, so
// each march sample is un-bent to keep its base on the curved water surface.
fn bendK()->f32 {return clamp(c.bend.x*${PLANET_RADIUS}.0,0.0,1.0);}
fn bendFwd(rel:vec3f)->vec3f {
  let k=bendK();let d=length(rel.xz);
  if(k<=0.0||d<1.0){return rel;}
  let R=${PLANET_RADIUS}.0;let th=min(d/R,3.0);let rr=R+rel.y+c.eye.y;
  let s=mix(d,rr*sin(th),k)/d;
  return vec3f(rel.x*s,mix(rel.y,rr*cos(th)-R-c.eye.y,k),rel.z*s);
}
fn bendInv(rel:vec3f)->vec3f {
  let k=bendK();let dr=length(rel.xz);
  if(k<=0.0||dr<1.0){return rel;}
  let R=${PLANET_RADIUS}.0;let E=R+c.eye.y;
  var d=dr;var y0=rel.y;
  for(var i=0;i<3;i++){
    let th=min(d/R,3.0);let ct=cos(th);
    y0=(rel.y-k*E*(ct-1.0))/(1.0-k+k*ct);
    d=d+dr-mix(d,(E+y0)*sin(th),k);
  }
  return vec3f(rel.xz.x*d/dr,y0,rel.xz.y*d/dr);
}
fn funnelDensity(pos:vec3f,t:f32)->vec2f {
  let h=clamp((pos.y-BASE)/(TOP-BASE),0.0,1.0);
  let d=pos.xz-c.cloud.xy;let r=length(d);
  let rel=r/radius(h,pos.y);
  // North is -z, so the swirl turns counter-clockwise on the map like the maelstrom arms.
  let a=atan2(-d.y,d.x)+${F.twist.toFixed(2)}*h-t*${F.spin.toFixed(2)};
  let n=.6*vnoise(vec2f(cos(a),sin(a))*2.6+vec2f(h*9.0,rel*3.0))+.4*vnoise(vec2f(cos(a*2.0),sin(a*2.0))*4.0+vec2f(h*23.0-t*.3,rel*6.0));
  let shell=smoothstep(1.05,.55,rel)*(.5+.9*n);
  // Sparse near the base: dust thins to baseDensity at sea level, full density by sparseHeight above it.
  let thin=mix(${F.baseDensity.toFixed(3)},1.0,smoothstep(SEA,SEA+${F.sparseHeight.toFixed(1)},pos.y));
  let body=shell*thin*smoothstep(SEA,SEA+250.0,pos.y)*smoothstep(1.0,.82,h);
  return vec2f(body,h);
}
// Sun-lit edges: forward scatter (silver lining, strongest looking toward the sun through thin cloud), fading out as the sun sets.
fn silver(dir:vec3f,thin:f32,sunY:f32)->vec3f {
  let day=smoothstep(-.1,.25,sunY);
  return c.sunCol.rgb*pow(max(dot(dir,c.sun.xyz),0.0),4.0)*(.4+1.4*thin)*day;
}
const NS=${high?28:8};
const NF=14;
@fragment fn fs(v:V)->@location(0) vec4f {
  let t=c.up.w;let night=1.0-c.look.w;
  let dir=normalize(c.look.xyz+c.right.xyz*v.ndc.x*.55*c.right.w+c.up.xyz*v.ndc.y*.55);
  let game=c.tint.w>.5;
  let grade=select(mix(vec3f(1.0),vec3f(.2,.27,.5),night),mix(vec3f(1.0),c.tint.rgb,.6),game);
  let fog=select(mix(vec3f(.08,.15,.20),vec3f(.008,.016,.045),night),c.fog.rgb,game);
  // Linearise the scene depth (same projection as the terrain shader) into distance along this ray.
  let d=textureLoad(sceneDepth,vec2i(v.clip.xy),0);
  var sceneDist=1e9;
  if(d<1.0){sceneDist=c.near.x*c.eye.w/(c.eye.w-d*(c.eye.w-c.near.x))/max(dot(dir,c.look.xyz),.05);}
  // Sheet slab extent.
  var s0=0.0;var s1=0.0;var ns=0;var sEdge=1.0;var capped=false;var sFull=0.0;var live=true;
  let ya=c.cloud.z-THICK*.5-DOWN;let yb=c.cloud.z+THICK*.5+UP;
  let shell=c.bend.x>0.0;
  // Near-horizontal rays are clamped to a minimum slope so the horizon has no gap; a march cut by the span cap fades out instead of ending hard.
  if(shell){
    // Curved layer: inside the outer shell and outside the inner one, first contiguous piece along the ray.
    // Looking level or down, the inner limb uses the nominal base: the downward billows (DOWN) would put a low eye inside the slab and cut the sheet at a hard line below it.
    let O=shellRoots(c.eye.y,dir.y,yb);let I=shellRoots(c.eye.y,dir.y,ya+DOWN*(1.0-smoothstep(0.0,.12,dir.y)));
    s0=max(O.x,0.0);sFull=O.y;live=O.x<=O.y;
    if(I.x<=I.y){if(I.x>s0){sFull=min(sFull,I.x);}else if(I.y>s0){s0=I.y;}}
    live=live&&sFull>s0;
    // A ray that reaches the sea-level sphere ends there: the far-side layer behind the planet is never visible.
    let G=shellRoots(c.eye.y,dir.y,0.0);
    if(c.eye.y>0.0&&G.x>0.0&&G.x<=G.y){sFull=min(sFull,G.x);live=live&&s0<G.x;}
  } else {
    let dy=select(select(-.0005,.0005,dir.y>=0.0),dir.y,abs(dir.y)>=.0005);
    let ta=(ya-c.eye.y)/dy;let tb=(yb-c.eye.y)/dy;
    s0=max(0.0,min(ta,tb));sFull=max(ta,tb);
  }
  let sCap=s0+max(${high?"40000.0":"9000.0"},.3*s0);s1=min(sFull,sCap);
  if(sceneDist<1e8){sEdge=smoothstep(0.0,350.0,sceneDist-s0);s1=min(s1,sceneDist);}
  capped=sFull>sCap&&s1==sCap;let cutK=smoothstep(0.0,.5,(sFull-sCap)/max(sCap-s0,1.0));
  if(live&&s1>s0&&sEdge>0.0&&s0<select(c.cloud.w,1e8,shell)){ns=NS;}
  // Funnel cylinder-and-height extent.
  var f0=0.0;var f1=1e9;var nf=NF;var fEdge=1.0;
  let oc=bendFwd(vec3f(c.cloud.x-c.eye.x,0.0,c.cloud.y-c.eye.z));let o=-oc.xz;let dxz=dir.xz;
  let R=${Math.max(F.topRadius,F.skirtRadius).toFixed(1)}*1.05;
  let qa=dot(dxz,dxz);let qb=dot(o,dxz);let qk=dot(o,o)-R*R;
  if(qa>1e-8){
    let disc=qb*qb-qa*qk;
    if(disc<0.0){nf=0;} else {let sq=sqrt(disc);f0=max(0.0,(-qb-sq)/qa);f1=(-qb+sq)/qa;}
  } else if(qk>0.0){nf=0;}
  if(abs(dir.y)>1e-4){
    let ta=(SEA-120.0+oc.y-c.eye.y)/dir.y;let tb=(TOP+120.0+oc.y-c.eye.y)/dir.y;
    f0=max(f0,min(ta,tb));f1=min(f1,max(ta,tb));
  } else if(c.eye.y<SEA+oc.y-120.0||c.eye.y>TOP+oc.y+120.0){nf=0;}
  if(sceneDist<1e8){fEdge=smoothstep(0.0,300.0,sceneDist-f0);f1=min(f1,sceneDist);}
  if(f1<=f0||fEdge<=0.0){nf=0;}
  if(ns==0&&nf==0){discard;}
  let Ls=s1-s0;let ss=Ls/f32(NS);let fstep=(f1-f0)/f32(NF);
  // Interleaved-gradient jitter alone leaves a visible diagonal hatch on grazing rays; a white-noise term turns it into grain.
  let sJit=fract(52.9829189*fract(dot(v.clip.xy,vec2f(.06711056,.00583715)))+hash(v.clip.xy+vec2f(3.7,9.1)));
  let fJit=.3*hash(v.clip.xy);
  let fDist=length(c.eye.xyz-vec3f(c.cloud.x,(BASE+TOP)*.5,c.cloud.y));
  let fWeight=(1.0-smoothstep(${F.fadeStart.toFixed(1)},${F.fadeEnd.toFixed(1)},fDist))*.95*fEdge*(1.0-smoothstep(.3,.9,c.bend.x*${PLANET_RADIUS}.0));
  var trans=1.0;var light=vec3f(0);
  var i=0;var j=0;
  for(var n=0;n<NS+NF;n++){
    if(i>=ns&&j>=nf){break;}
    let ts=s0+ss*(f32(i)+sJit);let tf=f0+fstep*(f32(j)+fJit);
    if(i<ns&&(j>=nf||ts<=tf)){
      i++;
      let rel=dir*ts;let pos=worldAt(rel);
      let s=sheetDensity(pos,t);
      if(s.x<=.001){continue;}
      let hf=s.z;
      let tail=select(1.0,1.0-cutK*smoothstep(.55,1.0,(ts-s0)/Ls),capped);
      let dd=ts-s0*c.bend.y;
      let w=(1.0-smoothstep(30000.0,c.cloud.w,dd))*.96*sEdge*tail;
      let absorb=(1.0-exp(-s.x*ss*.008))*w;
      ${high?HIGH_TAP:'let shade=1.0;'}
      let lit=mix(.62,1.0,hf)*mix(.75,1.0,s.y)*(.7+.3*trans)*shade;
      let sunY=select(c.sun.w,dot(upAt(rel),c.sun.xyz),shell);
      let day=smoothstep(-.1,.25,sunY);
      let under=select(vec3f(.55,.60,.70),c.cloud2.rgb,game);
      let lite=mix(vec3f(.98,.97,.95),c.sunCol.rgb,.5*(1.0-smoothstep(.2,.9,c.sun.w)));
      let tone=mix(under,lite,lit)*lit*mix(.55,1.0,day)*(1.0+.3*hf*day)+vec3f(.18,.1,.1)*(1.0-s.y)*lit+silver(dir,1.0-smoothstep(0.0,.6,s.x),sunY)*hf;
      light+=trans*absorb*mix(tone*grade,fog,clamp(dd/150000.0,0.0,.93));trans*=1.0-absorb;
    } else {
      j++;
      let pos=c.eye.xyz+bendInv(dir*tf);
      let s=funnelDensity(pos,t);
      if(s.x<=.001){continue;}
      let absorb=(1.0-exp(-s.x*fstep*.004))*fWeight;
      let lit=mix(.32,1.0,pow(s.y,.7))*(.6+.4*trans);
      let tone=mix(vec3f(.5,.52,.6),vec3f(.98,.96,.94),lit)*lit+vec3f(.2,.08,.06)*(1.0-s.y)*lit+silver(dir,.5,c.sun.w)*.5;
      light+=trans*absorb*mix(tone*grade,fog,clamp(fDist/200000.0,0.0,.9));trans*=1.0-absorb;
    }
    if(trans<.01){break;}
  }
  let alpha=1.0-trans;
  if(alpha<.01){discard;}
  return vec4f(min(light/alpha,vec3f(1.0)),alpha);
}`;
export const cloudShader=build(false);
export const cloudShaderHigh=build(true);
export const funnelShader=cloudShader;

// Tileable 64^3 RG8 noise (r: broad puffs, g: fine detail), baked once on the CPU: value noise on a wrapped lattice, 3 octaves.
export const CLOUD_NOISE_SIZE=64;
export function bakeCloudNoise(size=CLOUD_NOISE_SIZE) {
  const hash=(x,y,z,s)=>{let h=Math.imul(x,374761393)^Math.imul(y,668265263)^Math.imul(z,2147483647)^Math.imul(s,1274126177);h=Math.imul(h^h>>>13,1274126177);return((h^h>>>16)>>>0)/4294967296;};
  const smooth=f=>f*f*(3-2*f);
  const lattice=(x,y,z,cells,seed)=>{
    const [fx,fy,fz]=[x*cells,y*cells,z*cells],[ix,iy,iz]=[Math.floor(fx),Math.floor(fy),Math.floor(fz)];
    const [sx,sy,sz]=[smooth(fx-ix),smooth(fy-iy),smooth(fz-iz)],h=(a,b,c)=>hash((ix+a)%cells,(iy+b)%cells,(iz+c)%cells,seed);
    const lerp=(a,b,t)=>a+(b-a)*t;
    return lerp(lerp(lerp(h(0,0,0),h(1,0,0),sx),lerp(h(0,1,0),h(1,1,0),sx),sy),lerp(lerp(h(0,0,1),h(1,0,1),sx),lerp(h(0,1,1),h(1,1,1),sx),sy),sz);
  };
  const out=new Uint8Array(size*size*size*2);
  for(let z=0,o=0;z<size;z++)for(let y=0;y<size;y++)for(let x=0;x<size;x++,o+=2){
    const p=[x/size,y/size,z/size];
    out[o]=Math.round(255*(.55*lattice(...p,4,1)+.3*lattice(...p,8,2)+.15*lattice(...p,16,3)));
    out[o+1]=Math.round(255*(.6*lattice(...p,16,4)+.4*lattice(...p,32,5)));
  }
  return out;
}

/** Cloud quality: 'auto' (unset) is High when it built, unless the guard saw sustained slow frames; an explicit choice always wins. */
export const resolveCloudQuality=(setting,{highFailed=false,slow=false}={})=>setting==='high'?!highFailed:setting==='standard'?false:!highFailed&&!slow;
/** GPU land/ocean mask for the cloud flow; re-baked only when the planet's continent rects change. */
export class CloudMask {
  constructor(device) {
    this.device=device;this.key='';
    this.texture=device.createTexture({size:[MASK.w,MASK.h],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
    this.view=this.texture.createView();
    this.sampler=device.createSampler({magFilter:'linear',minFilter:'linear',addressModeU:'repeat',addressModeV:'clamp-to-edge'});
  }
  update(rects) {
    const key=JSON.stringify(rects);
    if(key===this.key)return;
    this.key=key;
    const m=bakeLandMask(createRegistry(defaultManifest(undefined,rects)));
    this.device.queue.writeTexture({texture:this.texture},m.data,{bytesPerRow:m.w*4},[m.w,m.h]);
  }
}
export class SlowFrameGuard {
  constructor(limitMs=30,windowMs=3000) {Object.assign(this,{limitMs,windowMs,sum:0,n:0,span:0});}
  /** Feed frame deltas (ms); returns true once a full window averaged over the limit. Deltas over 250 ms (tab pauses) are ignored. */
  push(dt) {
    if(!(dt>0)||dt>250)return false;
    this.sum+=dt;this.n++;this.span+=dt;
    if(this.span<this.windowMs)return false;
    const bad=this.sum/this.n>this.limitMs;this.sum=this.n=this.span=0;return bad;
  }
}