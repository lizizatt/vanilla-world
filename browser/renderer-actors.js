import {ACTOR,actorPhase,poseKey} from './actors.js';
import {renderMatrix} from './renderer-helpers.js';
// Animated NPC poses replace the vertex buffer only when it matches the bind mesh; the wrapper stays stable per base asset.
export function posedAsset(r,instance,base) {
  if(!base||instance.distant||!r.poses?.size||!instance.id.includes(':npc:'))return base;
  const ph=actorPhase(instance.id),mv=r.moves?.get(instance.id);
  const entry=(mv&&(mv.vx||mv.vy)&&r.poses.get(poseKey(instance.key,ph+ACTOR.phases)))||r.poses.get(poseKey(instance.key,ph));
  if(!entry||entry.size!==base.vertices.size)return base;
  if(!entry.asset||entry.asset.base!==base)entry.asset={...base,vertices:entry.buffer,base};
  return entry.asset;
}
export function npcMoves(r,data) {
  for(const id of data.removed)r.moves.delete(id);
  for(const [id,x,y,z,yaw,vx,vy] of data.moves)r.moves.set(id,{x,y,z,yaw,vx,vy,t:data.t});
}
// Wandering NPC: authored matrix with the worker's position (extrapolated by velocity) and facing swapped in.
export function moveMatrix(r,instance,mv,region,origin) {
  const b=instance.matrix,dt=Math.min(.5,Math.max(0,Date.now()/1000-mv.t)),d=mv.yaw-Math.atan2(b[1],b[0]);
  const c=Math.cos(d),s=Math.sin(d),m=Array.from(b);
  for(let k=0;k<3;k++){const x=b[k*4],y=b[k*4+1];m[k*4]=c*x-s*y;m[k*4+1]=s*x+c*y;}
  m[12]=mv.x+mv.vx*dt;m[13]=mv.y+mv.vy*dt;m[14]=mv.z;
  return renderMatrix(m,region,origin);
}
export function pose(r,data) {
  for(const id of data.removed){r.poses.get(id)?.buffer.destroy();r.poses.delete(id);}
  for(const p of data.poses){
    const id=poseKey(p.key,p.phase);let entry=r.poses.get(id);
    if(!entry||entry.size!==p.vertices.byteLength){
      const bytes=[...r.poses.values()].reduce((n,e)=>n+(e===entry?0:e.size),0)+p.vertices.byteLength;
      if(bytes>ACTOR.maxBytes)continue;
      entry?.buffer.destroy();
      entry={size:p.vertices.byteLength,buffer:r.device.createBuffer({size:p.vertices.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST})};
      r.poses.set(id,entry);
    }
    r.device.queue.writeBuffer(entry.buffer,0,p.vertices.buffer,p.vertices.byteOffset,p.vertices.byteLength);
  }
}
