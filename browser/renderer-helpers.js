import {sceneReady} from './scene-stream.js';

export const sub=(a,b)=>a.map((v,i)=>v-b[i]);
export const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
export const unit=a=>{const n=Math.hypot(...a)||1;return a.map(v=>v/n);};
export function cameraAxes(look,preferredUp=[0,1,0]) {
  let right=cross(look,preferredUp);
  // Clipping onto the chase pivot can leave only the vertical suspension offset.
  if(Math.hypot(...right)<1e-6)right=cross(look,Math.abs(look[2])<.9?[0,0,1]:[1,0,0]);
  right=unit(right);
  return {right,up:unit(cross(right,look))};
}
export function renderMatrix(source,region,origin) {
  const m=new Float32Array(16);
  for(let col=0;col<4;col++){
    m[col*4]=-source[col*4+1];m[col*4+1]=source[col*4+2];m[col*4+2]=-source[col*4];m[col*4+3]=col===3?1:0;
  }
  m[12]=-source[13]+region.placement[0]+(32-region.tile_origin[0])*1600/3-origin[0];
  m[13]=source[14];
  m[14]=-source[12]+region.placement[1]+(32-region.tile_origin[1])*1600/3-origin[1];
  return m;
}
export function sceneSelection(instances,assets,visible=()=>true) {
  const selected=[];
  let triangles=0,draws=0,culled=0;
  for(const instance of instances) {
    const asset=assets.get(instance.key);
    if(!asset)continue;
    if(!visible(instance,asset)){culled++;continue;}
    const cost=asset.batches.reduce((n,b)=>n+b.indexCount/3,0);
    if(selected.length>=1024 || triangles+cost>2000000 || draws+asset.batches.length>4096)continue;
    selected.push(instance);triangles+=cost;draws+=asset.batches.length;
  }
  return {selected,triangles,culled,omitted:instances.length-selected.length-culled};
}
export function terrainEdgeMask(entry,neighbors) {
  return [[-1,0],[1,0],[0,-1],[0,1]].reduce((mask,[dx,dy],edge)=>
    neighbors.some(t=>t.region===entry.region&&t.x===entry.x+dx&&t.y===entry.y+dy)?mask:mask|(1<<edge),0);
}
export function readySceneInstances(near,far,assets,textures) {
  const fallback=new Map(far.map(i=>[i.id,i])),ids=new Set(near.map(i=>i.id));
  return [...near.map(i=>{
    const other=fallback.get(i.id);
    return other&&!sceneReady(i,assets,textures)&&sceneReady(other,assets,textures)?other:i;
  }),...far.filter(i=>!ids.has(i.id))];
}
export class AdmissionFade {
  constructor(){this.entries=new Map();this.active=new Set();}
  update(ids,time) {
    if(ids.length>1024)throw Error('Admission fade exceeds the scene instance budget');
    const active=new Set(ids);
    for(const id of this.active)if(!active.has(id))this.entries.get(id).removed=time;
    for(const id of active)if(!this.active.has(id)){
      const old=this.entries.get(id),entry=old&&time-old.removed<=.25?old:{start:time};
      this.entries.delete(id);this.entries.set(id,entry);
    }
    this.active=active;
    for(const id of this.entries.keys()){
      if(this.entries.size<=2048)break;
      if(!active.has(id))this.entries.delete(id);
    }
  }
  opacity(id,time) {
    const entry=this.entries.get(id);
    if(!entry)return 1;
    const t=Math.min(1,Math.max(0,(time-entry.start)/.35));
    return t*t*(3-2*t);
  }
}
