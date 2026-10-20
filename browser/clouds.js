// Procedural cumulus slab: one camera-following quad whose fragments march a short ray through a layer of
// analytic noise density, with a maelstrom (eye, eye wall, spiral arms) around a vortex centre. No textures or extra passes.
export const CLOUD_ALTITUDE_FACTOR=.8;
// Mt Hyjal summit height in yards, measured from the user's Kalimdor terrain (tile bounds near Hyjal, see README "Clouds").
export const HYJAL_SUMMIT=1971;
export const CLOUD_ALTITUDE=CLOUD_ALTITUDE_FACTOR*HYJAL_SUMMIT;
export const CLOUD_THICKNESS=520;
export const CLOUD_HALF_SIZE=60000;
// Tunables in yards / radians per second. Arms rotate counter-clockwise as seen on the world map (north up).
export const MAELSTROM={eyeRadius:2200,wallRadius:5200,radius:24000,arms:3,pitch:.7,spin:.08,drift:.006};
// World-map registration: the eye sits 43% of the way from Kalimdor's east coast to the Eastern Kingdoms' west coast,
// and at 35% / 40% of the way down each continent's tile rows, averaged because the two continents are offset provisionally.
export const MAELSTROM_MAP={across:.43,kalimdorDown:.35,easternDown:.4};

// Whirlpool dip, the single source of truth for JS and Rust (set_whirlpool in voyage.rs): the ocean surface at distance r
// from the centre sits depth*(1-(r/radius)^2)^2 yd below sea level (zero value and slope at the rim). The funnel ends at the bottom.
export const WHIRLPOOL_DIP={radius:2400,depth:180};

export function maelstromCentre(manifest) {
  const o=manifest.ocean,[kalimdor,east]=manifest.world_bounds.map((b,i)=>{
    const placement=manifest.regions[i].placement[1];
    return placement+(b[1]+(i?MAELSTROM_MAP.easternDown:MAELSTROM_MAP.kalimdorDown)*(b[3]+1-b[1]))*1600/3;
  });
  return [o[0]+MAELSTROM_MAP.across*(o[2]-o[0]),(kalimdor+east)/2];
}

export function cloudUniform(view,time,daylight,manifest,near,game,out=new Float32Array(32)) {
  const [x,z]=maelstromCentre(manifest);
  out.set([...view.eye,200000,...view.right,view.aspect,...view.up,time,...view.look,daylight,x,z,CLOUD_ALTITUDE,CLOUD_HALF_SIZE,near]);
  if(game)out.set([...game.cloud,1,...game.fog,0],24);
  return out;
}

