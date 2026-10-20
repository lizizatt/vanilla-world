import {table,index} from './music.js';

export const DAY=1440,NIGHT=2880;
const HALF_MINUTES=2880,BANDS=['','ambient','top','mid','band1','band2','horizon','fog','','sun','cloud','cloud2'];
const SKYBOX=/^environments\\stars\\[^:*?"<>|]+\.(mdx|m2)$/i;

const rgb=value=>[(value>>16&255)/255,(value>>8&255)/255,(value&255)/255];
const mixed=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*t);

/** Light.dbc/LightParams.dbc/LightSkybox.dbc/LightIntBand.dbc as 1.12 ships them; every value is runtime-only and in memory. */
export class SkyCatalog {
  constructor({light,params,skybox,bands}) {
    this.lights=table(light,12,48,'Light');this.params=table(params,9,36,'LightParams');
    this.skies=table(skybox,2,8,'LightSkybox');this.bands=table(bands,34,136,'LightIntBand');
    this.paramRows=index(this.params);this.skyRows=index(this.skies);this.bandRows=index(this.bands);
    const f=new DataView(light.buffer,light.byteOffset,light.byteLength);
    this.byMap=new Map();
    for(let row=0;row<this.lights.count;row++) {
      const at=field=>20+row*48+field*4,map=this.lights.u32(row,1);
      const entry={x:f.getFloat32(at(2),true)/36,z:f.getFloat32(at(4),true)/36,start:f.getFloat32(at(5),true)/36,
        end:f.getFloat32(at(6),true)/36,params:this.lights.u32(row,7)};
      if(!this.byMap.has(map))this.byMap.set(map,[]);
      this.byMap.get(map).push(entry);
    }
  }
  band(params,k,time) {
    const row=this.bandRows.get((params-1)*18+1+k);
    if(row===undefined)return undefined;
    const count=Math.min(16,this.bands.u32(row,1));
    if(!count)return undefined;
    const t=((time%HALF_MINUTES)+HALF_MINUTES)%HALF_MINUTES;
    const times=[],colours=[];
    for(let i=0;i<count;i++){times.push(this.bands.u32(row,2+i));colours.push(rgb(this.bands.u32(row,18+i)));}
    if(count===1)return colours[0];
    let next=times.findIndex(v=>v>t);
    if(next<0)next=0;
    const prev=(next+count-1)%count;
    let span=times[next]-times[prev],into=t-times[prev];
    if(span<=0)span+=HALF_MINUTES;
    if(into<0)into+=HALF_MINUTES;
    return mixed(colours[prev],colours[next],Math.min(1,Math.max(0,into/span)));
  }
  /** Blends the lights covering a map position (yards) into one colour set; the map's global light takes the remainder. */
  sample(map,x,z,time) {
    const lights=this.byMap.get(map);
    if(!lights)return undefined;
    const base=lights.find(l=>l.end===0)||lights[0],picks=[];
    let remaining=1;
    for(const l of lights.map(l=>({l,d:Math.hypot(l.x-x,l.z-z)})).filter(e=>e.l.end>0&&e.d<e.l.end).sort((a,b)=>a.d-b.d)) {
      const w=Math.min(1,(l.l.end-l.d)/Math.max(1e-6,l.l.end-l.l.start))*remaining;
      picks.push({params:l.l.params,w});remaining-=w;
    }
    picks.push({params:base.params,w:remaining});
    const out={};
    let lead=picks[0];
    for(const p of picks) {
      if(p.w<=0||!this.paramRows.has(p.params))continue;
      if(p.w>lead.w||!this.paramRows.has(lead.params))lead=p;
      BANDS.forEach((name,k)=>{
        if(!name)return;
        const c=this.band(p.params,k,time);
        if(!c)return;
        out[name]=out[name]?out[name].map((v,i)=>v+c[i]*p.w):c.map(v=>v*p.w);
        out[`${name}W`]=(out[`${name}W`]||0)+p.w;
      });
    }
    for(const name of BANDS)if(name&&out[name]){out[name]=out[name].map(v=>v/out[`${name}W`]);delete out[`${name}W`];}
    out.skybox=this.skyPath(lead.params);
    return out.fog&&out.top?out:undefined;
  }
  skyPath(params) {
    const row=this.paramRows.get(params),sky=row===undefined?0:this.skyRows.get(this.params.u32(row,2));
    if(sky===undefined)return undefined;
    const name=this.skies.str(sky,1);
    return SKYBOX.test(name)?name.replace(/\.mdx$/i,'.m2'):undefined;
  }
}

