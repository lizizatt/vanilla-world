// Visual-only kitbash for launch ramps and boost pickups, built from the same optional local-asset kit as the race gates
// (stone/metal textures + TallBrazier M2). Contact surface and physics live in pod-launch.js and are not touched here;
// without the kit the unchanged procedural launchAsset is used (hosted fallback).
import {LAUNCH,launchAsset} from './pod-launch.js';

const CURB=.7,DROP=3,STEPS=24;

function builder() {
  const V=[],I=[];
  return {V,I,quad(p,n,c,w=1,h=1){
    const b=V.length/12;
    p.forEach((q,k)=>V.push(...q,...n,(k===1||k===2?1:0)*w,(k>1?1:0)*h,...c));
    I.push(b,b+1,b+2,b,b+2,b+3);
  }};
}
const batch=(b,tex,first,emissive)=>({firstIndex:first,indexCount:b.I.length-first,texture:tex.key,doubleSided:true,emissive});
const finish=(b,list)=>({vertices:new Float32Array(b.V),indices:new Uint32Array(b.I),batches:list});

const rampPoint=(angle,i)=>{const a=i/STEPS*angle*Math.PI/180;return {x:LAUNCH.radius*Math.sin(a),y:LAUNCH.radius*(1-Math.cos(a)),n:[0,Math.cos(a),Math.sin(a)]};};

/** Textured ramp: the contact curve itself is the stone driving surface; metal curbs and a buried skirt sit outside/below it. */
export function texturedRamp(o,kit) {
  const b=builder(),hw=LAUNCH.width/2,white=[1,1,1,1],dark=[.75,.75,.8,1];
  const t=i=>rampPoint(o.angle,i);
  for(let i=1;i<=STEPS;i++){
    const p=t(i-1),q=t(i),len=Math.hypot(q.x-p.x,q.y-p.y)/3;
    b.quad([[-hw,p.y,-p.x],[hw,p.y,-p.x],[hw,q.y,-q.x],[-hw,q.y,-q.x]],q.n,white,LAUNCH.width/3,len);
  }
  const surface=b.I.length,curb=[];
  for(const s of [-1,1])for(let i=1;i<=STEPS;i++){
    const p=t(i-1),q=t(i),x0=s*hw,x1=s*(hw+CURB),len=Math.hypot(q.x-p.x,q.y-p.y)/3;
    curb.push(()=>{
      b.quad([[x0,p.y,-p.x],[x1,p.y,-p.x],[x1,q.y,-q.x],[x0,q.y,-q.x]],q.n,dark,CURB/3,len);
      b.quad([[x1,p.y,-p.x],[x1,p.y-DROP,-p.x],[x1,q.y-DROP,-q.x],[x1,q.y,-q.x]],[s,0,0],dark,DROP/3,len);
    });
  }
  curb.forEach(f=>f());
  return finish(b,[{...batch(b,kit.tex.stone,0,.15),indexCount:surface},batch(b,kit.tex.metal,surface,.2)]);
}

/** Pickup: the original octahedron, metal-textured and tinted. */
export function texturedPickup(o,kit) {
  const base=launchAsset(o),v=new Float32Array(base.vertices);
  for(let i=0;i<v.length;i+=12){v[i+6]=(i/12)%2;v[i+7]=Math.floor(i/12/2)%2;}
  return {vertices:v,indices:base.indices,batches:[{firstIndex:0,indexCount:base.indices.length,texture:kit.tex.metal.key,doubleSided:true,emissive:.5}]};
}

const kitReady=kit=>!!(kit?.tex?.stone&&kit.tex.metal&&kit.brazier);

/** Prop descriptors for the renderer: kitbashed when the local kit is loaded, otherwise the procedural launchAsset. */
export function launchProps(o,kit) {
  if(!kitReady(kit))return [{asset:launchAsset(o),textures:[],pos:o.pos,yaw:o.yaw,scale:1,space:'world'}];
  const ramp=o.kind==='ramp',tex=[{key:'white',width:1,height:1,rgba:new Uint8Array([255,255,255,255])},kit.tex.stone,kit.tex.metal];
  const props=[{asset:ramp?texturedRamp(o,kit):texturedPickup(o,kit),textures:tex,pos:o.pos,yaw:o.yaw,scale:1,space:'world'}];
  if(ramp){
    const e=rampPoint(o.angle,STEPS),s=Math.sin(o.yaw),c=Math.cos(o.yaw);
    for(const side of [-1,1]){
      const lx=side*(LAUNCH.width/2+CURB*2.2),lz=-e.x;
      props.push({asset:kit.brazier.asset,textures:kit.brazier.textures,space:'world',scale:1.2*(kit.brazier.k||1),yaw:o.yaw,
        pos:[o.pos[0]+lx*c+lz*s,o.pos[1]+e.y,o.pos[2]-lx*s+lz*c]});
    }
  }
  return props;
}
