import {coversLand} from './land-rect.js';
import {maelstromCentre,WHIRLPOOL_DIP} from './clouds.js';

/** Surface drop (yd, >= 0) at squared distance q=(r/R)^2 from the whirlpool centre; mirrors `whirlpool_dip` in voyage.rs. */
// Flat quads are split into cells so the vertex-shader bend curves water onto the globe; one big quad bends as a chord and dips under the globe.
export const OCEAN_CELL=1250;
export const dipDepth=(r,{radius,depth}=WHIRLPOOL_DIP)=>r>=radius?0:depth*(1-(r/radius)**2)**2;

const meshCache=new Map();
/** oceanMesh memoised on its inputs (a swap back to a body rebuilds the identical sea fill); keeps the few most recent. */
export function oceanMeshCached(manifest,cells=96,land=[]) {
  const key=JSON.stringify([manifest.ocean,manifest.sea_level,manifest.whirlpool,manifest.world_bounds&&maelstromCentre(manifest),cells,land]);
  let mesh=meshCache.get(key);
  if(!mesh){mesh=oceanMesh(manifest,cells,land);if(meshCache.size>=4)meshCache.delete(meshCache.keys().next().value);meshCache.set(key,mesh);}
  return mesh;
}

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
  const nearOf=(x0,z0,x1,z1)=>{
    let near;
    if(buckets.size)for(let j=Math.floor(z0/OCEAN_CELL);j<=Math.floor(z1/OCEAN_CELL);j++)for(let i=Math.floor(x0/OCEAN_CELL);i<=Math.floor(x1/OCEAN_CELL);i++){
      const b=buckets.get(j*100000+i);if(b)near=near?near.concat(b):b;
    }
    return near;
  };
  // A whole cell beside a split cell gets the split cell's edge vertices (flags: z0, x1, z1, x0 sides) so the bend moves both sides of the shared edge identically and no T-junction crack opens.
  const fan=(x0,z0,x1,z1,flags)=>{
    const ring=[],step=(ax,az,bx,bz,n)=>{ring.push([ax,az]);for(let k=1;k<n;k++)ring.push([ax+(bx-ax)*k/n,az+(bz-az)*k/n]);};
    step(x0,z0,x1,z0,flags[0]);step(x1,z0,x1,z1,flags[1]);step(x1,z1,x0,z1,flags[2]);step(x0,z1,x0,z0,flags[3]);
    const cx=(x0+x1)/2,cz=(z0+z1)/2,v=(p,q)=>out.push(p,y,q,0,1,0,2);
    for(let k=0;k<ring.length;k++){const a=ring[k],b=ring[(k+1)%ring.length];v(cx,cz);v(a[0],a[1]);v(b[0],b[1]);}
  };
  const cell=(x0,z0,x1,z1,flags)=>{
    const near=nearOf(x0,z0,x1,z1);
    if(!near)return flags&&flags.some(n=>n>1)?fan(x0,z0,x1,z1,flags):tri(x0,z0,x1,z1);
    // Rect edges are extra breakpoints so the carve is exact: a midpoint test on the uniform lattice alone carved up to half a sub-cell past a rect, leaving a sea-floor strip.
    const cuts=(a,b,lo,hi)=>{
      const s=Array.from({length:SUB+1},(_,k)=>a+(b-a)*k/SUB);
      for(const r of near)for(const e of [r[lo]-(lo?z:x),r[hi]-(lo?z:x)])if(e>a+1e-6&&e<b-1e-6)s.push(e);
      return s.sort((p,q)=>p-q).filter((v,k,all)=>k===0||v-all[k-1]>1e-6);
    };
    const xs=cuts(x0,x1,0,2),zs=cuts(z0,z1,1,3);
    for(let j=0;j+1<zs.length;j++)for(let i=0;i+1<xs.length;i++){
      const a=xs[i],b=zs[j],c=xs[i+1],d=zs[j+1];
      if(!coversLand(near,x+(a+c)/2,z+(b+d)/2))tri(a,b,c,d);
    }
  };
  // Axes are shared between neighbouring quads (and the dip patch is cut at multiples of its own vertex spacing), so every
  // bent vertex on a shared edge exists on both sides and no T-junction crack opens along it.
  const axis=(a,b,n=Math.ceil((b-a)/OCEAN_CELL))=>Array.from({length:n+1},(_,i)=>a+(b-a)*i/n);
  const join=(...p)=>p.reduce((acc,s)=>acc.length?acc.concat(s.slice(1)):s,[]);
  // patch: {side, lo, hi, step} - cells whose `side` edge lies within [lo,hi] border the dense dip patch and take its vertex spacing.
  const quad=(xs,zs,patch)=>{
    const nx=xs.length-1,nz=zs.length-1;
    if(nx<1||nz<1)return;
    const split=(i,j)=>i>=0&&j>=0&&i<nx&&j<nz?(nearOf(xs[i],zs[j],xs[i+1],zs[j+1])?SUB:1):1;
    const onPatch=(side,i,j)=>{
      if(!patch||patch.side!==side||(side===2&&j!==nz-1)||(side===0&&j!==0)||(side===1&&i!==nx-1)||(side===3&&i!==0))return 1;
      const [a,b]=side%2?[zs[j],zs[j+1]]:[xs[i],xs[i+1]];
      return a>=patch.lo-1e-6&&b<=patch.hi+1e-6?Math.max(1,Math.round((b-a)/patch.step)):1;
    };
    for(let j=0;j<nz;j++)for(let i=0;i<nx;i++){
      const f=buckets.size?[split(i,j-1),split(i+1,j),split(i,j+1),split(i-1,j)]:[1,1,1,1];
      for(let s=0;s<4;s++)f[s]=Math.max(f[s],onPatch(s,i,j));
      cell(xs[i],zs[j],xs[i+1],zs[j+1],f);
    }
  };  // The renderer pads manifest.ocean, which moves the map-derived centre, so it passes the true one in manifest.whirlpool.
  const centre=manifest.whirlpool||(manifest.world_bounds?maelstromCentre(manifest):undefined);
  const R=WHIRLPOOL_DIP.radius;
  if(!centre||centre[0]-R<x||centre[0]+R>right||centre[1]-R<z||centre[1]+R>bottom||!(WHIRLPOOL_DIP.depth>0)) {
    quad(axis(0,w),axis(0,h));return new Float32Array(out);
  }
  const x0=centre[0]-R-x,x1=centre[0]+R-x,z0=centre[1]-R-z,z1=centre[1]+R-z;
  const step=2*R/cells,px=axis(x0,x1,2),pz=axis(z0,z1,2),ax=join(axis(0,x0),px,axis(x1,w));
  quad(ax,axis(0,z0),{side:2,lo:x0,hi:x1,step});quad(ax,axis(z1,h),{side:0,lo:x0,hi:x1,step});
  quad(axis(0,x0),pz,{side:1,lo:z0,hi:z1,step});quad(axis(x1,w),pz,{side:3,lo:z0,hi:z1,step});
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