/** Maps a camera render position to Light.dbc yards using the region's tile origin and placement. */
export function mapPosition(region,x,z) {
  return [x-region.placement[0]+region.tile_origin[0]*1600/3,z-region.placement[1]+region.tile_origin[1]*1600/3];
}

export class SkyService {
  constructor(source,emit,wasm) {this.source=source;this.emit=emit;this.wasm=wasm;this.sent=false;}
  async request(stopped=()=>false) {
    if(this.sent)return;
    this.sent=true;
    try {
      const read=name=>this.source.read(`DBFilesClient\\${name}.dbc`,{background:true,shouldDefer:stopped});
      const [light,params,skybox,bands]=await Promise.all([read('Light'),read('LightParams'),read('LightSkybox'),read('LightIntBand')]);
      if(stopped())return;
      new SkyCatalog({light,params,skybox,bands});
      this.emit({event:'sky',light,params,skybox,bands});
      void this.dome(stopped);
    } catch(error) {
      this.sent=false;
      if(stopped())return;
      if(error.code==='DEFERRED')setTimeout(()=>this.request(stopped),2000);
      else this.emit({event:'sky',error:String(error.message||error)});
    }
  }
}

const DOME='Environments\\Stars\\Stars.m2';
SkyService.prototype.dome=async function(stopped) {
  if(!this.wasm)return;
  try {
    const read=path=>this.source.read(path,{background:true,shouldDefer:stopped});
    const model=this.wasm.SceneModel.m2(await read(DOME),DOME,'[]');
    let asset;
    try {
      const meta=JSON.parse(model.metadata());
      asset={vertices:model.vertices(),indices:model.indices(),batches:meta.batches};
    } finally {model.free();}
    if(asset.indices.length>3000||asset.vertices.byteLength>64*1024||asset.batches.length>16)throw Error('Sky dome exceeds budget');
    const textures=[];
    for(const key of new Set(asset.batches.map(b=>b.texture).filter(Boolean))) {
      const handle=new this.wasm.SceneTexture(await read(key));
      try {textures.push({key,...JSON.parse(handle.metadata()),rgba:handle.rgba()});} finally {handle.free();}
    }
    if(stopped())return;
    this.emit({event:'sky-dome',asset,textures},[asset.vertices.buffer,asset.indices.buffer,...textures.map(t=>t.rgba.buffer)]);
  } catch(error) {
    if(stopped())return;
    if(error.code==='DEFERRED')setTimeout(()=>this.dome(stopped),2000);
    else this.emit({event:'sky-dome',error:String(error.message||error)});
  }
};

/** Stars.m2 dome (M2 space: x north, y west, z up) spun about a tilted celestial axis; alpha follows the night factor. */
export const skyDomeShader=`
struct S {look:vec4f,right:vec4f,up:vec4f,k:vec4f};
@group(0) @binding(0) var<uniform> s:S;
@group(0) @binding(1) var image:texture_2d<f32>;
@group(0) @binding(2) var imageSampler:sampler;
struct V {@builtin(position) clip:vec4f,@location(0) uv:vec2f,@location(1) color:vec4f,@location(2) fade:f32};
@vertex fn vs(@location(0) p:vec3f,@location(1) n:vec3f,@location(2) uv:vec2f,@location(3) color:vec4f)->V {
  let axis=normalize(vec3f(0.0,.64,-.77));
  let c=cos(s.k.x);let sn=sin(s.k.x);
  var d=vec3f(-p.y,p.z,-p.x);
  d=d*c+cross(axis,d)*sn+axis*dot(axis,d)*(1.0-c);
  var v:V;let w=dot(d,s.look.xyz);
  v.clip=vec4f(dot(d,s.right.xyz)/(0.55*s.look.w),dot(d,s.up.xyz)/0.55,w*.9999,w);
  v.uv=uv;v.color=color;v.fade=smoothstep(-.02,.12,d.y/length(d));return v;
}
@fragment fn fs(v:V)->@location(0) vec4f {
  let t=textureSample(image,imageSampler,v.uv)*v.color;
  return vec4f(t.rgb,t.a*s.k.y*v.fade);
}`;