// Funnel: a tapered, rotating column rising far above the sheet at the maelstrom centre (yards). Tunable.
// The column continues below the sheet down to sea level, flaring into a mist skirt (skirtRadius) at the whirlpool.
export const FUNNEL={top:7500,seaLevel:-WHIRLPOOL_DIP.depth,skirtRadius:1700,baseRadius:500,topRadius:3200,flare:1.5,spin:.5,twist:5,fadeStart:90000,fadeEnd:170000};
const COMMON=`
struct C {eye:vec4f,right:vec4f,up:vec4f,look:vec4f,cloud:vec4f,near:vec4f,tint:vec4f,fog:vec4f};
@group(0) @binding(0) var<uniform> c:C;
@group(0) @binding(1) var sceneDepth:texture_depth_2d;
fn hash(p:vec2f)->f32 {return fract(sin(dot(p,vec2f(127.1,311.7)))*43758.5453);}
fn vnoise(p:vec2f)->f32 {
  let i=floor(p);let f=fract(p);let s=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2f(1,0)),s.x),mix(hash(i+vec2f(0,1)),hash(i+vec2f(1,1)),s.x),s.y);
}`;
const M=MAELSTROM;
const F=FUNNEL;
// One fullscreen ray march samples the cumulus sheet and the funnel together, always taking whichever sample is nearer,
// so the two volumes occlude each other in true front-to-back order. Both are clipped to the scene depth.
export const cloudShader=COMMON+`
struct V {@builtin(position) clip:vec4f,@location(0) ndc:vec2f};
@vertex fn vs(@builtin(vertex_index) i:u32)->V {
  var q=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
  var v:V;v.clip=vec4f(q[i],0.5,1);v.ndc=q[i];return v;
}
const THICK=${CLOUD_THICKNESS.toFixed(1)};
fn sheetDensity(pos:vec3f,t:f32)->vec2f {
  let hf=clamp((pos.y-(c.cloud.z-THICK*.5))/THICK,0.0,1.0);
  let d=pos.xz-c.cloud.xy;let r=length(d);
  let turn=t*${M.drift}*exp(-r/${M.radius.toFixed(1)});
  let cs=cos(turn);let sn=sin(turn);
  let w=vec2f(d.x*cs-d.y*sn,d.x*sn+d.y*cs);
  let q=w/2600.0;
  var n=.55*vnoise(q)+.3*vnoise(q*2.3+7.0)+.15*vnoise(q*5.1+3.0);
  n=n*.78+.22*vnoise(w/650.0+vec2f(hf*3.1,hf*1.7));
  // North is -z, so atan2(-z,x) grows counter-clockwise on the map.
  let a=atan2(-d.y,d.x);
  let arm=smoothstep(.2,.8,.5+.5*cos(${M.arms.toFixed(1)}*(a+${M.pitch}*log(max(r,1.0)/1000.0)-t*${M.spin})));
  let storm=exp(-r/${M.radius.toFixed(1)});
  let wall=exp(-pow((r-${M.wallRadius.toFixed(1)})/(${M.wallRadius.toFixed(1)}*.35),2.0));
  let eye=smoothstep(${M.eyeRadius.toFixed(1)},${(M.eyeRadius*1.5).toFixed(1)},r);
  let coverage=clamp(mix(.4,mix(.1,.95,arm),storm)+.6*wall,0.0,.95)*eye;
  let top=(n-(1.0-coverage))*(2.2+1.6*wall);
  let body=smoothstep(0.0,.3,top-hf*.9)*smoothstep(0.0,.1,hf+.05);
  return vec2f(body,storm*(.55+.45*smoothstep(${(M.eyeRadius).toFixed(1)},${(M.wallRadius*2).toFixed(1)},r)));
}
const BASE=${(CLOUD_ALTITUDE-CLOUD_THICKNESS*.5).toFixed(1)};
const SEA=${F.seaLevel.toFixed(1)};
const TOP=${(CLOUD_ALTITUDE+F.top).toFixed(1)};
fn radius(h:f32,y:f32)->f32 {
  let up=mix(${F.baseRadius.toFixed(1)},${F.topRadius.toFixed(1)},pow(h,${F.flare.toFixed(2)}));
  return mix(${F.skirtRadius.toFixed(1)},up,pow(smoothstep(SEA,BASE,y),.5));
}
fn funnelDensity(pos:vec3f,t:f32)->vec2f {
  let h=clamp((pos.y-BASE)/(TOP-BASE),0.0,1.0);
  let d=pos.xz-c.cloud.xy;let r=length(d);
  let rel=r/radius(h,pos.y);
  // North is -z, so the swirl turns counter-clockwise on the map like the maelstrom arms.
  let a=atan2(-d.y,d.x)+${F.twist.toFixed(2)}*h-t*${F.spin.toFixed(2)};
  let n=.6*vnoise(vec2f(cos(a),sin(a))*2.6+vec2f(h*9.0,rel*3.0))+.4*vnoise(vec2f(cos(a*2.0),sin(a*2.0))*4.0+vec2f(h*23.0-t*.3,rel*6.0));
  let shell=smoothstep(1.05,.55,rel)*(.5+.9*n);
  let body=shell*smoothstep(SEA,SEA+250.0,pos.y)*smoothstep(1.0,.82,h);
  return vec2f(body,h);
}
const NS=8;
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
  var s0=0.0;var s1=0.0;var ns=0;var sEdge=1.0;
  let ya=c.cloud.z-THICK*.5;let yb=c.cloud.z+THICK*.5;
  if(abs(dir.y)>.0005){
    let ta=(ya-c.eye.y)/dir.y;let tb=(yb-c.eye.y)/dir.y;
    s0=max(0.0,min(ta,tb));s1=min(max(ta,tb),s0+9000.0);
    if(sceneDist<1e8){sEdge=smoothstep(0.0,350.0,sceneDist-s0);s1=min(s1,sceneDist);}
    if(s1>s0&&sEdge>0.0){ns=NS;}
  }
  // Funnel cylinder-and-height extent.
  var f0=0.0;var f1=1e9;var nf=NF;var fEdge=1.0;
  let o=c.eye.xz-c.cloud.xy;let dxz=dir.xz;
  let R=${Math.max(F.topRadius,F.skirtRadius).toFixed(1)}*1.05;
  let qa=dot(dxz,dxz);let qb=dot(o,dxz);let qk=dot(o,o)-R*R;
  if(qa>1e-8){
    let disc=qb*qb-qa*qk;
    if(disc<0.0){nf=0;} else {let sq=sqrt(disc);f0=max(0.0,(-qb-sq)/qa);f1=(-qb+sq)/qa;}
  } else if(qk>0.0){nf=0;}
  if(abs(dir.y)>1e-4){
    let ta=(SEA-c.eye.y)/dir.y;let tb=(TOP-c.eye.y)/dir.y;
    f0=max(f0,min(ta,tb));f1=min(f1,max(ta,tb));
  } else if(c.eye.y<SEA||c.eye.y>TOP){nf=0;}
  if(sceneDist<1e8){fEdge=smoothstep(0.0,300.0,sceneDist-f0);f1=min(f1,sceneDist);}
  if(f1<=f0||fEdge<=0.0){nf=0;}
  if(ns==0&&nf==0){discard;}
  let ss=(s1-s0)/f32(NS);let fstep=(f1-f0)/f32(NF);
  let sJit=fract(52.9829189*fract(dot(v.clip.xy,vec2f(.06711056,.00583715))));
  let fJit=.3*hash(v.clip.xy);
  let fDist=length(c.eye.xyz-vec3f(c.cloud.x,(BASE+TOP)*.5,c.cloud.y));
  let fWeight=(1.0-smoothstep(${F.fadeStart.toFixed(1)},${F.fadeEnd.toFixed(1)},fDist))*.95*fEdge;
  var trans=1.0;var light=vec3f(0);
  var i=0;var j=0;
  for(var n=0;n<NS+NF;n++){
    if(i>=ns&&j>=nf){break;}
    let ts=s0+ss*(f32(i)+sJit);let tf=f0+fstep*(f32(j)+fJit);
    if(i<ns&&(j>=nf||ts<=tf)){
      i++;
      let pos=c.eye.xyz+dir*ts;
      let s=sheetDensity(pos,t);
      if(s.x<=.001){continue;}
      let hf=clamp((pos.y-ya)/THICK,0.0,1.0);
      let w=(1.0-smoothstep(30000.0,c.cloud.w,ts))*.96*sEdge;
      let absorb=(1.0-exp(-s.x*ss*.008))*w;
      let lit=mix(.62,1.0,hf)*mix(.75,1.0,s.y)*(.7+.3*trans);
      let tone=mix(vec3f(.55,.60,.70),vec3f(.98,.97,.95),lit)*lit+vec3f(.18,.1,.1)*(1.0-s.y)*lit;
      light+=trans*absorb*mix(tone*grade,fog,clamp(ts/150000.0,0.0,.93));trans*=1.0-absorb;
    } else {
      j++;
      let pos=c.eye.xyz+dir*tf;
      let s=funnelDensity(pos,t);
      if(s.x<=.001){continue;}
      let absorb=(1.0-exp(-s.x*fstep*.004))*fWeight;
      let lit=mix(.32,1.0,pow(s.y,.7))*(.6+.4*trans);
      let tone=mix(vec3f(.5,.52,.6),vec3f(.98,.96,.94),lit)*lit+vec3f(.2,.08,.06)*(1.0-s.y)*lit;
      light+=trans*absorb*mix(tone*grade,fog,clamp(fDist/200000.0,0.0,.9));trans*=1.0-absorb;
    }
    if(trans<.01){break;}
  }
  let alpha=1.0-trans;
  if(alpha<.01){discard;}
  return vec4f(light/alpha,alpha);
}`;
export const funnelShader=cloudShader;
