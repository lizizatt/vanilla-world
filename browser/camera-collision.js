const TILE=1600/3,CELLS=32,CELL=TILE/CELLS;
const cell=n=>Math.max(0,Math.min(CELLS-1,Math.floor(n/CELL)));
function boxHit(from,direction,bounds,limit=1) {
  let enter=0,exit=limit;
  for(let axis=0;axis<3;axis++) {
    if(Math.abs(direction[axis])<1e-12) {
      if(from[axis]<bounds[axis] || from[axis]>bounds[axis+3])return;
    } else {
      const a=(bounds[axis]-from[axis])/direction[axis],b=(bounds[axis+3]-from[axis])/direction[axis];
      enter=Math.max(enter,Math.min(a,b));exit=Math.min(exit,Math.max(a,b));
      if(enter>exit)return;
    }
  }
  return [enter,exit];
}
function triangleHit(vertices,i,from,direction) {
  const ax=vertices[i+3]-vertices[i],ay=vertices[i+4]-vertices[i+1],az=vertices[i+5]-vertices[i+2];
  const bx=vertices[i+6]-vertices[i],by=vertices[i+7]-vertices[i+1],bz=vertices[i+8]-vertices[i+2];
  const hx=direction[1]*bz-direction[2]*by,hy=direction[2]*bx-direction[0]*bz,hz=direction[0]*by-direction[1]*bx;
  const determinant=ax*hx+ay*hy+az*hz;
  if(Math.abs(determinant)<1e-10)return Infinity;
  const sx=from[0]-vertices[i],sy=from[1]-vertices[i+1],sz=from[2]-vertices[i+2];
  const u=(sx*hx+sy*hy+sz*hz)/determinant;
  if(u<0 || u>1)return Infinity;
  const qx=sy*az-sz*ay,qy=sz*ax-sx*az,qz=sx*ay-sy*ax;
  const v=(direction[0]*qx+direction[1]*qy+direction[2]*qz)/determinant;
  if(v<0 || u+v>1)return Infinity;
  const t=(bx*qx+by*qy+bz*qz)/determinant;
  return t>=0 && t<=1?t:Infinity;
}
function terrainTile(tile) {
  const source=tile.vertices,buckets=Array.from({length:CELLS*CELLS},()=>[]);
  let count=0;
  for(let i=0;i<source.length;i+=21)if(source[i+6]===0)count+=9;
  const positions=new Float32Array(count);
  count=0;
  for(let i=0;i<source.length;i+=21) {
    if(source[i+6]!==0)continue;
    const first=count;
    for(let v=0;v<3;v++)for(let a=0;a<3;a++)positions[count++]=source[i+v*7+a];
    const x0=cell(Math.min(source[i],source[i+7],source[i+14]));
    const x1=cell(Math.max(source[i],source[i+7],source[i+14]));
    const z0=cell(Math.min(source[i+2],source[i+9],source[i+16]));
    const z1=cell(Math.max(source[i+2],source[i+9],source[i+16]));
    for(let z=z0;z<=z1;z++)for(let x=x0;x<=x1;x++)buckets[z*CELLS+x].push(first);
  }
  return {placement:tile.placement,vertices:positions,buckets};
}
export class CameraCollision {
  constructor(){this.reset();}
  reset(){this.tiles=new Map();this.lookup=new Map();this.tree=undefined;this.manifest=undefined;this.pending=[];this.ready=false;}
  configure(manifest) {
    this.manifest=manifest;this.lookup.clear();
    manifest.tiles.forEach((t,i)=>this.lookup.set(`${t.region}:${t.x}:${t.y}`,i));
  }
  event(data) {
    if(data.event==='detail') {
      for(const index of data.removed)this.tiles.delete(index);
      for(const tile of data.tiles)this.tiles.set(tile.index,terrainTile(tile));
    } else if(data.event==='collision') {
      if(!(data.vertices instanceof Float64Array) || !(data.nodes instanceof Float64Array)
        || data.vertices.length%9 || data.nodes.length%10 || data.vertices.length>200000*9
        || data.nodes.length>400000*10)throw new Error('Invalid camera collision tree payload');
      this.tree=data;
    }
  }
  frame(state,region) {
    this.ready=!!this.tree;this.pending=[];this.coverageLimited=false;
    const r=this.manifest?.regions[region];
    if(!r)return;
    const dx=r.placement[0]+(32-r.tile_origin[0])*TILE,dz=r.placement[1]+(32-r.tile_origin[1])*TILE;
    for(const item of state.scene?.unresolvedCollision || []) {
      // shortcut: unknown M2 extents use the streamer's 32-yard guard until authored bounds arrive.
      const [min,max]=item.bounds,pad=item.boundsKnown?0:32;
      if(![min,max].every(b=>Array.isArray(b)&&b.length===3&&b.every(Number.isFinite)))throw new Error('Invalid pending camera collision bounds');
      this.pending.push([-max[1]+dx-pad,min[2]-pad,-max[0]+dz-pad,-min[1]+dx+pad,max[2]+pad,-min[0]+dz+pad]);
    }
  }
  clip(pivot,point,origin) {
    const from=[pivot[0]+origin[0],pivot[1],pivot[2]+origin[1]],direction=point.map((n,i)=>n-pivot[i]);
    let length=Math.hypot(...direction);if(length<1e-9)return point;
    // Filter lag must not extend beyond the 50-yard camera / 84-yard unknown-collider query contract.
    if(length>50){for(let i=0;i<3;i++)direction[i]*=50/length;length=50;this.coverageLimited=true;}
    let limit=1;
    if(this.tree?.nodes.length) {
      const {vertices,nodes}=this.tree,stack=[0];let visits=0;
      while(stack.length) {
        const node=stack.pop(),i=node*10;
        if(!Number.isInteger(node) || i<0 || i>=nodes.length || ++visits>nodes.length/10)throw new Error('Invalid camera BVH topology');
        if(!boxHit(from,direction,nodes.subarray(i,i+6),limit))continue;
        const start=nodes[i+6],end=nodes[i+7],left=nodes[i+8],right=nodes[i+9];
        if(left<0 && right<0) {
          if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<start||end>vertices.length/9)throw new Error('Invalid camera BVH leaf');
          for(let t=start;t<end;t++)limit=Math.min(limit,triangleHit(vertices,t*9,from,direction));
        } else stack.push(left,right);
      }
    }
    for(const tile of this.tiles.values()) {
      const [x,z]=tile.placement,local=[from[0]-x,from[1],from[2]-z];
      const hit=boxHit(local,direction,[0,-Infinity,0,TILE,Infinity,TILE],limit);if(!hit)continue;
      const x0=cell(Math.min(local[0]+direction[0]*hit[0],local[0]+direction[0]*hit[1]));
      const x1=cell(Math.max(local[0]+direction[0]*hit[0],local[0]+direction[0]*hit[1]));
      const z0=cell(Math.min(local[2]+direction[2]*hit[0],local[2]+direction[2]*hit[1]));
      const z1=cell(Math.max(local[2]+direction[2]*hit[0],local[2]+direction[2]*hit[1]));
      for(let cz=z0;cz<=z1;cz++)for(let cx=x0;cx<=x1;cx++)for(const first of tile.buckets[cz*CELLS+cx]) {
        limit=Math.min(limit,triangleHit(tile.vertices,first,local,direction));
      }
    }
    for(const bounds of this.pending) {
      const hit=boxHit(from,direction,bounds,limit);
      if(hit){limit=hit[0];this.ready=false;}
    }
    this.manifest?.regions.forEach((r,region)=>{
      const x0=Math.max(0,Math.floor((Math.min(from[0],from[0]+direction[0]*limit)-r.placement[0])/TILE)+r.tile_origin[0]);
      const x1=Math.min(63,Math.floor((Math.max(from[0],from[0]+direction[0]*limit)-r.placement[0])/TILE)+r.tile_origin[0]);
      const z0=Math.max(0,Math.floor((Math.min(from[2],from[2]+direction[2]*limit)-r.placement[1])/TILE)+r.tile_origin[1]);
      const z1=Math.min(63,Math.floor((Math.max(from[2],from[2]+direction[2]*limit)-r.placement[1])/TILE)+r.tile_origin[1]);
      for(let z=z0;z<=z1;z++)for(let x=x0;x<=x1;x++) {
        const index=this.lookup.get(`${region}:${x}:${z}`);if(index===undefined || this.tiles.has(index))continue;
        const px=r.placement[0]+(x-r.tile_origin[0])*TILE,pz=r.placement[1]+(z-r.tile_origin[1])*TILE;
        const hit=boxHit(from,direction,[px,-Infinity,pz,px+TILE,Infinity,pz+TILE],limit);
        if(hit){limit=hit[0];this.ready=false;}
      }
    });
    const t=limit<1?Math.max(0,limit-.15/length):1;
    return pivot.map((n,i)=>n+direction[i]*t);
  }
}
