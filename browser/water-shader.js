import {resizeRgba} from './terrain-stream.js';

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

export const waterShading=`
@group(0) @binding(3) var waterNormals:texture_2d<f32>;
@group(0) @binding(4) var waveSampler:sampler;
fn waterColor(p:vec3f,ramp:f32,rampWidth:f32,dx:vec2f,dy:vec2f)->vec3f {
  let world=p.xz+vec2f(u.right.w,u.up.w);
  let a=textureSampleGrad(waterNormals,waveSampler,world/64.0+u.settings.y*vec2f(.012,.008),dx/64.0,dy/64.0);
  let b=textureSampleGrad(waterNormals,waveSampler,world.yx/32.0+u.settings.y*vec2f(-.009,.014),dx.yx/32.0,dy.yx/32.0);
  let view=normalize(u.eye.xyz-p);
  let distance=length(u.eye.xyz-p);
  let detail=1.0-smoothstep(160.0,1500.0,distance);
  let slope=(a.rg+b.gr-vec2f(1.0))*.9*detail;
  let normal=normalize(vec3f(slope.x,1.0,slope.y));
  let reflection=reflect(-view,normal);
  let sky=mix(vec3f(.16,.29,.38),vec3f(.40,.61,.72),smoothstep(0.0,1.0,reflection.y));
  let fresnel=.02+.98*pow(1.0-clamp(dot(normal,view),0.0,1.0),5.0);
  let depth=mix(clamp(ramp,0.0,1.0),1.0,smoothstep(350.0,700.0,distance));
  let body=mix(vec3f(.09,.43,.39),vec3f(.025,.18,.29),1.0-exp(-depth*4.5));
  var color=mix(body,sky,fresnel);
  let halfDirection=view+normalize(vec3f(-.3,1.0,.4));
  let halfVector=halfDirection/max(length(halfDirection),.0001);
  color+=vec3f(.45,.52,.53)*pow(max(dot(normal,halfVector),0.0),40.0)*.4*detail;
  let lap=.012*sin(u.settings.y*1.4+a.r*2.0);
  let foam=smoothstep(0.0,.015,depth)*(1.0-smoothstep(.035+lap,.09+lap,depth))
    *min(1.0,rampWidth*400.0)*detail;
  return mix(color,vec3f(.65,.79,.76),foam*.5);
}
`;