export const nightAngle=time=>time/HALF_MINUTES*Math.PI*2;
export const nightAlpha=time=>Math.min(1,Math.max(0,Math.cos(nightAngle(time))*2));

export const skyShader=`
struct S {look:vec4f,right:vec4f,up:vec4f,c:array<vec4f,5>,k:vec4f};
fn moon(d:vec3f,az:f32,el:f32,radius:f32,phase:f32,tint:vec3f)->vec4f {
  let m=vec3f(cos(el)*sin(az),sin(el),cos(el)*cos(az));
  let r=normalize(cross(vec3f(0,1,0),m));let u=cross(m,r);
  let x=dot(d,r)/radius;let y=dot(d,u)/radius;let d2=x*x+y*y;
  let disc=select(0.0,1.0,d2<1.0&&dot(d,m)>0.0)*mix(.3,1.0,smoothstep(-.4,.4,x+phase));
  let glow=.25*exp(-d2*.35)*select(0.0,1.0,dot(d,m)>0.0);
  return vec4f(tint*(disc+glow*.6),(disc+glow)*smoothstep(0.0,.08,m.y)*s.k.y);
}
@group(0) @binding(0) var<uniform> s:S;
struct V {@builtin(position) clip:vec4f,@location(0) ndc:vec2f};
@vertex fn vs(@builtin(vertex_index) i:u32)->V {
  var p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
  var v:V;v.clip=vec4f(p[i],1,1);v.ndc=p[i];return v;
}
@fragment fn fs(v:V)->@location(0) vec4f {
  let d=normalize(s.look.xyz+s.right.xyz*v.ndc.x*.55*s.look.w+s.up.xyz*v.ndc.y*.55);
  let h=max(d.y,0.0);
  var c=mix(s.c[4].rgb,s.c[3].rgb,smoothstep(0.0,.12,h));
  c=mix(c,s.c[2].rgb,smoothstep(.12,.3,h));
  c=mix(c,s.c[1].rgb,smoothstep(.3,.6,h));
  c=mix(c,s.c[0].rgb,smoothstep(.6,1.0,h));
  let t=s.k.x;let h1=cos(t);
  let a=moon(d,t*.9+1.0,asin(clamp(.15+.8*h1,-.5,.95)),.045,sin(t*.4),vec3f(.86,.91,1.0));
  let b=moon(d,t*.7+3.5,asin(clamp(.2+.7*cos(t+1.3),-.5,.95)),.026,cos(t*.3),vec3f(.45,.92,.78));
  c=mix(c,a.rgb,clamp(a.a,0.0,1.0));c=mix(c,b.rgb,clamp(b.a,0.0,1.0));
  return vec4f(c,1);
}`;

/** Per-frame sky uniform: view axes plus top, mid, band1, band2 and horizon colours. */
export function skyUniform(view,sky,time=DAY) {
  const out=new Float32Array(36);
  out.set(view.look,0);out[3]=view.aspect;out.set(view.right,4);out.set(view.up,8);
  [sky.top,sky.mid,sky.band1,sky.band2,sky.horizon].forEach((c,i)=>out.set(c,12+i*4));
  out[32]=nightAngle(time);out[33]=nightAlpha(time);
  return out;
}

/** Time of day in half-minutes that always advances (noon to midnight to noon) over about two seconds. */
export function advanceTime(time,night,dt) {
  const target=night?0:DAY,gap=(target-time+HALF_MINUTES)%HALF_MINUTES;
  return gap<1?target:(time+Math.min(gap,HALF_MINUTES/4*dt))%HALF_MINUTES;
}
