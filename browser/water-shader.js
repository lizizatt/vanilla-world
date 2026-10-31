import {resizeRgba} from './terrain-stream.js';
import {WHIRLPOOL_DIP} from './cloud-config.js';
import {activeBody,wgslNumber} from './body-shaders.js';

export const WATER_NORMAL_SIZE=128;
export function waterNormalMips() {
  const size=WATER_NORMAL_SIZE,rgba=new Uint8Array(size*size*4);
  const bands=[[4,.7],[8,.35],[16,.175]];
  const hash=(x,y)=>{
    let n=Math.imul(x+17,374761393)^Math.imul(y+53,668265263);
    n=Math.imul(n^(n>>>13),1274126177);
    return ((n^(n>>>16))>>>0)/4294967295;
  };
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    let dx=0,dy=0;
    for(const [frequency,weight] of bands){
      const px=x*frequency/size,py=y*frequency/size,ix=Math.floor(px),iy=Math.floor(py);
      const fx=px-ix,fy=py-iy,sx=fx*fx*(3-2*fx),sy=fy*fy*(3-2*fy);
      const a=hash(ix,iy),b=hash((ix+1)%frequency,iy),
        c=hash(ix,(iy+1)%frequency),d=hash((ix+1)%frequency,(iy+1)%frequency);
      dx+=weight*6*fx*(1-fx)*((b-a)*(1-sy)+(d-c)*sy);
      dy+=weight*6*fy*(1-fy)*((c-a)*(1-sx)+(d-b)*sx);
    }
    const length=Math.hypot(dx,1,dy),i=(y*size+x)*4;
    rgba[i]=Math.round((.5-.5*dx/length)*255);
    rgba[i+1]=Math.round((.5-.5*dy/length)*255);
    rgba[i+2]=Math.round(255/length);rgba[i+3]=255;
  }
  const mips=[rgba];
  for(let n=size;n>1;n/=2)mips.push(resizeRgba(n,n,mips.at(-1),n/2));
  return mips;
}

