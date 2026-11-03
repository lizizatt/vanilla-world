// Softens the authored liquid depth ramp (vertex slot 3 of material-2 vertices, stride 7) so the shore is a smooth distance field instead of the one-cell staircase.
// Missing lattice neighbours count as depth 0 (open land), which feathers the rim; vertices on the tile border are left alone so tiles stay seamless.
export const LIQUID_CELL=1600/3/128;
const STRIDE=7;

export function smoothLiquidDepth(vertices,passes=2){
  let minX=Infinity,maxX=-Infinity,minZ=Infinity,maxZ=-Infinity,water=false;
  for(let o=0;o<vertices.length;o+=STRIDE){
    if(vertices[o+6]===2){water=true;continue;}
    minX=Math.min(minX,vertices[o]);maxX=Math.max(maxX,vertices[o]);minZ=Math.min(minZ,vertices[o+2]);maxZ=Math.max(maxZ,vertices[o+2]);
  }
  if(!water)return vertices;
  const key=(ix,iz)=>(ix+8192)*16384+(iz+8192);
  const lattice=new Map();
  for(let o=0;o<vertices.length;o+=STRIDE){
    if(vertices[o+6]!==2)continue;
    const ix=Math.round(vertices[o]/LIQUID_CELL),iz=Math.round(vertices[o+2]/LIQUID_CELL);
    const k=key(ix,iz);
    if(!lattice.has(k)){
      const border=vertices[o]-minX<.5||maxX-vertices[o]<.5||vertices[o+2]-minZ<.5||maxZ-vertices[o+2]<.5;
      lattice.set(k,{ix,iz,depth:vertices[o+3],next:vertices[o+3],border});
    }
  }
  for(let pass=0;pass<passes;pass++){
    for(const point of lattice.values()){
      if(point.border){point.next=point.depth;continue;}
      let sum=0;
      for(let dx=-1;dx<=1;dx++)for(let dz=-1;dz<=1;dz++)sum+=lattice.get(key(point.ix+dx,point.iz+dz))?.depth??0;
      point.next=Math.min(point.depth,sum/9);
    }
    for(const point of lattice.values())point.depth=point.next;
  }
  for(let o=0;o<vertices.length;o+=STRIDE){
    if(vertices[o+6]!==2)continue;
    vertices[o+3]=lattice.get(key(Math.round(vertices[o]/LIQUID_CELL),Math.round(vertices[o+2]/LIQUID_CELL))).depth;
  }
  return vertices;
}
