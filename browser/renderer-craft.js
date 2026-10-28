import {craftMatrix,cockpitAnchor} from './world-camera.js';
import {splitParts,crumple,craftFrame,appendWreckChunk} from './wreck.js';
import {emitBurst} from './particles.js';
import {domeShellAsset,domePlacement} from './dome-shell.js';

export function destroyCraft(r,craft) {
  if(!craft)return;
  for(const asset of [craft.asset,craft.flame?.asset])if(asset){asset.vertices.destroy();asset.indices.destroy();}
  for(const texture of craft.textures.values())texture.destroy();
}
// Only the Data rocket is released with the world; a shipped/procedural override survives world reloads.
export function releaseCraft(r) {r.destroyCraft(r.dataCraft);r.dataCraft=undefined;r.craft=r.override;}
export function buildCraft(r,data,display,key,maxIndices=60000) {
  if(data.metadata.display!==display||!Number.isFinite(data.metadata.scale)||data.metadata.scale<=0||
    data.asset.indices.length>maxIndices||data.textures.length>64)throw Error('Invalid craft payload');
  const bytes=data.asset.vertices.byteLength+data.asset.indices.byteLength+data.textures.reduce((n,t)=>n+t.rgba.byteLength,0);
  if(bytes>32*1024*1024)throw Error('Craft exceeds GPU budget');
  const build=asset=>({vertices:r.buffer(asset.vertices,GPUBufferUsage.VERTEX),
    indices:r.buffer(asset.indices,GPUBufferUsage.INDEX),batches:r.prepareBatches(asset.batches),count:asset.indices.length});
  const anchor=cockpitAnchor(data.metadata),asset=build(data.asset),lo=[1e9,1e9,1e9],hi=[-1e9,-1e9,-1e9];
  for(let i=0;i<data.asset.vertices.length;i+=12)for(let a=0;a<3;a++){lo[a]=Math.min(lo[a],data.asset.vertices[i+a]);hi[a]=Math.max(hi[a],data.asset.vertices[i+a]);}
  return {asset,textures:new Map(data.textures.map(t=>[t.key,r.texture(t.width,t.height,t.rgba)])),
    metadata:data.metadata,anchor,source:data.asset,items:new Map(),instance:{id:'player-craft',key,craft:true},bytes,size:hi.map((v,a)=>(v-lo[a])*data.metadata.scale),
    flame:data.flame&&data.metadata.exhausts?.length?{asset:build(data.flame),
      parts:data.metadata.exhausts.map((at,i)=>({at,instance:{id:`player-craft-flame:${i}`,key:'flame',craft:true}}))}:undefined};
}
// Debug crash: returns the Rust wreck_start inputs and, once frames arrive, replaces the craft with its pod/engine parts.
export function startWreck(r,state,seed=1,speed=state[5]) {
  const c=r.craft,src=c?.source;
  if(!src)return undefined;
  r.endWreck();
  const scale=c.metadata.scale,m0=craftMatrix(state,[state[11],state[12]],scale),{rot}=craftFrame(m0,scale),split=splitParts(src.vertices,src.indices,src.batches);
  if(split[0].empty)return undefined;
  const vertices=r.buffer(crumple(src.vertices,seed),GPUBufferUsage.VERTEX),parts=[];
  split.forEach((p,i)=>{if(!p.empty)parts.push({...p,asset:{vertices,indices:r.buffer(p.indices,GPUBufferUsage.INDEX),
    batches:r.prepareBatches(p.batches),count:p.indices.length},instance:{id:`player-craft-wreck:${i}`,key:'wreck',craft:true}});});
  r.wreck={parts,vertices,frames:[],connected:[],scale,t0:performance.now()/1000};
  if(r.particles?.quality>0)emitBurst(r.particles,[state[0],state[1]+c.size[2]*.4,state[2]],(c.fx?.length||c.size[0])/3.5);
  return {pos:[state[0],state[1],state[2]],rot:Array.from(rot),scale,vel:[m0[0]/scale*speed,m0[1]/scale*speed,m0[2]/scale*speed],
    parts:parts.flatMap(p=>[...p.center,...p.half]),seed,count:parts.length};
}
export function wreckChunk(r,chunk) {if(r.wreck)appendWreckChunk(r.wreck,chunk,r.wreck.parts.length);}
export function endWreck(r) {
  const w=r.wreck;r.wreck=undefined;
  if(!w)return;
  w.vertices.destroy();for(const p of w.parts)p.asset.indices.destroy();
}
// Preview tooling (race-gate-preview.js): static scenery drawn through the craft path; not used by gameplay.
export function setProps(r,list,slot='props') {
  for(const p of r[slot]||[])r.destroyCraft(p.craft);
  r[slot]=list.map((p,i)=>{
    const craft=r.buildCraft({asset:p.asset,textures:p.textures,metadata:{display:0,scale:p.scale||1,pose:'prop',exhausts:[],
      posedAttachment0:{space:'model-local',pose:'stand-frame-0',position:[0,0,0]}}},0,`prop:${i}`,2000000);
    craft.instance={id:`prop:${slot}:${i}`,key:`prop:${slot}:${i}`,craft:true};
    return {craft,pos:p.pos,yaw:p.yaw||0,scale:p.scale||1,space:p.space||'world'};
  });
}
/** The active body's druidic dome as a prop-path drawable (built once per body, rotated slowly for the shimmer); undefined where the body has no site. */
export function domeDraw(r,bodyId,time) {
  if(r.dome?.bodyId!==bodyId){
    if(r.dome?.craft)r.destroyCraft(r.dome.craft);
    const p=domePlacement(bodyId,0);
    r.dome={bodyId,radius:p?.radius,craft:p&&r.buildCraft({asset:domeShellAsset(p.radius),textures:[],metadata:{display:0,scale:1,pose:'prop',exhausts:[],
      posedAttachment0:{space:'model-local',pose:'stand-frame-0',position:[0,0,0]}}},0,`dome:${bodyId}`,20000)};
    if(r.dome.craft)r.dome.craft.instance={id:'prop:dome',key:`dome:${bodyId}`,craft:true};
  }
  const p=r.dome.craft&&domePlacement(bodyId,time);
  return p&&{craft:r.dome.craft,pos:p.pos,yaw:p.yaw,scale:1};
}
export function setCraftOverride(r,model) {
  const next=model?r.buildCraft(model,0,model.key,120000):undefined;
  r.destroyCraft(r.override);r.override=next;r.craft=next??r.dataCraft;
}
