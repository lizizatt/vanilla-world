import {maelstromCentre,WHIRLPOOL_DIP} from './clouds.js';

/** Surface drop (yd, >= 0) at squared distance q=(r/R)^2 from the whirlpool centre; mirrors `whirlpool_dip` in voyage.rs. */
// Flat quads are split into cells so the vertex-shader bend curves water onto the globe; one big quad bends as a chord and dips under the globe.
export const OCEAN_CELL=2500;
export const dipDepth=(r,{radius,depth}=WHIRLPOOL_DIP)=>r>=radius?0:depth*(1-(r/radius)**2)**2;

/** Ocean triangles (7 floats per vertex: pos, normal, material 2) local to the ocean origin: a flat quad, or four flat
 * quads around a dense displaced square patch when the whirlpool centre lies inside the ocean. */
export function oceanMesh(manifest,cells=96,land=[]) {
  const [x,z,right,bottom]=manifest.ocean,y=manifest.sea_level,w=right-x,h=bottom-z,out=[];
  const tri=(x0,z0,x1,z1)=>out.push(x0,y,z0,0,1,0,2,x1,y,z0,0,1,0,2,x1,y,z1,0,1,0,2,x0,y,z0,0,1,0,2,x1,y,z1,0,1,0,2,x0,y,z1,0,1,0,2);
  // Land tiles (absolute rects) are cut out of the fill so below-sea-level ground is not flooded; cells touching land split into SUB steps.
  const buckets=new Map(),SUB=5;
  for(const r of land)for(let j=Math.floor((r[1]-z)/OCEAN_CELL);j<=Math.floor((r[3]-z)/OCEAN_CELL);j++)for(let i=Math.floor((r[0]-x)/OCEAN_CELL);i<=Math.floor((r[2]-x)/OCEAN_CELL);i++){
    const k=j*100000+i;(buckets.get(k)||buckets.set(k,[]).get(k)).push(r);
  }
  const cell=(x0,z0,x1,z1)=>{
    let near;
    if(buckets.size)for(let j=Math.floor(z0/OCEAN_CELL);j<=Math.floor(z1/OCEAN_CELL);j++)for(let i=Math.floor(x0/OCEAN_CELL);i<=Math.floor(x1/OCEAN_CELL);i++){
      const b=buckets.get(j*100000+i);if(b)near=near?near.concat(b):b;
    }
    if(!near)return tri(x0,z0,x1,z1);
    for(let j=0;j<SUB;j++)for(let i=0;i<SUB;i++){
      const a=x0+(x1-x0)*i/SUB,b=z0+(z1-z0)*j/SUB,c=x0+(x1-x0)*(i+1)/SUB,d=z0+(z1-z0)*(j+1)/SUB,mx=x+(a+c)/2,mz=z+(b+d)/2;
      if(!near.some(r=>mx>=r[0]&&mx<r[2]&&mz>=r[1]&&mz<r[3]))tri(a,b,c,d);
    }
  };
  const quad=(x0,z0,x1,z1)=>{
    if(!(x1>x0&&z1>z0))return;
    const nx=Math.ceil((x1-x0)/OCEAN_CELL),nz=Math.ceil((z1-z0)/OCEAN_CELL);
    for(let j=0;j<nz;j++)for(let i=0;i<nx;i++)cell(x0+(x1-x0)*i/nx,z0+(z1-z0)*j/nz,x0+(x1-x0)*(i+1)/nx,z0+(z1-z0)*(j+1)/nz);
  };
  // The renderer pads manifest.ocean, which moves the map-derived centre, so it passes the true one in manifest.whirlpool.
  const centre=manifest.whirlpool||(manifest.world_bounds?maelstromCentre(manifest):undefined);
  const R=WHIRLPOOL_DIP.radius;
  if(!centre||centre[0]-R<x||centre[0]+R>right||centre[1]-R<z||centre[1]+R>bottom||!(WHIRLPOOL_DIP.depth>0)) {
    quad(0,0,w,h);return new Float32Array(out);
  }
  const x0=centre[0]-R-x,x1=centre[0]+R-x,z0=centre[1]-R-z,z1=centre[1]+R-z;
  quad(0,0,w,z0);quad(0,z1,w,h);quad(0,z0,x0,z1);quad(x1,z0,w,z1);
  const vertex=(i,j)=>{
    const dx=-R+2*R*i/cells,dz=-R+2*R*j/cells,r=Math.hypot(dx,dz),q=1-(r/R)**2,drop=r>=R?0:WHIRLPOOL_DIP.depth*q*q;
    const slope=r>=R||r<1e-6?0:4*WHIRLPOOL_DIP.depth*q/(R*R),nx=slope*dx,nz=slope*dz,n=Math.hypot(nx,1,nz);
    return [x0+2*R*i/cells,y-drop,z0+2*R*j/cells,-nx/n,1/n,-nz/n,2];
  };
  for(let j=0;j<cells;j++)for(let i=0;i<cells;i++) {
    const a=vertex(i,j),b=vertex(i+1,j),c=vertex(i+1,j+1),d=vertex(i,j+1);
    out.push(...a,...b,...c,...a,...c,...d);
  }
  return new Float32Array(out);
}
