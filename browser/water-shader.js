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
  return .6*(1.0-exp(-length(p-u.eye.xyz)*frac/5000.0));
}
fn fogTint()->vec3f {return select(mix(vec3f(.08,.15,.20),vec3f(.008,.016,.045),nightK()),u.sky[0].rgb,gameSky());}
`;
/** Per-point night (0 day .. 1 night) on the bent globe from the sun in u.pad[1]; matches the globe shader's terminator. Needs the terrain/splat U layout. */
export const localNightShadingFor=radius=>{const PLANET_RADIUS=wgslNumber(radius);return `
fn localNight(p:vec3f)->f32 {
  let g=1.0-u.forward.w;let k=clamp(u.pad[0].x*${PLANET_RADIUS},0.0,1.0);
  if(k<=0.0){return g;}
  let rel=bend(p-u.eye.xyz,u.eye.xyz,u.pad[0].x);let n=normalize(rel-vec3f(0.0,-(${PLANET_RADIUS}+u.eye.y),0.0));
  return mix(g,1.0-smoothstep(-.12,.25,dot(n,u.pad[1].xyz)),k);
}
// Atmosphere rim the globe shader adds at the limb; added to bent terrain/water too so chunked and globe surfaces agree from orbit.
fn limbGlow(p:vec3f)->vec3f {
  let k=u.pad[0].y*clamp(u.eye.y/3000.0,0.0,1.0);if(k<=0.0){return vec3f(0.0);}
    let rel=bend(p-u.eye.xyz,u.eye.xyz,u.pad[0].x);let n=normalize(rel-vec3f(0.0,-(${PLANET_RADIUS}+u.eye.y),0.0));
  let lit=clamp(dot(n,u.pad[1].xyz)*1.6+.15,0.0,1.0);
  return vec3f(.25,.5,1.0)*pow(1.0-max(dot(n,-normalize(rel)),0.0),3.0)*(.15+lit)*.8*k;
}`;};
export const localNightShading=localNightShadingFor(activeBody().radius);
const PLANET_RADIUS=wgslNumber(activeBody().radius);
export const waterShading=`
@group(0) @binding(3) var waterNormals:texture_2d<f32>;
@group(0) @binding(4) var waveSampler:sampler;
const DIP_R=${WHIRLPOOL_DIP.radius.toFixed(1)};const DIP_D=${WHIRLPOOL_DIP.depth.toFixed(1)};
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
  if(bk>0.0){let rel=bend(p-u.eye.xyz,u.eye.xyz,wbk);up=normalize(mix(up,normalize(rel-vec3f(0.0,-(${PLANET_RADIUS}+u.eye.y),0.0)),bk));view=normalize(mix(view,-normalize(rel),bk));}
  let distance=length(u.eye.xyz-p);
  let detail=1.0-smoothstep(160.0,1500.0,distance);
  // Bowl: the real mesh dip (ocean-mesh.js profile) gives the slope, boosted so the walls read as lit/shaded from afar.
  let dq=max(1.0-(wr/DIP_R)*(wr/DIP_R),0.0);let bowl=dq*dq;let pit=u.sky[3].w*step(wr,DIP_R);
  var slope=(a.rg+b.gr-vec2f(1.0))*.9*detail-wd/max(wr,1.0)*${W.tilt.toFixed(2)}*wk-wd*4.0*DIP_D*dq/(DIP_R*DIP_R)*${W.wallBoost.toFixed(1)}*pit;
  let normal=normalize(up+vec3f(slope.x,0.0,slope.y));
  let reflection=reflect(-view,normal);
  let sky=select(mix(vec3f(.16,.29,.38),vec3f(.40,.61,.72),smoothstep(0.0,1.0,dot(reflection,up)))*mix(vec3f(1.0),vec3f(.06,.09,.2),nightK()),
    mix(u.sky[2].rgb,u.sky[3].rgb,smoothstep(0.0,.6,dot(reflection,up))),gameSky());
  let fresnel=.02+.98*pow(1.0-clamp(dot(normal,view),0.0,1.0),5.0);
  let depth=mix(clamp(ramp,0.0,1.0),1.0,smoothstep(350.0,700.0,distance));
  let body=mix(vec3f(.09,.43,.39),vec3f(.025,.18,.29),1.0-exp(-depth*4.5));
  var color=mix(body,sky,fresnel);
  color*=mix(1.0,.35,nightK());
  color*=1.0-.55*bowl*pit;
  color=mix(color,vec3f(.01,.05,.07)*mix(1.0,.3,nightK()),(1.0-smoothstep(${(W.core*.4).toFixed(1)},${(W.core*1.6).toFixed(1)},wr))*step(.0001,wk));
  let halfDirection=view+normalize(vec3f(-.3,1.0,.4));
  let halfVector=halfDirection/max(length(halfDirection),.0001);
  color+=vec3f(.45,.52,.53)*pow(max(dot(normal,halfVector),0.0),40.0)*.4*detail*(1.0-.85*nightK());
  let lap=.012*sin(u.settings.y*1.4+a.r*2.0);
  let foam=smoothstep(0.0,.015,depth)*(1.0-smoothstep(.035+lap,.09+lap,depth))
    *min(1.0,rampWidth*400.0)*detail;
  // North is -z, so atan2(-z,x) grows counter-clockwise on the map like the maelstrom arms.
  let spiral=smoothstep(.55,.95,.5+.5*cos(${W.arms.toFixed(1)}*(atan2(-wd.y,wd.x)+${W.pitch.toFixed(2)}*log(max(wr,1.0)/200.0)-wt*${W.spin.toFixed(2)})))*(.6+.6*a.b)*smoothstep(${W.core.toFixed(1)},${(W.core*3).toFixed(1)},wr);
  return mix(mix(color,vec3f(.65,.79,.76),foam*.5),vec3f(.8,.9,.9)*mix(1.0,.35,nightK()),clamp(spiral*wk*.8,0.0,.8));
}
`;