// Maelstrom whirlpool (visual only): tunables in yards. The centre arrives local to the camera origin in u.sky[1..2].w, enabled by u.sky[3].w.
const WHIRLPOOL={wallBoost:3.0,radius:2600,core:260,tilt:.8,spin:.35,twist:2.4,arms:4,pitch:1.1};
const W=WHIRLPOOL;
export const dayShading=`
// nightOver (set per fragment by terrain/splat via localNight) replaces the clock-wide night so far-away ground follows its own sun.
var<private> nightOver:f32=-1.0;
fn nightK()->f32 {return select(1.0-u.forward.w,nightOver,nightOver>=0.0);}
fn gameSky()->bool {return u.sky[0].w>.5;}
fn grade(c:vec3f)->vec3f {
  return c*mix(vec3f(1.0),vec3f(.2,.27,.5),nightK())*select(vec3f(1.0),mix(vec3f(1.0),u.sky[1].rgb,.6),gameSky());
}
// Valley haze: a layer filling everything below the eye; fog follows the eye->fragment path length inside it, so far valley floors haze while nearby valley contents stay clear.
fn valleyHaze(p:vec3f)->f32 {
  let top=u.eye.y-20.0;let frac=clamp((top-p.y)/max(u.eye.y-p.y,1.0),0.0,1.0);
  return .6*(1.0-exp(-length(p-u.eye.xyz)*frac*smoothstep(0.0,400.0,top-p.y)/5000.0));
}
fn fogTint()->vec3f {return select(mix(vec3f(.08,.15,.20),vec3f(.008,.016,.045),nightK()),u.sky[0].rgb,gameSky());}
`;
/** Per-point night (0 day .. 1 night) on the bent globe from the sun in u.pad[1]; matches the globe shader's terminator. Needs the terrain/splat U layout. */
export const localNightShadingFor=(radius,sunLocal=false)=>{const PLANET_RADIUS=wgslNumber(radius);return `
fn localNight(p:vec3f)->f32 {
  let g=1.0-u.forward.w;let k=select(clamp(u.pad[0].x*${PLANET_RADIUS},0.0,1.0),1.0,${sunLocal}&&dot(u.pad[1].xyz,u.pad[1].xyz)>.5);
  if(k<=0.0){return g;}
  let rel=bend(p-u.eye.xyz,vec3f(u.eye.x,u.eye.y,u.pad[0].z),u.pad[0].x);let n=normalize(rel-vec3f(0.0,-(${PLANET_RADIUS}+u.eye.y),0.0));
  return mix(g,1.0-smoothstep(-.12,${sunLocal?".7":".25"},dot(n,u.pad[1].xyz)),k);
}
// Atmosphere rim the globe shader adds at the limb; added to bent terrain/water too so chunked and globe surfaces agree from orbit.
fn limbGlow(p:vec3f)->vec3f {
  let k=u.pad[0].y*clamp(u.eye.y/3000.0,0.0,1.0);if(k<=0.0){return vec3f(0.0);}
    let rel=bend(p-u.eye.xyz,vec3f(u.eye.x,u.eye.y,u.pad[0].z),u.pad[0].x);let n=normalize(rel-vec3f(0.0,-(${PLANET_RADIUS}+u.eye.y),0.0));
  let lit=clamp(dot(n,u.pad[1].xyz)*1.6+.15,0.0,1.0);
  return vec3f(.25,.5,1.0)*pow(1.0-max(dot(n,-normalize(rel)),0.0),3.0)*(.15+lit)*.8*k;
}`;};
export const localNightShading=localNightShadingFor(activeBody().radius);
const PLANET_RADIUS=wgslNumber(activeBody().radius);
// Phase 1 look (design/ocean.md). Colours and coefficients are the single source for the WGSL below and for tests.
export const WATER_LOOK={
  deep:[.025,.18,.29],shallow:[.09,.43,.39],
  // Beer-Lambert: transmittance exp(-sigma*depth*column) per channel (red dies first); `column` yards at ramp depth 1.
  sigma:[.2,.06,.045],column:60,
  // Slope variance (per component) of the unresolved fine normals; the 128^2 map measures ~.115, far-field keeps about a third.
  farVariance:.04,baseAlpha2:.0004,
  sun:[1.0,.93,.8],scatter:[.05,.45,.38],foam:[.82,.9,.9],
};
/** CPU mirror of the shader's water body colour for a ramp depth 0..1 (0 at the shore, 1 deep). */
export const waterBody=depth=>WATER_LOOK.deep.map((d,i)=>d+(WATER_LOOK.shallow[i]-d)*Math.exp(-WATER_LOOK.sigma[i]*depth*WATER_LOOK.column));
const v3=c=>`vec3f(${c.map(x=>x.toFixed(3)).join(',')})`;
export const waterShading=`
@group(0) @binding(3) var waterNormals:texture_2d<f32>;
@group(0) @binding(4) var waveSampler:sampler;
const DIP_R=${WHIRLPOOL_DIP.radius.toFixed(1)};const DIP_D=${WHIRLPOOL_DIP.depth.toFixed(1)};
// Per-shader hooks (defined next to waterBendK): waterSun() unit direction to the sun, seaState() = (windK 0..1, rain 0..1).
// Plug point for the shared analytic wave function (Gerstner, mirrored in JS and Rust later): replace the body of waveField;
// h = height (yd), slope = d(h)/d(x,z), crest = 0..1 steepness/Jacobian foam driver. Phase 1 is flat, the normal map supplies detail.
struct Wave {h:f32,slope:vec2f,crest:f32};
var<private> waveIn:Wave;
fn waveField(world:vec2f,t:f32,wind:f32)->Wave {return waveIn;}
// Rain: one octave of expanding rings per 2 yd cell; returns a slope.
fn rainRipples(world:vec2f,t:f32)->vec2f {
  let g=world/2.0;let c=floor(g);let f=fract(g)-.5;
  let h=fract(sin(dot(c,vec2f(127.1,311.7)))*43758.5453);
  let d=f-(vec2f(fract(h*7.31),fract(h*3.77))-.5)*.5;let r=length(d);
  let ph=fract(t*.9+h);let radius=ph*.25;let x=(r-radius)/.035;
  return d/max(r,.001)*exp(-x*x)*(1.0-ph)*cos((r-radius)*70.0)*.8;
}
fn waterColor(p:vec3f,ramp:f32,rampWidth:f32,dx:vec2f,dy:vec2f)->vec3f {
  var world=p.xz+vec2f(u.right.w,u.up.w);
  let wd=p.xz-vec2f(u.sky[1].w,u.sky[2].w);let wr=length(wd);let wt=u.settings.y;
  let wk=u.sky[3].w*(1.0-smoothstep(0.0,${W.radius.toFixed(1)},wr))*(1.0-smoothstep(30000.0,90000.0,length(u.eye.xyz-p)));
  if(wk>0.0){
    let ang=-(wk*${W.twist.toFixed(2)}+wt*${W.spin.toFixed(2)}*wk*wk);let ca=cos(ang);let sa=sin(ang);
    world=world-wd+vec2f(wd.x*ca-wd.y*sa,wd.x*sa+wd.y*ca);
  }
  let a=textureSampleGrad(waterNormals,waveSampler,world/64.0+u.settings.y*vec2f(.012,.008),dx/64.0,dy/64.0);
  let b=textureSampleGrad(waterNormals,waveSampler,world.yx/32.0+u.settings.y*vec2f(-.009,.014),dx.yx/32.0,dy.yx/32.0);
  var up=vec3f(0.0,1.0,0.0);var view=normalize(u.eye.xyz-p);
  // On the bent globe the surface normal and view ray follow the sphere; the flat-plane ones banded the far ocean into stripes from orbit.
  let wbk=waterBendK();let bk=smoothstep(0.85,1.0,wbk);
  if(bk>0.0){let rel=bend(p-u.eye.xyz,bendEye(),wbk);up=normalize(mix(up,normalize(rel-vec3f(0.0,-(${PLANET_RADIUS}+u.eye.y),0.0)),bk));view=normalize(mix(view,-normalize(rel),bk));}
  let distance=length(u.eye.xyz-p);
  let detail=1.0-smoothstep(160.0,1500.0,distance);
  let sea=seaState();let windK=sea.x;let rain=sea.y;let sun=waterSun();
  let sunK=smoothstep(-.02,.12,dot(sun,up))*(1.0-nightK())*(1.0-.7*rain);
  // Bowl: the real mesh dip (ocean-mesh.js profile) gives the slope, boosted so the walls read as lit/shaded from afar.
  let dq=max(1.0-(wr/DIP_R)*(wr/DIP_R),0.0);let bowl=dq*dq;let pit=u.sky[3].w*step(wr,DIP_R);
  let wave=waveField(world,wt,windK);
  let fine=(a.rg+b.gr-vec2f(1.0))*.9*mix(.7,1.4,windK)*detail+rainRipples(world,wt)*rain*detail*detail;
  var slope=fine+wave.slope-wd/max(wr,1.0)*${W.tilt.toFixed(2)}*wk-wd*4.0*DIP_D*dq/(DIP_R*DIP_R)*${W.wallBoost.toFixed(1)}*pit;
  let normal=normalize(up+vec3f(slope.x,0.0,slope.y));
  // Slope variance the normal map no longer resolves: the faded fine detail plus Toksvig loss of the filtered mip normal. It widens the lobe and blurs the reflection instead of aliasing into moire.
  let mean=(vec3f(1.0-2.0*a.r,a.b,1.0-2.0*a.g)+vec3f(1.0-2.0*b.g,b.b,1.0-2.0*b.r))*.5;let meanLen=clamp(length(mean),.05,1.0);
  let variance=${WATER_LOOK.farVariance.toFixed(3)}*(1.0-detail*detail)*mix(.6,1.4,windK)+clamp((1.0-meanLen)/meanLen,0.0,1.0)*.5;
  let alpha2=clamp(${WATER_LOOK.baseAlpha2}+2.0*variance+.002*rain,.0001,1.0);
  let reflection=reflect(-view,normal);
  let re=dot(reflection,up)*(1.0-min(.7,sqrt(variance)*3.0));
  var sky=select(mix(vec3f(.16,.29,.38),vec3f(.40,.61,.72),smoothstep(0.0,1.0,re))*mix(vec3f(1.0),vec3f(.06,.09,.2),nightK()),
    mix(u.sky[2].rgb,u.sky[3].rgb,smoothstep(0.0,.6,re)),gameSky());
  let sunColor=${v3(WATER_LOOK.sun)};
  sky+=sunColor*pow(max(dot(reflection,sun),0.0),24.0)*.25*sunK;
  let fresnel=.02+.98*pow(1.0-clamp(dot(normal,view),0.0,1.0),5.0);
  let depth=mix(clamp(ramp,0.0,1.0),1.0,smoothstep(350.0,700.0,distance));
  // Beer-Lambert: bed/shore colour survives only through a short water column; per-channel absorption leaves the deep colour.
  let body=mix(${v3(WATER_LOOK.deep)},${v3(WATER_LOOK.shallow)},exp(-${v3(WATER_LOOK.sigma)}*depth*${WATER_LOOK.column.toFixed(1)}))*(1.0-.25*rain);
  // Depth cues: slanted rays cross more water (deeper, darker body), shallows lift toward a sandy turquoise, and distant water hazes into the sky tint.
  let slant=1.0/max(dot(view,up),.2);let bodyD=mix(body,${v3(WATER_LOOK.deep)}*.8,clamp((slant-1.0)*.12,0.0,.5)*smoothstep(0.0,.5,depth));
  let shoal=1.0-smoothstep(0.0,.22,depth);let bodyS=mix(bodyD,vec3f(.30,.58,.50)*mix(1.0,.3,nightK()),shoal*.4*(1.0-.5*rain));
  var color=mix(bodyS,sky,fresnel);
  color=mix(color,fogTint()*.9,smoothstep(1500.0,9000.0,distance)*.35*(1.0-bowl*pit));
  color*=mix(1.0,.35,nightK());
  color*=1.0-.55*bowl*pit;
  color=mix(color,vec3f(.01,.05,.07)*mix(1.0,.3,nightK()),(1.0-smoothstep(${(W.core*.4).toFixed(1)},${(W.core*1.6).toFixed(1)},wr))*step(.0001,wk));
  // Real sun: GGX lobe on the rough surface (alpha2 from the variance above), Kelemen visibility, capped so grazing glints stay finite.
  let halfVector=normalize(view+sun);let nh=max(dot(normal,halfVector),0.0);let vh=max(dot(view,halfVector),.05);
  let ggx=nh*nh*(alpha2-1.0)+1.0;let lobe=alpha2/(3.14159*ggx*ggx);
  let sunFresnel=.02+.98*pow(1.0-vh,5.0);
  color+=sunColor*min(3.0*lobe*sunFresnel*.25/(vh*vh)*max(dot(normal,sun),0.0),2.0)*sunK;
  // Subsurface glow: light through the wave toward a viewer opposite the sun, strongest on steep faces.
  let crest=clamp(length(slope)*1.5+wave.crest,0.0,1.0);
  color+=${v3(WATER_LOOK.scatter)}*pow(clamp(dot(view,-sun),0.0,1.0),4.0)*crest*sunK*1.2*detail;
  // Crest whitecaps: wave.crest (Jacobian once waves exist) plus steep normal-map faces, broken up by noise, gated by wind.
  let capK=smoothstep(.45,.75,windK)*detail;
  let whitecap=  smoothstep(mix(1.4,.95,windK),mix(1.75,1.3,windK),crest+.35*a.b+.5*wave.crest)*capK;
    color=mix(color,${v3(WATER_LOOK.foam)}*mix(1.0,.35,nightK()),whitecap*.35);
  let lap=.012*sin(u.settings.y*1.4+a.r*2.0);
  let foam=smoothstep(0.0,.015,depth)*(1.0-smoothstep(.035+lap,.09+lap,depth))
    *min(1.0,rampWidth*400.0)*detail;
  // North is -z, so atan2(-z,x) grows counter-clockwise on the map like the maelstrom arms.
  let spiral=smoothstep(.55,.95,.5+.5*cos(${W.arms.toFixed(1)}*(atan2(-wd.y,wd.x)+${W.pitch.toFixed(2)}*log(max(wr,1.0)/200.0)-wt*${W.spin.toFixed(2)})))*(.6+.6*a.b)*smoothstep(${W.core.toFixed(1)},${(W.core*3).toFixed(1)},wr);
  return mix(mix(color,vec3f(.65,.79,.76),foam*.5),vec3f(.8,.9,.9)*mix(1.0,.35,nightK()),clamp(spiral*wk*.8,0.0,.8));
}
`;