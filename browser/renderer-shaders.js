import {waterShading,dayShading,localNightShadingFor} from './water-shader.js';
import {shaderSetFor,activeBody} from './body-shaders.js';

/** terrain/splat/scene shaders with a body's radius and bend baked in; Azeroth's set is the byte-identical default below. */
export const surfaceShadersFor=body=>{
const groundBase=body.atmosphereEdge>0?".63,.59,.40":".45,.45,.45";const shade=body.atmosphereEdge>0?"":"let neutral=1.0-smoothstep(.02,.06,max(mapColor.r,max(mapColor.g,mapColor.b))-min(mapColor.r,min(mapColor.g,mapColor.b)));color*=mix(1.0,clamp(mapColor.r*1.9,.55,1.35),neutral*mapColor.a);";const bendShader=shaderSetFor(body).bend,localNightShading=localNightShadingFor(body.radius,body.atmosphereEdge<=0);

const terrainShader=`
struct U {eye:vec4f,right:vec4f,up:vec4f,forward:vec4f,body:vec4f,settings:vec4f,tile:vec4f,pad:array<vec4f,3>,sky:array<vec4f,4>};
@group(0) @binding(0) var<uniform> u:U;
@group(0) @binding(1) var minimap:texture_2d<f32>;
@group(0) @binding(2) var mapSampler:sampler;
${dayShading}${waterShading}fn waterBendK()->f32 {return u.pad[0].x;}fn bendEye()->vec3f {return vec3f(u.eye.x,u.eye.y,u.pad[0].z);}${bendShader}${localNightShading}
struct V {@builtin(position) clip:vec4f,@location(0) p:vec3f,@location(1) n:vec3f,@location(2) @interpolate(flat) material:f32,@location(3) uv:vec2f};
@vertex fn vs(@location(0) p:vec3f,@location(1) n:vec3f,@location(2) material:f32)->V {
  var position=p+u.tile.xyz;var normal=n;
  if(material==1.0) {
    let s=sin(u.body.w);let c=cos(u.body.w);
    let sb=sin(u.settings.z);let cb=cos(u.settings.z);
    let q=vec3f(p.x*cb-p.y*sb,p.x*sb+p.y*cb,p.z);
    position=vec3f(q.x*c+q.z*s,q.y,-q.x*s+q.z*c)+u.body.xyz;
    normal=vec3f(n.x*c+n.z*s,n.y,-n.x*s+n.z*c);
  }
  let relative=bend(position-u.eye.xyz,bendEye(),u.pad[0].x);let z=dot(relative,u.forward.xyz);
  var v:V;v.clip=vec4f(dot(relative,u.right.xyz)/(0.55*u.settings.x),dot(relative,u.up.xyz)/0.55,
    (z-u.settings.w)*u.eye.w/(u.eye.w-u.settings.w),z);
  v.p=position;v.n=normal;v.material=material;v.uv=p.xz/(1600.0/3.0);return v;
}
@fragment fn fs(v:V)->@location(0) vec4f {
  nightOver=localNight(v.p);
  let dx=dpdx(v.p.xz);let dy=dpdy(v.p.xz);let rampWidth=fwidth(v.n.x);
  let light=.35+.65*max(dot(normalize(v.n),normalize(vec3f(-.3,1.0,.4))),0.0);
  var color=vec3f(${groundBase})*light;
  let cell=vec2f(u.tile.w%64.0,floor(u.tile.w/64.0));
  let mapUv=(cell+clamp(v.uv,vec2f(.5/32.0),vec2f(1.0-.5/32.0)))/64.0;
  let mapColor=textureSample(minimap,mapSampler,mapUv);
  if((v.material==0.0 || v.material==3.0) && u.tile.w>=0.0){color=mix(color,mapColor.rgb,mapColor.a);}
  if(v.material==1.0){color=vec3f(.1,.89,.82)*light;}
  color=grade(color);
  if(v.material>=5.0 && v.material<9.0){
    let kind=v.material-5.0;
    color=select(select(select(vec3f(1.0,.72,.1),vec3f(.95),kind==2.0),vec3f(.85,.08,.06),kind==1.0),vec3f(.22,.22,.24),kind==0.0)*select(max(light,.8),1.0,kind==3.0);
  }
  if(v.material==2.0 || v.material==4.0){
    color=waterColor(v.p,select(1.0,v.n.x,v.n.z>.5),rampWidth,dx,dy);
    color=mix(color,select(fogTint(),u.sky[2].rgb,gameSky()),farOceanFade(v.p));
  }
  let fog=max(clamp(length(v.p-u.eye.xyz)/150000.0,0.0,.93),valleyHaze(v.p))*(1.0-u.pad[0].y);
  return vec4f(mix(color,fogTint(),fog)+limbGlow(v.p),1);
}`;
const splatShader=`
struct U {eye:vec4f,right:vec4f,up:vec4f,forward:vec4f,body:vec4f,settings:vec4f,tile:vec4f,pad:array<vec4f,3>,sky:array<vec4f,4>};
@group(0) @binding(0) var<uniform> u:U;
@group(0) @binding(1) var layers:texture_2d_array<f32>;
@group(0) @binding(2) var masks:texture_2d_array<f32>;
@group(0) @binding(3) var layerSampler:sampler;
@group(0) @binding(4) var minimap:texture_2d<f32>;
${dayShading}fn bendEye()->vec3f {return vec3f(u.eye.x,u.eye.y,u.pad[0].z);}${bendShader}${localNightShading}
struct V {@builtin(position) clip:vec4f,@location(0) p:vec3f,@location(1) uv:vec2f,
  @location(2) @interpolate(flat) layers:vec4u,@location(3) @interpolate(flat) chunk:u32,@location(4) light:f32,
  @location(5) tileUv:vec2f};
@vertex fn vs(@location(0) p:vec3f,@location(1) n:vec3f,@location(2) uv:vec2f,
  @location(3) ids:vec4f,@location(4) chunk:f32)->V {
  let position=p+u.tile.xyz;let relative=bend(position-u.eye.xyz,bendEye(),u.pad[0].x);let z=dot(relative,u.forward.xyz);
  var v:V;v.clip=vec4f(dot(relative,u.right.xyz)/(0.55*u.settings.x),dot(relative,u.up.xyz)/0.55,
    (z-u.settings.w)*u.eye.w/(u.eye.w-u.settings.w),z);
  v.p=position;v.uv=uv;v.layers=vec4u(ids);v.chunk=u32(chunk);
  v.tileUv=p.xz/(1600.0/3.0);
  v.light=clamp(.4+.6*max(dot(normalize(n),normalize(vec3f(-.3,1.0,.4))),0.0),0.0,1.0);
  return v;
}
@fragment fn fs(v:V)->@location(0) vec4f {
  nightOver=localNight(v.p);
  let uv=v.uv*8.0;
  let a=textureSample(masks,layerSampler,clamp(v.uv,vec2f(.5/64.0),vec2f(1.0-.5/64.0)),i32(v.chunk));
  var color=textureSample(layers,layerSampler,uv,i32(v.layers.x)).rgb;
  color=mix(color,textureSample(layers,layerSampler,uv,i32(v.layers.y)).rgb,a.r);
  color=mix(color,textureSample(layers,layerSampler,uv,i32(v.layers.z)).rgb,a.g);
  color=mix(color,textureSample(layers,layerSampler,uv,i32(v.layers.w)).rgb,a.b);
  color*=v.light*(1.0-.3*a.a);
  let mapCell=vec2f(u.tile.w%64.0,floor(u.tile.w/64.0));
  let mapColor=textureSample(minimap,layerSampler,
    (mapCell+clamp(v.tileUv,vec2f(.5/32.0),vec2f(1.0-.5/32.0)))/64.0);
  let edges=u32(u.body.w);
  var edgeDistance=1600.0/3.0;
  if((edges&1u)!=0u){edgeDistance=min(edgeDistance,v.tileUv.x*(1600.0/3.0));}
  if((edges&2u)!=0u){edgeDistance=min(edgeDistance,(1.0-v.tileUv.x)*(1600.0/3.0));}
  if((edges&4u)!=0u){edgeDistance=min(edgeDistance,v.tileUv.y*(1600.0/3.0));}
  if((edges&8u)!=0u){edgeDistance=min(edgeDistance,(1.0-v.tileUv.y)*(1600.0/3.0));}
  ${shade}
  color=mix(color,mapColor.rgb,(1.0-smoothstep(0.0,100.0/3.0,edgeDistance))*mapColor.a);
  let base=mix(vec3f(${groundBase})*v.light,mapColor.rgb,mapColor.a);
  color=grade(mix(base,color,u.settings.z));
  let fog=max(clamp(length(v.p-u.eye.xyz)/150000.0,0.0,.93),valleyHaze(v.p))*(1.0-u.pad[0].y);
  return vec4f(mix(color,fogTint(),fog)+limbGlow(v.p),1);
}`;
const sceneShader=`
struct U {eye:vec4f,right:vec4f,up:vec4f,forward:vec4f,settings:vec4f,model:mat4x4f,material:vec4f,sky:array<vec4f,4>,beam:vec4f,bend:vec4f};
@group(0) @binding(0) var<uniform> u:U;
@group(0) @binding(1) var image:texture_2d<f32>;
@group(0) @binding(2) var imageSampler:sampler;
${dayShading}${waterShading}fn waterBendK()->f32 {return u.bend.x;}fn bendEye()->vec3f {return vec3f(u.eye.x,u.eye.y,u.bend.z);}${bendShader}
struct V {@builtin(position) clip:vec4f,@location(0) p:vec3f,@location(1) n:vec3f,@location(2) uv:vec2f,@location(3) color:vec4f};
@vertex fn vs(@location(0) p:vec3f,@location(1) n:vec3f,@location(2) uv:vec2f,@location(3) color:vec4f)->V {
  let position=(u.model*vec4f(p,1)).xyz;let relative=bend(position-u.eye.xyz,bendEye(),u.bend.x);let z=dot(relative,u.forward.xyz);
  var v:V;v.clip=vec4f(dot(relative,u.right.xyz)/(0.55*u.settings.x),dot(relative,u.up.xyz)/0.55,
    (z-u.settings.w)*u.eye.w/(u.eye.w-u.settings.w),z);
  v.p=position;v.n=(u.model*vec4f(n,0)).xyz;v.uv=uv;v.color=color;return v;
}
@fragment fn fs(v:V)->@location(0) vec4f {
  let dx=dpdx(v.p.xz);let dy=dpdy(v.p.xz);let rampWidth=fwidth(v.uv.x);
  var uv=v.uv;var tint=1.0;
  if(u.beam.x>.5){let t=u.settings.y;uv.x+=t*.9;uv.y+=u.beam.z*.2*sin(uv.x*25.0+t*50.0);
    tint=u.beam.y*(.75+.25*sin(t*37.0)*sin(t*23.0+uv.x*3.0));
    if(u.beam.w>.5){tint=max(0.0,sin(t*31.0)*sin(t*17.0)-.85)*6.0;}}
  let texel=textureSample(image,imageSampler,uv)*v.color*vec4f(vec3f(tint),min(1.0,tint));
  if(texel.a<u.material.x){discard;}
  let distance=length(v.p-u.eye.xyz);
  let coverage=u.material.w*select(1.0,1.0-smoothstep(3500.0,6000.0,distance),u.material.z>0.0);
  if(fract(dot(floor(v.clip.xy),vec2f(.754877666,.569840296)))>=coverage){discard;}
  let sidn=u.material.y>=2.0;let sp=u32(max(u.material.y-2.0,0.0));let sidnRgb=vec3f(f32((sp>>8u)&15u),f32((sp>>4u)&15u),f32(sp&15u))/15.0;
  let light=mix(.4+.6*max(dot(normalize(v.n),normalize(vec3f(-.3,1.0,.4))),0.0),1.0,select(u.material.y,0.0,sidn));
  let fog=max(max(clamp(distance/150000.0,0.0,.93),valleyHaze(v.p))*(1.0-u.bend.y),u.material.z*.8*smoothstep(3500.0,6000.0,distance));
  // Unlit/emissive batches (lamp glass, windows, braziers) keep their colour through the sim-clock night instead of taking the night grade.
  let glow=select(u.material.y,0.0,sidn)*nightK();
  var color=mix(grade(texel.rgb*light),texel.rgb*(1.0+.35*glow),glow);
  // SIDN materials (lit window panes) add their authored night colour on top of the night-graded lit sum.
  if(sidn){color+=texel.rgb*sidnRgb*1.3*nightK();}
  if(u.settings.z>.5){color=waterColor(v.p,v.uv.x,rampWidth,dx,dy);}
  return vec4f(mix(color,fogTint(),fog*(1.0-.6*glow)),texel.a);
}`;
return {terrainShader,splatShader,sceneShader};
};
export const {terrainShader,splatShader,sceneShader}=surfaceShadersFor(activeBody());
